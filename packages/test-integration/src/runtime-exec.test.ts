/**
 * Integration tests for runtime code execution with TypeScript and Bash.
 *
 * Tests the ability to:
 * - Execute TypeScript code via the executor service
 * - Execute Bash code with session filesystem access
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { ConvexFs as ConvexSessionFs } from "@tokenspace/session-fs";
import { ConvexClient } from "convex/browser";
import { getSharedContext, getSharedHarness, waitForSetup } from "./setup";
import { api, EXECUTOR_TOKEN, getFunctionName, internal, type TestContext, waitForJobCompletion } from "./test-utils";

/**
 * Create a new session for testing.
 */
async function createSession(revisionId: string): Promise<string> {
  const backend = getSharedHarness().getBackend();

  const sessionId = (await backend.runFunction(getFunctionName(internal.sessions.createSession), {
    userId: "test-user",
    revisionId,
  })) as string;

  return sessionId;
}

async function compileTypeScript(revisionId: string, code: string): Promise<string> {
  const backend = getSharedHarness().getBackend();
  const compileResult = (await backend.runFunction(getFunctionName(internal.fs.operations.compileCode), {
    revisionId,
    code,
  })) as { success: boolean; code?: string; error?: string };

  if (!compileResult.success) {
    throw new Error(`Compilation failed:\n${compileResult.error ?? "(unknown error)"}`);
  }

  if (!compileResult.code) {
    throw new Error("Compilation succeeded but no code was returned");
  }

  return compileResult.code;
}

async function runTypeScriptJob(revisionId: string, compiledCode: string, sessionId?: string): Promise<string> {
  const backend = getSharedHarness().getBackend();

  const jobId = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
    code: compiledCode,
    language: "typescript",
    revisionId,
    sessionId,
  })) as string;

  const job = await waitForJobCompletion(backend, jobId);
  expect(job.status).toBe("completed");
  return job.output ?? "";
}

