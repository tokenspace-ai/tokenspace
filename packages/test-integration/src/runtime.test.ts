/**
 * Integration tests for runtime code execution.
 *
 * Tests the ability to:
 * - Compile and execute simple code via executor service
 * - Handle code with type annotations correctly
 * - Report compilation errors for invalid TypeScript
 * - Report runtime errors for invalid code execution
 */

import { beforeAll, describe, expect, it } from "bun:test";
import { getSharedContext, getSharedHarness, waitForSetup } from "./setup";
import { getFunctionName, internal, type TestContext, waitForJobCompletion } from "./test-utils";

describe("Runtime Execution", () => {
  let context: TestContext;

  beforeAll(async () => {
    await waitForSetup();
    context = getSharedContext();
  });

  it("compiles and executes simple code via executor service", async () => {
    const backend = getSharedHarness().getBackend();

    // Compile the code using fs.operations.compileCode
    const compileResult = (await backend.runFunction(getFunctionName(internal.fs.operations.compileCode), {
      revisionId: context.revisionId,
      code: `
const message = "Hello from integration test!";
console.log(message);

// Test basic operations
const numbers = [1, 2, 3];
const sum = numbers.reduce((a, b) => a + b, 0);
console.log("Sum:", sum);

// Test session id is available
console.log("Session ID:", session.id);
`,
    })) as { success: boolean; code?: string; error?: string };

    expect(compileResult.success).toBe(true);
    expect(compileResult.code).toBeDefined();

    // Create a job for the executor service to process
    const jobId = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
      code: compileResult.code!,
      revisionId: context.revisionId,
    })) as string;

    expect(jobId).toBeDefined();

    // Wait for the job to complete
    const job = await waitForJobCompletion(backend, jobId);

    expect(job.status).toBe("completed");
    expect(job.output).toBeDefined();
    expect(job.output).toContain("Hello from integration test!");
    expect(job.output).toContain("Sum: 6");
    expect(job.output).toContain("Session ID:");
  });

  it("handles code with type annotations correctly", async () => {
    const backend = getSharedHarness().getBackend();

    // Test that TypeScript code with type annotations compiles and runs
    const compileResult = (await backend.runFunction(getFunctionName(internal.fs.operations.compileCode), {
      revisionId: context.revisionId,
      code: `
const numbers: number[] = [1, 2, 3, 4, 5];
const doubled: number[] = numbers.map(n => n * 2);
const sum: number = doubled.reduce((a, b) => a + b, 0);
console.log("Sum of doubled:", sum);

const record: Record<string, number> = {};
record["a"] = 1;
record["b"] = 2;
console.log("Record:", JSON.stringify(record));
`,
    })) as { success: boolean; code?: string; error?: string };

    expect(compileResult.success).toBe(true);

    // Create a job for the executor service to process
    const jobId = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
      code: compileResult.code!,
      revisionId: context.revisionId,
    })) as string;

    // Wait for the job to complete
    const job = await waitForJobCompletion(backend, jobId);

    expect(job.status).toBe("completed");
    expect(job.output).toContain("Sum of doubled: 30");
    expect(job.output).toContain('Record: {"a":1,"b":2}');
  });

  it("reports compilation errors for invalid TypeScript", async () => {
    const backend = getSharedHarness().getBackend();

    // Test that invalid TypeScript produces a compilation error
    const compileResult = (await backend.runFunction(getFunctionName(internal.fs.operations.compileCode), {
      revisionId: context.revisionId,
      code: `
// This should fail - type error
const x: string = 123;
console.log(x);
`,
    })) as { success: boolean; code?: string; error?: string };

    expect(compileResult.success).toBe(false);
    expect(compileResult.error).toBeDefined();
    expect(compileResult.error).toContain("Type");
  });

  it("reports runtime errors for invalid code execution", async () => {
    const backend = getSharedHarness().getBackend();

    // Compile valid TypeScript that will fail at runtime
    const compileResult = (await backend.runFunction(getFunctionName(internal.fs.operations.compileCode), {
      revisionId: context.revisionId,
      code: `
// This compiles but fails at runtime - undefined variable
const obj: any = undefined;
console.log(obj.property);
`,
    })) as { success: boolean; code?: string; error?: string };

    expect(compileResult.success).toBe(true);

    // Create a job for the executor service to process
    const jobId = (await backend.runFunction(getFunctionName(internal.executor.createJob), {
      code: compileResult.code!,
      revisionId: context.revisionId,
    })) as string;

    // Wait for the job to complete (it should fail)
    const job = await waitForJobCompletion(backend, jobId);

    expect(job.status).toBe("failed");
    expect(job.error).toBeDefined();
    expect(job.error?.message).toContain("property");
  });
});