describe("Executor Execution", () => {
  let context: TestContext;
  let client: ConvexClient;

  beforeAll(async () => {
    await waitForSetup();
    context = getSharedContext();

    // Create a real ConvexClient connected to the test backend
    const backend = getSharedHarness().getBackend();
    client = new ConvexClient(backend.backendUrl!);
  });

  describe("TypeScript Execution", () => {
    it("rejects executor-only APIs with an invalid token", async () => {
      const backend = getSharedHarness().getBackend();

      const jobId = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
        code: "console.log('auth test')",
        language: "typescript",
        revisionId: context.revisionId,
      })) as string;

      await expect(
        client.query(api.executor.runnableJobs, {
          executorToken: "invalid-token",
        }),
      ).rejects.toThrow(/Unauthorized/);

      await expect(
        client.mutation(api.executor.claimJob, {
          job: jobId as any,
          workerId: "unauthorized-worker",
          leaseMs: 30_000,
          executorToken: "invalid-token",
        }),
      ).rejects.toThrow(/Unauthorized/);

      const runnable = (await client.query(api.executor.runnableJobs, {
        executorToken: EXECUTOR_TOKEN,
      })) as string[];
      expect(Array.isArray(runnable)).toBe(true);
    });

    it("compiles and executes TypeScript code via executor service", async () => {
      const backend = getSharedHarness().getBackend();

      // Compile the code using fs.operations.compileCode
      const compileResult = (await backend.runFunction(getFunctionName(internal.fs.operations.compileCode), {
        revisionId: context.revisionId,
        code: `
const greeting = "Hello from TypeScript!";
console.log(greeting);

// Test array operations
const numbers: number[] = [1, 2, 3, 4, 5];
const sum = numbers.reduce((acc, n) => acc + n, 0);
console.log("Sum:", sum);

// Test object manipulation
const data = { name: "test", value: 42 };
console.log("Data:", JSON.stringify(data));
`,
      })) as { success: boolean; code?: string; error?: string };

      expect(compileResult.success).toBe(true);
      expect(compileResult.code).toBeDefined();

      // Create a job for the executor service to process
      const jobId = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
        code: compileResult.code!,
        language: "typescript",
        revisionId: context.revisionId,
      })) as string;

      expect(jobId).toBeDefined();

      // Wait for the job to complete
      const job = await waitForJobCompletion(backend, jobId);

      expect(job.status).toBe("completed");
      expect(job.output).toBeDefined();
      expect(job.output).toContain("Hello from TypeScript!");
      expect(job.output).toContain("Sum: 15");
      expect(job.output).toContain('Data: {"name":"test","value":42}');
    });

    it("invokes testConnection function from workspace", async () => {
      const backend = getSharedHarness().getBackend();

      // Compile code that calls the testConnection function from the testing capability
      // Note: Workspace functions are exposed as globals, not imports
      const compileResult = (await backend.runFunction(getFunctionName(internal.fs.operations.compileCode), {
        revisionId: context.revisionId,
        code: `
const result = await testing.testConnection({});
console.log("Result:", result);
`,
      })) as { success: boolean; code?: string; error?: string };

      if (!compileResult.success) {
        console.error("Compilation error:", compileResult.error);
      }
      expect(compileResult.success).toBe(true);
      expect(compileResult.code).toBeDefined();

      // Create a job for the executor service to process
      const jobId = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
        code: compileResult.code!,
        language: "typescript",
        revisionId: context.revisionId,
      })) as string;

      expect(jobId).toBeDefined();

      // Wait for the job to complete
      const job = await waitForJobCompletion(backend, jobId);

      expect(job.status).toBe("completed");
      expect(job.output).toBeDefined();
      expect(job.output).toContain("Result: it works!");
    });

    it("blocks constructor-based sandbox escapes to process", async () => {
      const compiled = await compileTypeScript(
        context.revisionId,
        `
try {
  const processObj = (globalThis as any).process || (globalThis as any).constructor.constructor("return process")();
  console.log("Process ENV:", processObj.env.HONEYPOT);
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.log("ESCAPE_BLOCKED:", message);
}
`,
      );

      const output = await runTypeScriptJob(context.revisionId, compiled);
      expect(output).toContain("ESCAPE_BLOCKED:");
      expect(output).not.toContain("Process ENV:");
    });

    it("blocks function-constructor escapes through builtin bash()", async () => {
      const compiled = await compileTypeScript(
        context.revisionId,
        `
try {
  const p = (bash as any).constructor.constructor("return process")();
  console.log("Escape successful! HONEYPOT:", p.env.HONEYPOT);
} catch (e: any) {
  console.log("Error:", e.message);
}
`,
      );

      const output = await runTypeScriptJob(context.revisionId, compiled);
      expect(output).toContain("Error:");
      expect(output).not.toContain("Escape successful!");
    });

    it("blocks constructor escapes via sleep() promise objects", async () => {
      const compiled = await compileTypeScript(
        context.revisionId,
        `
try {
  const p = (sleep(1) as any).constructor.constructor("return process")();
  console.log("PROMISE_ESCAPE:", p.env.HONEYPOT);
} catch (e: any) {
  console.log("PROMISE_ESCAPE_BLOCKED:", e.message);
}
`,
      );

      const output = await runTypeScriptJob(context.revisionId, compiled);
      expect(output).toContain("PROMISE_ESCAPE_BLOCKED:");
      expect(output).not.toContain("PROMISE_ESCAPE:");
    });

    it("blocks constructor escapes via setTimeout handles", async () => {
      const compiled = await compileTypeScript(
        context.revisionId,
        `
try {
  const handle = (globalThis as any).setTimeout(() => {}, 25);
  const p = (handle as any).constructor.constructor("return process")();
  console.log("TIMEOUT_ESCAPE:", p.env.HONEYPOT);
  (globalThis as any).clearTimeout(handle as any);
} catch (e: any) {
  console.log("TIMEOUT_ESCAPE_BLOCKED:", e.message);
}
`,
      );

      const output = await runTypeScriptJob(context.revisionId, compiled);
      expect(output).toContain("TIMEOUT_ESCAPE_BLOCKED:");
      expect(output).not.toContain("TIMEOUT_ESCAPE:");
    });

    it("blocks constructor escapes via caught runtime errors", async () => {
      const compiled = await compileTypeScript(
        context.revisionId,
        `
try {
  await bash("exit 1");
} catch (e: any) {
  try {
    const p = e.constructor.constructor("return process")();
    console.log("ERROR_OBJECT_ESCAPE:", p.env.HONEYPOT);
  } catch (inner: any) {
    console.log("ERROR_OBJECT_ESCAPE_BLOCKED:", inner.message);
  }
}
`,
      );

      const output = await runTypeScriptJob(context.revisionId, compiled);
      expect(output).toContain("ERROR_OBJECT_ESCAPE_BLOCKED:");
      expect(output).not.toContain("ERROR_OBJECT_ESCAPE:");
    });

    it("blocks bridge-key interception escapes via host promise wrappers", async () => {
      const compiled = await compileTypeScript(
        context.revisionId,
        `
let captured: any = null;
for (let i = 1; i <= 2000; i++) {
  const key = "__tokenspace_bridge_promise_value_" + i;
  try {
    Object.defineProperty(globalThis, key, {
      configurable: true,
      set(value) {
        if (!captured) captured = value;
      },
      get() {
        return undefined;
      },
    });
  } catch {}
}

await sleep(1);

if (!captured) {
  console.log("BRIDGE_CAPTURE_BLOCKED: no bridge values captured");
} else {
  try {
    const p = captured.constructor.constructor("return process")();
    console.log("BRIDGE_ESCAPE:", p.env.HONEYPOT);
  } catch (e: any) {
    console.log("BRIDGE_CAPTURE_BLOCKED:", e.message);
  }
}
`,
      );

      const output = await runTypeScriptJob(context.revisionId, compiled);
      expect(output).toContain("BRIDGE_CAPTURE_BLOCKED:");
      expect(output).not.toContain("BRIDGE_ESCAPE:");
    });

    it("blocks Promise override interception escapes for host promise bridges", async () => {
      const compiled = await compileTypeScript(
        context.revisionId,
        `
let captured: any = null;

try {
  (globalThis as any).Promise = function (executor: any) {
    try {
      const keys = Object.getOwnPropertyNames(globalThis);
      for (const key of keys) {
        if (key.startsWith("__tokenspace_bridge_")) {
          const value = (globalThis as any)[key];
          if (!captured && (typeof value === "object" || typeof value === "function")) {
            captured = value;
          }
        }
      }
    } catch {}

    try {
      executor(() => {}, () => {});
    } catch {}

    return {
      then() {
        return this;
      },
      catch() {
        return this;
      },
      finally() {
        return this;
      },
    };
  };
} catch (e: any) {
  console.log("PROMISE_OVERRIDE_BLOCKED:", e.message);
}

void sleep(1);

if (!captured) {
  console.log("PROMISE_BRIDGE_CAPTURE_BLOCKED: no bridge values captured");
} else {
  try {
    const p = captured.constructor.constructor("return process")();
    console.log("PROMISE_OVERRIDE_ESCAPE:", p.env.HONEYPOT);
  } catch (e: any) {
    console.log("PROMISE_BRIDGE_CAPTURE_BLOCKED:", e.message);
  }
}
`,
      );

      const output = await runTypeScriptJob(context.revisionId, compiled);
      expect(output).toContain("PROMISE_BRIDGE_CAPTURE_BLOCKED:");
      expect(output).not.toContain("PROMISE_OVERRIDE_ESCAPE:");
    });

    it("blocks Error.prepareStackTrace callsite escapes to host functions", async () => {
      const compiled = await compileTypeScript(
        context.revisionId,
        `
try {
  (Error as any).prepareStackTrace = function (_err: any, frames: any[]) {
    try {
      for (let i = 0; i < frames.length; i++) {
        const frame = frames[i];
        const fn = frame?.getFunction?.();
        if (typeof fn !== "function") continue;

        try {
          const p = fn.constructor.constructor("return process")();
          if (p?.env) {
            console.log("STACK_ESCAPE:", p.env.HONEYPOT);
            break;
          }
        } catch {}
      }
    } catch (e: any) {
      console.log("STACK_ESCAPE_BLOCKED:", e.message);
    }
    return "x";
  };
} catch (e: any) {
  console.log("STACK_ESCAPE_BLOCKED:", e.message);
}

try {
  (function boom() {
    throw new Error("boom");
  })();
} catch (e: any) {
  void e.stack;
  if (typeof (Error as any).prepareStackTrace !== "function") {
    console.log("STACK_ESCAPE_BLOCKED: prepareStackTrace hook unavailable");
  }
}
`,
      );

      const output = await runTypeScriptJob(context.revisionId, compiled);
      expect(output).toContain("STACK_ESCAPE_BLOCKED:");
      expect(output).not.toContain("STACK_ESCAPE:");
    });

    it("exercises built-in fs/session/sleep/debug/error APIs", async () => {
      const sessionId = await createSession(context.revisionId);

      const compiled = await compileTypeScript(
        context.revisionId,
        `
console.log("DEBUG_ENABLED:", DEBUG_ENABLED);
debug("this debug line should not appear by default");

await sleep(1);
console.log("slept");

await fs.write("/sandbox/builtin-fs.txt", "hello from builtin fs");
const text = await fs.readText("/sandbox/builtin-fs.txt");
console.log("fs.readText:", text);

const st = await fs.stat("/sandbox/builtin-fs.txt");
console.log("fs.stat:", JSON.stringify(st));

const root = await fs.list("/sandbox");
console.log("fs.list root has builtins.d.ts:", root.includes("builtins.d.ts"));

await session.setSessionVariable("my-var", { ok: true, n: 1 });
const v = await session.getSessionVariable("my-var");
console.log("session var:", JSON.stringify(v));

await session.writeArtifact("artifact.txt", "artifact body");
const artifacts = await session.listArtifacts();
console.log("artifacts:", artifacts.sort().join(","));
console.log("artifact text:", await session.readArtifactText("artifact.txt"));

const err = new ApprovalRequiredError({ action: "test:approval" });
console.log("isApprovalRequest:", isApprovalRequest(err));

await fs.delete("/sandbox/builtin-fs.txt");
try {
  await fs.readText("/sandbox/builtin-fs.txt");
  console.log("delete failed");
} catch {
  console.log("deleted ok");
}
`,
      );

      const output = await runTypeScriptJob(context.revisionId, compiled, sessionId);
      expect(output).toContain("DEBUG_ENABLED: false");
      expect(output).toContain("slept");
      expect(output).toContain("fs.readText: hello from builtin fs");
      expect(output).toContain("fs.list root has builtins.d.ts: true");
      expect(output).toContain('session var: {"ok":true,"n":1}');
      expect(output).toContain("artifacts: artifact.txt");
      expect(output).toContain("artifact text: artifact body");
      expect(output).toContain("isApprovalRequest: true");
      expect(output).toContain("deleted ok");

      // Debug output should not be present when DEBUG_ENABLED is false.
      expect(output).not.toContain("this debug line should not appear by default");
    });

    it("executes bash from TypeScript via builtin bash()", async () => {
      const sessionId = await createSession(context.revisionId);

      const compiled = await compileTypeScript(
        context.revisionId,
        `
const out = await bash(\`
echo "Hello from bash via TypeScript!" > /sandbox/from-bash.txt
cat /sandbox/from-bash.txt
\`);
console.log("bash out:", out.trim());
console.log("fs read:", await fs.readText("/sandbox/from-bash.txt"));
`,
      );

      const output = await runTypeScriptJob(context.revisionId, compiled, sessionId);
      expect(output).toContain("bash out: Hello from bash via TypeScript!");
      expect(output).toContain("fs read: Hello from bash via TypeScript!");
    });

    it("persists session variables and artifacts across TS jobs with the same session", async () => {
      const sessionId = await createSession(context.revisionId);

      const compiled1 = await compileTypeScript(
        context.revisionId,
        `
await session.setSessionVariable("counter", 1);
await session.writeArtifact("persist.txt", "persisted");
await fs.write("/sandbox/persisted-file.txt", "persisted file contents");
console.log("wrote");
`,
      );
      const out1 = await runTypeScriptJob(context.revisionId, compiled1, sessionId);
      expect(out1).toContain("wrote");

      const compiled2 = await compileTypeScript(
        context.revisionId,
        `
const counter = await session.getSessionVariable("counter");
console.log("counter:", counter);
console.log("persist.txt:", await session.readArtifactText("persist.txt"));
console.log("file:", await fs.readText("/sandbox/persisted-file.txt"));
`,
      );
      const out2 = await runTypeScriptJob(context.revisionId, compiled2, sessionId);
      expect(out2).toContain("counter: 1");
      expect(out2).toContain("persist.txt: persisted");
      expect(out2).toContain("file: persisted file contents");
    });

    it("stops a running job when stop is requested", async () => {
      const backend = getSharedHarness().getBackend();

      const compiled = await compileTypeScript(
        context.revisionId,
        `
console.log("starting");
await sleep(10_000);
console.log("done");
`,
      );

      const jobId = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
        code: compiled,
        language: "typescript",
        revisionId: context.revisionId,
      })) as string;

      const startTime = Date.now();
      while (Date.now() - startTime < 10_000) {
        const job = (await backend.runFunction(getFunctionName(api.executor.getJob), {
          jobId,
          executorToken: EXECUTOR_TOKEN,
        })) as {
          status: string;
        } | null;
        if (!job) throw new Error("Job not found");
        if (job.status === "running") break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }

      await backend.runFunction(getFunctionName(api.executor.requestStopJob), {
        jobId,
        reason: "test stop",
        executorToken: EXECUTOR_TOKEN,
      });

      const job = await waitForJobCompletion(backend, jobId, 30_000);
      expect(job.status).toBe("canceled");
      expect(job.error?.message).toContain("test stop");
    });
  });

  describe("Bash Execution", () => {
    it("executes bash code with session filesystem", async () => {
      const backend = getSharedHarness().getBackend();

      // Create a session for filesystem access
      const sessionId = await createSession(context.revisionId);

      // Create a bash job that writes and reads files
      const jobId = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
        code: `
# Write a file to the sandbox
echo "Hello from Bash!" > /sandbox/greeting.txt

# Read the file back
cat /sandbox/greeting.txt

# Create a nested directory and file
mkdir -p /sandbox/data/logs
echo "Log entry 1" > /sandbox/data/logs/app.log
echo "Log entry 2" >> /sandbox/data/logs/app.log

# Read the log file
echo "--- Log contents ---"
cat /sandbox/data/logs/app.log

# List directory contents
echo "--- Directory listing ---"
ls -la /sandbox/data/logs/
`,
        language: "bash",
        revisionId: context.revisionId,
        sessionId,
      })) as string;

      expect(jobId).toBeDefined();

      // Wait for the job to complete
      const job = await waitForJobCompletion(backend, jobId);

      expect(job.status).toBe("completed");
      expect(job.output).toBeDefined();
      expect(job.output).toContain("Hello from Bash!");
      expect(job.output).toContain("Log entry 1");
      expect(job.output).toContain("Log entry 2");
      expect(job.output).toContain("app.log");
    });

    it("persists files written in bash to the session overlay", async () => {
      const backend = getSharedHarness().getBackend();

      // Create a session for filesystem access
      const sessionId = await createSession(context.revisionId);

      // Execute bash to write a file
      const jobId = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
        code: `
echo "Persistent content from bash" > /sandbox/persistent.txt
echo "File written successfully"
`,
        language: "bash",
        revisionId: context.revisionId,
        sessionId,
      })) as string;

      const job = await waitForJobCompletion(backend, jobId);
      expect(job.status).toBe("completed");

      // Verify the file exists in the session overlay using ConvexSessionFs
      const fs = new ConvexSessionFs({
        client,
        sessionId,
        allowWrites: false,
      });

      const exists = await fs.exists("/persistent.txt");
      expect(exists).toBe(true);

      const content = await fs.readFile("/persistent.txt");
      expect(content).toContain("Persistent content from bash");
    });

    it("runs workspace-defined bash commands (deps + approvals)", async () => {
      const backend = getSharedHarness().getBackend();
      const sessionId = await createSession(context.revisionId);

      // 1) Command works and can import workspace deps (zod) from package.json.
      const jobId1 = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
        code: `echo '{"ok": true, "n": 1}' | validate_json`,
        language: "bash",
        revisionId: context.revisionId,
        sessionId,
      })) as string;

      const job1 = await waitForJobCompletion(backend, jobId1);
      expect(job1.status).toBe("completed");
      expect(job1.output ?? "").toContain("valid ok=true n=1");

      // 2) Command can trigger the same approval mechanism as TypeScript execution.
      const jobId2 = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
        code: `echo '{"ok": true}' | validate_json --require-approval`,
        language: "bash",
        revisionId: context.revisionId,
        sessionId,
      })) as string;

      const job2 = await waitForJobCompletion(backend, jobId2);
      expect(job2.status).toBe("failed");
      expect(job2.error?.data?.errorType).toBe("APPROVAL_REQUIRED");
      expect((job2.error?.data as any)?.approval?.action).toBe("testing:validate_json");

      // 3) With the appropriate approval attached to the job, it succeeds.
      const jobId3 = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
        code: `echo '{"ok": true}' | validate_json --require-approval`,
        language: "bash",
        revisionId: context.revisionId,
        sessionId,
        approvals: [{ action: "testing:validate_json" }],
      })) as string;

      const job3 = await waitForJobCompletion(backend, jobId3);
      expect(job3.status).toBe("completed");
      expect(job3.output ?? "").toContain("valid ok=true");
    });

    it("shares filesystem between bash and typescript jobs in same session", async () => {
      const backend = getSharedHarness().getBackend();
      const sessionId = await createSession(context.revisionId);

      // First: Run bash to write a file
      const bashJobId = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
        code: `
mkdir -p /sandbox/something
echo "hi" > /sandbox/something/foo.txt
`,
        language: "bash",
        revisionId: context.revisionId,
        sessionId,
      })) as string;

      const bashJob = await waitForJobCompletion(backend, bashJobId);
      expect(bashJob.status).toBe("completed");

      // Second: Run TypeScript to read the file at the same path
      const compiled = await compileTypeScript(
        context.revisionId,
        `
const text = await fs.readText('/sandbox/something/foo.txt');
console.log(text.trim());
`,
      );
      const output = await runTypeScriptJob(context.revisionId, compiled, sessionId);
      expect(output).toContain("hi");
    });
  });
});
