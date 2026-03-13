import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import vm from "node:vm";
import type {
  ApprovalRequirement,
  CredentialStore,
  JSONValue,
  SerializableApproval,
  TokenspaceFilesystem,
  TokenspaceSession,
  UserStore,
} from "@tokenspace/sdk";
import {
  ApprovalRequiredError,
  assertSerializable,
  getSessionFilesystem,
  isAction,
  Logger,
  runWithExecutionContext,
  TokenspaceError,
  users as tokenspaceUsers,
} from "@tokenspace/sdk";
import {
  Bash,
  type CommandContext,
  defineCommand,
  type ExecResult,
  getCommandNames,
  type IFileSystem,
  InMemoryFs,
  MountableFs,
} from "just-bash";

export type ToolOutputResult = {
  output: string;
  truncated: boolean;
  fullOutputPath?: string;
};

export class ExecutionError extends Error {
  constructor(
    message: string,
    public readonly stack?: string,
  ) {
    super(message);
    this.name = "ExecutionError";
  }
}

const MAX_INLINE_CHARS = 20_000;
const TOOL_OUTPUT_DIR = "/memory/.tokenspace/artifacts/tool-output";

export type RuntimeExecutionOptions = {
  approvals?: SerializableApproval[];
  bundleUrl?: string | null;
  bundlePath?: string | null;
  language?: "typescript" | "bash";
  jobId?: string | null;
  sessionId?: string | null;
  cwd?: string | null;
  timeoutMs?: number | null;
  fileSystem?: IFileSystem | null;
  credentialStore?: CredentialStore | null;
  userStore?: UserStore | null;
  bundleCacheDir?: string | null;
};

export async function executeCode(code: string, options?: RuntimeExecutionOptions): Promise<ToolOutputResult> {
  const runtimeFs = options?.fileSystem ?? new InMemoryFs();
  const tokenspaceFs = createTokenspaceFilesystem(runtimeFs);

  return await runWithExecutionContext(
    {
      filesystem: tokenspaceFs,
      credentialStore: options?.credentialStore ?? undefined,
      userStore: options?.userStore ?? undefined,
      approvals: options?.approvals ?? [],
    },
    async () => {
      if (options?.language === "bash") {
        return await executeBash(code, {
          ...options,
          fileSystem: runtimeFs,
        });
      }

      return await executeTypeScript(code, {
        ...options,
        fileSystem: runtimeFs,
      });
    },
  );
}

async function resolveBundlePath(
  bundlePath?: string | null,
  bundleUrl?: string | null,
  bundleCacheDir?: string | null,
): Promise<string | null> {
  if (bundlePath) return bundlePath;
  if (!bundleUrl) return null;

  try {
    return await downloadBundleFile(bundleUrl, bundleCacheDir);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new ExecutionError(`Failed to load workspace bundle: ${message}`);
  }
}

function toArrayBuffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return copy.buffer;
}

function toBytes(content: ArrayBuffer | string): Uint8Array | string {
  if (typeof content === "string") return content;
  return new Uint8Array(content);
}

function isENOENT(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("ENOENT");
}

function safeFileComponent(name: string): string {
  return encodeURIComponent(name);
}

function normalizeVirtualFsPath(path: string): string {
  if (!path || path === "/") return "/";

  let normalized = path.endsWith("/") && path !== "/" ? path.slice(0, -1) : path;
  if (!normalized.startsWith("/")) {
    normalized = `/${normalized}`;
  }

  const parts = normalized.split("/").filter((part) => part && part !== ".");
  const resolved: string[] = [];
  for (const part of parts) {
    if (part === "..") {
      resolved.pop();
    } else {
      resolved.push(part);
    }
  }

  return resolved.length === 0 ? "/" : `/${resolved.join("/")}`;
}

function tryDecodeFileComponent(name: string): string {
  try {
    return decodeURIComponent(name);
  } catch {
    return name;
  }
}

async function writeToolOutputArtifact(fs: IFileSystem, output: string, jobId?: string | null): Promise<string> {
  await fs.mkdir(TOOL_OUTPUT_DIR, { recursive: true });
  const fileName = `${safeFileComponent(jobId ?? randomUUID())}.txt`;
  const path = `${TOOL_OUTPUT_DIR}/${fileName}`;
  await fs.writeFile(path, output);
  return path;
}

function truncateOutputTail(value: string, maxChars: number, prefix: string): string {
  if (value.length <= maxChars) return value;
  if (prefix.length >= maxChars) return prefix.slice(0, maxChars);
  const tailLength = maxChars - prefix.length;
  return `${prefix}${value.slice(-tailLength)}`;
}

async function finalizeToolOutput(args: {
  output: string;
  sessionId?: string | null;
  sessionFs?: IFileSystem | null;
  jobId?: string | null;
}): Promise<ToolOutputResult> {
  if (args.output.length <= MAX_INLINE_CHARS) {
    return { output: args.output, truncated: false };
  }

  let fullOutputPath: string | undefined;
  if (args.sessionId && args.sessionFs) {
    try {
      fullOutputPath = await writeToolOutputArtifact(args.sessionFs, args.output, args.jobId);
    } catch (error) {
      console.warn("Failed to write tool output artifact", error);
    }
  }

  const pointer = fullOutputPath
    ? `(output truncated; full output saved to ${fullOutputPath})\n`
    : "(output truncated)\n";
  const truncatedOutput = truncateOutputTail(args.output, MAX_INLINE_CHARS, pointer);
  return fullOutputPath
    ? { output: truncatedOutput, truncated: true, fullOutputPath }
    : { output: truncatedOutput, truncated: true };
}

type WorkspaceCommandHandler = (args: string[], ctx: CommandContext) => Promise<ExecResult> | ExecResult;

type WorkspaceCommandRegistry = {
  commands?: Array<{ name: string; load: () => Promise<{ default?: WorkspaceCommandHandler }> }>;
};

const reservedBundleExports = new Set(["__tokenspace"]);

const reservedRuntimeGlobals = new Set([
  "__tokenspace",
  "session",
  "fs",
  "users",
  "bash",
  "sleep",
  "debug",
  "DEBUG_ENABLED",
  "TokenspaceError",
  "ApprovalRequiredError",
  "isApprovalRequest",
  "console",
  "setTimeout",
  "clearTimeout",
]);

function isRecordLike(value: unknown): value is Record<string, unknown> {
  return value != null && typeof value === "object" && !Array.isArray(value);
}

function validateWorkspaceApis(bundleExports: Record<string, unknown>): Record<string, unknown> {
  const globals: Record<string, unknown> = Object.create(null);

  for (const [namespace, value] of Object.entries(bundleExports)) {
    if (reservedBundleExports.has(namespace)) continue;

    if (reservedRuntimeGlobals.has(namespace)) {
      throw new TokenspaceError(`Workspace export "${namespace}" is reserved and cannot be used.`);
    }

    if (!isRecordLike(value)) {
      throw new TokenspaceError(
        `Workspace export "${namespace}" is invalid. Capability exports must be namespace objects.`,
      );
    }

    const namespaceValue = Object.create(null) as Record<string, unknown>;
    for (const [memberName, memberValue] of Object.entries(value)) {
      if (typeof memberValue === "function") {
        if (!isAction(memberValue)) {
          throw new TokenspaceError(
            `Invalid capability export "${namespace}.${memberName}". Exported functions must be created with action(schema, handler).`,
          );
        }
        namespaceValue[memberName] = memberValue;
        continue;
      }

      assertSerializable(memberValue, `capability constant ${namespace}.${memberName}`);
      namespaceValue[memberName] = memberValue;
    }

    globals[namespace] = Object.freeze(namespaceValue);
  }

  return globals;
}

function stripReservedBundleExports(exports: Record<string, unknown>): Record<string, unknown> {
  const next: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(exports)) {
    if (reservedBundleExports.has(key)) continue;
    next[key] = value;
  }
  return next;
}

const customCommandsCache = new Map<string, Promise<ReturnType<typeof defineCommand>[]>>();

async function loadWorkspaceCustomCommands(bundlePath: string): Promise<ReturnType<typeof defineCommand>[]> {
  const cached = customCommandsCache.get(bundlePath);
  if (cached) return cached;

  const promise = (async () => {
    const bundleExports = await importBundle(bundlePath);
    const registry = (bundleExports as any).__tokenspace as WorkspaceCommandRegistry | undefined;
    const entries = registry?.commands ?? [];
    if (entries.length === 0) return [];

    const builtins = new Set(getCommandNames());
    const seen = new Set<string>();
    const commands: ReturnType<typeof defineCommand>[] = [];

    for (const entry of entries) {
      const name = entry?.name;
      if (typeof name !== "string" || !name) continue;
      if (seen.has(name)) continue;
      seen.add(name);

      if (builtins.has(name)) {
        continue;
      }

      const module = await entry.load();
      const handler = module?.default;
      if (typeof handler !== "function") continue;

      commands.push(
        defineCommand(name, async (args, ctx) => {
          try {
            return await Promise.resolve(handler(args, ctx));
          } catch (error) {
            if (error instanceof ApprovalRequiredError) {
              return {
                stdout: "",
                stderr: `__TOKENSPACE_APPROVAL_REQUIRED__:${JSON.stringify(error.requirements[0])}\n`,
                exitCode: 1,
              };
            }
            if (error instanceof TokenspaceError) {
              const data = error.data as Record<string, unknown> | undefined;
              if (data && (data as any).errorType === "APPROVAL_REQUIRED" && (data as any).approval) {
                return {
                  stdout: "",
                  stderr: `__TOKENSPACE_APPROVAL_REQUIRED__:${JSON.stringify((data as any).approval)}\n`,
                  exitCode: 1,
                };
              }
            }
            throw error;
          }
        }),
      );
    }

    return commands;
  })();

  customCommandsCache.set(bundlePath, promise);
  return promise;
}

async function executeBash(code: string, options?: RuntimeExecutionOptions): Promise<ToolOutputResult> {
  try {
    const sessionFs = options?.fileSystem ?? new InMemoryFs();
    const bundlePath = await resolveBundlePath(
      options?.bundlePath ?? null,
      options?.bundleUrl ?? null,
      options?.bundleCacheDir ?? null,
    );

    const result = await runBashScript(code, {
      bundlePath,
      sessionFs,
      cwd: options?.cwd ?? null,
      timeoutMs: options?.timeoutMs ?? null,
    });

    throwIfBashExecRequestedApproval(result);

    const output = formatBashOutput(result);
    throwIfBashExecFailed(result);

    return await finalizeToolOutput({
      output,
      sessionId: options?.sessionId ?? null,
      sessionFs,
      jobId: options?.jobId ?? null,
    });
  } catch (error) {
    if (error instanceof TokenspaceError) throw error;
    if (error instanceof ExecutionError) throw error;
    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new ExecutionError(`Bash execution error: ${errorMessage}`);
  }
}

type BashScriptOptions = {
  bundlePath: string | null;
  sessionFs: IFileSystem;
  cwd: string | null;
  timeoutMs: number | null;
};

async function runBashScript(code: string, options: BashScriptOptions): Promise<ExecResult> {
  const fs = new MountableFs({ base: new InMemoryFs() });
  fs.mount("/sandbox", options.sessionFs);

  const workingDir = options.cwd ? `/sandbox/${options.cwd}` : "/sandbox";
  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.max(1, Math.floor(options.timeoutMs))
      : null;
  const deadlineMs = timeoutMs != null ? Date.now() + timeoutMs : null;

  const customCommands = options.bundlePath != null ? await loadWorkspaceCustomCommands(options.bundlePath) : [];

  const bash = new Bash({
    fs,
    cwd: workingDir,
    env: {
      HOME: "/sandbox",
      USER: "playground",
      PATH: "/usr/bin:/bin",
    },
    customCommands,
    defenseInDepth: false,
    executionLimits:
      timeoutMs != null
        ? {
            maxPythonTimeoutMs: timeoutMs,
            maxSqliteTimeoutMs: timeoutMs,
          }
        : undefined,
    sleep:
      deadlineMs != null
        ? async (ms: number) => {
            const now = Date.now();
            const remaining = deadlineMs - now;
            if (remaining <= 0) {
              throw new ExecutionError(`Bash execution timed out after ${timeoutMs}ms`);
            }
            const step = Math.min(ms, remaining);
            await new Promise<void>((resolve) => setTimeout(resolve, step));
            if (ms > step) {
              throw new ExecutionError(`Bash execution timed out after ${timeoutMs}ms`);
            }
          }
        : undefined,
    python: false,
    javascript: false,
  });

  return await bash.exec(code);
}

function throwIfBashExecRequestedApproval(result: ExecResult): void {
  if (!result.stderr) return;

  const marker = "__TOKENSPACE_APPROVAL_REQUIRED__:";
  const idx = result.stderr.indexOf(marker);
  if (idx === -1) return;

  const after = result.stderr.slice(idx + marker.length);
  const line = after.split("\n")[0]?.trim();
  if (!line) return;

  let approval: { action: string; data?: any; info?: any; description?: string } | null = null;
  try {
    approval = JSON.parse(line) as { action: string; data?: any; info?: any; description?: string };
  } catch {
    approval = null;
  }
  if (approval && typeof approval.action === "string") {
    throw new ApprovalRequiredError(approval);
  }
}

function formatBashOutput(result: ExecResult): string {
  let output = result.stdout || "";
  if (result.stderr) {
    output = result.stderr + (output ? `\n${output}` : "");
  }
  return output;
}

function throwIfBashExecFailed(result: ExecResult): void {
  if (result.exitCode === 0) return;
  const errorOutput = result.stderr || result.stdout || `Process exited with code ${result.exitCode}`;
  throw new ExecutionError(`Bash execution failed (exit code ${result.exitCode}):\n${errorOutput}`);
}

let sandboxBridgeCounter = 0;

function nextSandboxBridgeKey(context: vm.Context, prefix: string): string {
  const contextObject = context as Record<string, unknown>;
  while (true) {
    sandboxBridgeCounter += 1;
    const key = `__tokenspace_bridge_${prefix}_${randomUUID()}_${sandboxBridgeCounter}`;
    if (!Object.hasOwn(contextObject, key)) {
      return key;
    }
  }
}

function defineSandboxBridgeValue(context: vm.Context, key: string, value: unknown): void {
  Object.defineProperty(context as Record<string, unknown>, key, {
    configurable: true,
    enumerable: false,
    writable: true,
    value,
  });
}

function deleteSandboxBridgeValue(context: vm.Context, key: string): void {
  Reflect.deleteProperty(context as Record<string, unknown>, key);
}

function createContextError(context: vm.Context, name: string, message: string): Record<string, unknown> {
  const nameKey = nextSandboxBridgeKey(context, "error_name");
  const messageKey = nextSandboxBridgeKey(context, "error_message");
  defineSandboxBridgeValue(context, nameKey, name);
  defineSandboxBridgeValue(context, messageKey, message);

  try {
    return vm.runInContext(
      `(() => {
        const e = new Error(String(globalThis[${JSON.stringify(messageKey)}] ?? ""));
        e.name = String(globalThis[${JSON.stringify(nameKey)}] ?? "Error");
        return e;
      })()`,
      context,
    ) as Record<string, unknown>;
  } finally {
    deleteSandboxBridgeValue(context, nameKey);
    deleteSandboxBridgeValue(context, messageKey);
  }
}

function isPromiseLike(value: unknown): value is Promise<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function isObjectLike(value: unknown): value is Record<string | symbol, unknown> {
  return typeof value === "object" && value !== null;
}

function isFunctionLike(value: unknown): value is (...args: any[]) => unknown {
  return typeof value === "function";
}

function contextifyThrownError(context: vm.Context, error: unknown, seen: WeakMap<object, unknown>): unknown {
  if (!error || (typeof error !== "object" && typeof error !== "function")) {
    return error;
  }

  const record = error as Record<string, unknown>;
  const message =
    typeof record.message === "string" ? record.message : error instanceof Error ? error.message : String(error);
  const name = typeof record.name === "string" ? record.name : error instanceof Error ? error.name : "Error";
  const wrapped = createContextError(context, name, message);

  if (typeof record.details === "string") {
    wrapped.details = record.details;
  }

  const data = record.data;
  if (data && typeof data === "object" && !Array.isArray(data)) {
    wrapped.data = contextifyValue(context, data, seen);
  }

  const requirements = record.requirements;
  if (Array.isArray(requirements)) {
    wrapped.requirements = contextifyValue(context, requirements, seen);
  }

  return wrapped;
}

function createContextPromiseFromHostPromise(
  context: vm.Context,
  hostPromise: Promise<unknown>,
  seen: WeakMap<object, unknown>,
): Promise<unknown> {
  const promiseKey = nextSandboxBridgeKey(context, "promise_value");
  const wireKey = nextSandboxBridgeKey(context, "promise_wire");
  defineSandboxBridgeValue(context, promiseKey, hostPromise);
  defineSandboxBridgeValue(
    context,
    wireKey,
    (promise: Promise<unknown>, resolve: (value: unknown) => void, reject: (reason: unknown) => void) => {
      Promise.resolve(promise).then(
        (resolvedValue) => {
          try {
            resolve(contextifyValue(context, resolvedValue, seen));
          } catch (error) {
            reject(contextifyThrownError(context, error, seen));
          }
        },
        (reason) => {
          reject(contextifyThrownError(context, reason, seen));
        },
      );
    },
  );

  try {
    return vm.runInContext(
      `(() => {
        const p = globalThis[${JSON.stringify(promiseKey)}];
        const wire = globalThis[${JSON.stringify(wireKey)}];
        return new Promise((resolve, reject) => wire(p, resolve, reject));
      })()`,
      context,
    ) as Promise<unknown>;
  } finally {
    deleteSandboxBridgeValue(context, promiseKey);
    deleteSandboxBridgeValue(context, wireKey);
  }
}

function createContextCallableWrapper(
  context: vm.Context,
  callable: (...args: any[]) => unknown,
  seen: WeakMap<object, unknown>,
  options?: { bindThis?: unknown },
): (...args: any[]) => unknown {
  const invokeKey = nextSandboxBridgeKey(context, "invoke");
  defineSandboxBridgeValue(context, invokeKey, (thisArg: unknown, args: unknown[], isConstructCall: boolean) => {
    try {
      const result = isConstructCall
        ? Reflect.construct(callable as any, args)
        : Reflect.apply(callable, options?.bindThis !== undefined ? options.bindThis : thisArg, args);
      return contextifyValue(context, result, seen);
    } catch (error) {
      throw contextifyThrownError(context, error, seen);
    }
  });

  try {
    return vm.runInContext(
      `(() => {
        const invoke = globalThis[${JSON.stringify(invokeKey)}];
        const wrapped = function (...args) {
          return invoke(this, args, new.target !== undefined);
        };
        try {
          Object.defineProperty(wrapped, "name", {
            value: ${JSON.stringify(callable.name || "wrapped")},
            configurable: true,
          });
        } catch {}
        return wrapped;
      })()`,
      context,
    ) as (...args: any[]) => unknown;
  } finally {
    deleteSandboxBridgeValue(context, invokeKey);
  }
}

function createContextObjectLiteral(context: vm.Context): Record<string, unknown> {
  return vm.runInContext("Object.create(null)", context) as Record<string, unknown>;
}

function createContextArray(context: vm.Context): unknown[] {
  return vm.runInContext("[]", context) as unknown[];
}

function contextifyValue(context: vm.Context, value: unknown, seen: WeakMap<object, unknown>): unknown {
  if (value === null || value === undefined) return value;
  const valueType = typeof value;
  if (valueType !== "object" && valueType !== "function") return value;

  const objectValue = value as object;
  const cached = seen.get(objectValue);
  if (cached !== undefined) {
    return cached;
  }

  if (isPromiseLike(value)) {
    const wrappedPromise = createContextPromiseFromHostPromise(context, Promise.resolve(value), seen);
    seen.set(objectValue, wrappedPromise);
    return wrappedPromise;
  }

  if (isFunctionLike(value)) {
    const wrapped = createContextCallableWrapper(context, value, seen);
    seen.set(objectValue, wrapped);

    for (const key of Reflect.ownKeys(value)) {
      if (key === "prototype" || key === "name" || key === "length") continue;
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) continue;

      Object.defineProperty(wrapped, key, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        writable: descriptor.writable,
        value: contextifyValue(context, descriptor.value, seen),
      });
    }
    return wrapped;
  }

  if (Array.isArray(value)) {
    const wrappedArray = createContextArray(context);
    seen.set(objectValue, wrappedArray);
    for (const item of value) {
      wrappedArray.push(contextifyValue(context, item, seen));
    }
    return wrappedArray;
  }

  if (!isObjectLike(value)) {
    return value;
  }

  const wrappedObject = createContextObjectLiteral(context);
  seen.set(objectValue, wrappedObject);

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor) continue;

    if ("value" in descriptor) {
      const raw = descriptor.value;
      const nextValue = isFunctionLike(raw)
        ? createContextCallableWrapper(context, raw, seen, { bindThis: value })
        : contextifyValue(context, raw, seen);

      Object.defineProperty(wrappedObject, key, {
        configurable: descriptor.configurable,
        enumerable: descriptor.enumerable,
        writable: descriptor.writable,
        value: nextValue,
      });
      continue;
    }

    const getter = descriptor.get
      ? createContextCallableWrapper(context, descriptor.get, seen, { bindThis: value })
      : undefined;
    const setter = descriptor.set
      ? createContextCallableWrapper(context, descriptor.set, seen, { bindThis: value })
      : undefined;
    Object.defineProperty(wrappedObject, key, {
      configurable: descriptor.configurable,
      enumerable: descriptor.enumerable,
      get: getter as (() => unknown) | undefined,
      set: setter as ((v: unknown) => void) | undefined,
    });
  }

  return wrappedObject;
}

function installContextifiedGlobals(context: vm.Context, globals: Record<string, unknown>): void {
  const seen = new WeakMap<object, unknown>();
  const contextObject = context as Record<string, unknown>;
  for (const [key, value] of Object.entries(globals)) {
    contextObject[key] = contextifyValue(context, value, seen);
  }
}

function hardenContextIntrinsics(context: vm.Context): void {
  vm.runInContext(
    `(() => {
      const lockGlobal = (name) => {
        const descriptor = Object.getOwnPropertyDescriptor(globalThis, name);
        if (!descriptor) return;
        try {
          Object.defineProperty(globalThis, name, {
            value: globalThis[name],
            writable: false,
            configurable: false,
            enumerable: descriptor.enumerable ?? false,
          });
        } catch {}
      };

      const lockStatic = (owner, key) => {
        const descriptor = Object.getOwnPropertyDescriptor(owner, key);
        if (!descriptor || !("value" in descriptor)) return;
        try {
          Object.defineProperty(owner, key, {
            value: descriptor.value,
            writable: false,
            configurable: false,
            enumerable: descriptor.enumerable ?? false,
          });
        } catch {}
      };

      lockGlobal("Promise");
      lockGlobal("Error");
      lockStatic(Object, "defineProperty");
      try {
        Object.defineProperty(Error, "prepareStackTrace", {
          value: undefined,
          writable: false,
          configurable: false,
          enumerable: false,
        });
      } catch {}
    })()`,
    context,
  );
}

function extractApprovalRequirement(error: unknown): ApprovalRequirement | null {
  if (!error || typeof error !== "object") return null;
  const record = error as Record<string, unknown>;

  const requirements = record.requirements;
  if (Array.isArray(requirements) && requirements.length > 0) {
    const first = requirements[0];
    if (first && typeof first === "object" && typeof (first as any).action === "string") {
      return first as ApprovalRequirement;
    }
  }

  const data = record.data;
  if (!data || typeof data !== "object") return null;
  const approval = (data as Record<string, unknown>).approval;
  if (
    approval &&
    typeof approval === "object" &&
    !Array.isArray(approval) &&
    typeof (approval as any).action === "string"
  ) {
    return approval as ApprovalRequirement;
  }
  if (Array.isArray(approval) && approval.length > 0) {
    const first = approval[0];
    if (first && typeof first === "object" && typeof (first as any).action === "string") {
      return first as ApprovalRequirement;
    }
  }
  return null;
}

function isApprovalRequiredLike(error: unknown): boolean {
  if (extractApprovalRequirement(error)) return true;
  if (!error || typeof error !== "object") return false;
  const data = (error as Record<string, unknown>).data;
  if (!data || typeof data !== "object") return false;
  return (data as Record<string, unknown>).errorType === "APPROVAL_REQUIRED";
}

function toTokenspaceErrorData(error: unknown): Record<string, unknown> | undefined {
  if (!error || typeof error !== "object") return undefined;
  const data = (error as Record<string, unknown>).data;
  if (!data || typeof data !== "object" || Array.isArray(data)) return undefined;
  return data as Record<string, unknown>;
}

async function executeTypeScript(code: string, options?: RuntimeExecutionOptions): Promise<ToolOutputResult> {
  const logs: string[] = [];
  const errors: string[] = [];
  const sessionId = options?.sessionId ?? "ephemeral";
  const runtimeFs = options?.fileSystem ?? new InMemoryFs();

  const sessionFs = new MountableFs({ base: new InMemoryFs() });
  sessionFs.mount("/sandbox", runtimeFs);

  const session = createSession(sessionId, runtimeFs);
  const tokenspaceFs = getSessionFilesystem();

  const logger = new Logger("usercode");
  const timerHandles = new Map<number, ReturnType<typeof setTimeout>>();
  let nextTimerId = 1;

  let workspaceApis: Record<string, unknown> = {};
  const bundlePath = await resolveBundlePath(
    options?.bundlePath ?? null,
    options?.bundleUrl ?? null,
    options?.bundleCacheDir ?? null,
  );
  if (bundlePath) {
    workspaceApis = await importBundle(bundlePath);
  }

  const workspaceGlobals = validateWorkspaceApis(stripReservedBundleExports(workspaceApis));
  const sandboxGlobals: Record<string, unknown> = Object.assign(Object.create(null), {
    console: {
      log: (...args: unknown[]) => logs.push(args.map((a) => formatValue(a)).join(" ")),
      warn: (...args: unknown[]) => logs.push(`[WARN] ${args.map((a) => formatValue(a)).join(" ")}`),
      error: (...args: unknown[]) => errors.push(args.map((a) => formatValue(a)).join(" ")),
      info: (...args: unknown[]) => logs.push(`[INFO] ${args.map((a) => formatValue(a)).join(" ")}`),
      debug: (...args: unknown[]) => logs.push(`[DEBUG] ${args.map((a) => formatValue(a)).join(" ")}`),
    },
    ...workspaceGlobals,
    session,
    fs: tokenspaceFs,
    users: tokenspaceUsers,
    setTimeout: (callback: () => void, delay: number) => {
      const id = nextTimerId++;
      const normalizedDelay = Number.isFinite(delay) ? Math.max(0, Math.floor(delay)) : 0;
      const handle = setTimeout(() => {
        timerHandles.delete(id);
        callback();
      }, normalizedDelay);
      timerHandles.set(id, handle);
      return id;
    },
    clearTimeout: (timeoutId: number) => {
      const handle = timerHandles.get(timeoutId);
      if (!handle) return;
      timerHandles.delete(timeoutId);
      clearTimeout(handle);
    },
    sleep: Bun.sleep,
    debug: logger.debug,
    DEBUG_ENABLED: logger.debugEnabled,
    bash: async (command: string, bashOptions?: { cwd?: string; timeoutMs?: number }): Promise<string> => {
      const result = await runBashScript(command, {
        bundlePath,
        sessionFs: runtimeFs,
        cwd: bashOptions?.cwd ?? null,
        timeoutMs: bashOptions?.timeoutMs ?? options?.timeoutMs ?? null,
      });
      throwIfBashExecRequestedApproval(result);
      const output = formatBashOutput(result);
      throwIfBashExecFailed(result);
      return output;
    },
    TokenspaceError,
    ApprovalRequiredError,
    isApprovalRequest: (error: Error | unknown): error is ApprovalRequiredError => {
      if (error instanceof ApprovalRequiredError) return true;
      if (error instanceof TokenspaceError) {
        const data = (error as TokenspaceError).data as Record<string, unknown> | undefined;
        return data?.errorType === "APPROVAL_REQUIRED";
      }
      return isApprovalRequiredLike(error);
    },
  });

  const context = vm.createContext(Object.create(null), {
    name: "tokenspace-sandbox",
    origin: `tokenspace://session:${session.id}/123`,
    codeGeneration: {
      strings: false,
      wasm: false,
    },
  });
  installContextifiedGlobals(context, sandboxGlobals);
  hardenContextIntrinsics(context);

  try {
    const wrappedCode = `(async () => {\n${code}\n})()`;
    const timeoutMs =
      typeof options?.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
        ? Math.max(1, Math.floor(options.timeoutMs))
        : 60_000;
    const vmTimeoutMs = Math.max(1, Math.min(2_147_483_647, timeoutMs - 250));
    await vm.runInContext(wrappedCode, context, {
      timeout: vmTimeoutMs,
      filename: "script.ts",
      displayErrors: true,
      breakOnSigint: true,
      lineOffset: -1,
    });
    const output = logs.join("\n") || "";
    return await finalizeToolOutput({
      output,
      sessionId: options?.sessionId ?? null,
      sessionFs: runtimeFs,
      jobId: options?.jobId ?? null,
    });
  } catch (error) {
    const approval = extractApprovalRequirement(error);
    if (approval) {
      throw new ApprovalRequiredError(approval);
    }

    if (error instanceof TokenspaceError) throw error;

    const maybeData = toTokenspaceErrorData(error);
    if (maybeData || (error as any)?.name === "TokenspaceError") {
      const message =
        error instanceof Error
          ? error.message
          : typeof (error as any)?.message === "string"
            ? (error as any).message
            : String(error);
      const details = typeof (error as any)?.details === "string" ? (error as any).details : undefined;
      throw new TokenspaceError(message, undefined, details, maybeData);
    }

    const errorMessage = error instanceof Error ? error.message : String(error);
    throw new ExecutionError(errorMessage, error instanceof Error ? error.stack : undefined);
  } finally {
    for (const handle of timerHandles.values()) {
      clearTimeout(handle);
    }
    timerHandles.clear();
  }
}

function createSession(sessionId: string, fs: IFileSystem): TokenspaceSession {
  const sessionVarsDir = "/memory/.tokenspace/session-vars";
  const artifactsDir = "/memory/.tokenspace/artifacts";

  async function ensureSessionDirs(): Promise<void> {
    await fs.mkdir(sessionVarsDir, { recursive: true });
    await fs.mkdir(artifactsDir, { recursive: true });
  }

  async function sessionVarPath(name: string): Promise<string> {
    try {
      await ensureSessionDirs();
    } catch {}
    return `${sessionVarsDir}/${safeFileComponent(name)}.json`;
  }

  function artifactPath(name: string): string {
    return `${artifactsDir}/${safeFileComponent(name)}`;
  }

  return {
    id: sessionId,
    async setSessionVariable(name: string, value: JSONValue): Promise<void> {
      const path = await sessionVarPath(name);
      await fs.writeFile(path, JSON.stringify(value));
    },
    async getSessionVariable(name: string): Promise<JSONValue | undefined> {
      const path = await sessionVarPath(name);
      try {
        const raw = await fs.readFile(path);
        return JSON.parse(raw) as JSONValue;
      } catch (error) {
        if (isENOENT(error)) return undefined;
        throw error;
      }
    },
    async writeArtifact(name: string, body: ArrayBuffer | string): Promise<void> {
      await ensureSessionDirs();
      const path = artifactPath(name);
      await fs.writeFile(path, toBytes(body));
    },
    async listArtifacts(): Promise<string[]> {
      try {
        const entries = await fs.readdir(artifactsDir);
        return entries.map(tryDecodeFileComponent);
      } catch (error) {
        if (isENOENT(error)) return [];
        throw error;
      }
    },
    async readArtifact(name: string): Promise<ArrayBuffer> {
      const path = artifactPath(name);
      const bytes = await fs.readFileBuffer(path);
      return toArrayBuffer(bytes);
    },
    async readArtifactText(name: string): Promise<string> {
      const path = artifactPath(name);
      return await fs.readFile(path);
    },
  };
}

function createTokenspaceFilesystem(runtimeFs: IFileSystem): TokenspaceFilesystem {
  function toRuntimePath(path: string): string {
    const normalized = normalizeVirtualFsPath(path);
    if (normalized === "/sandbox") return "/";
    if (normalized.startsWith("/sandbox/")) {
      const stripped = normalized.slice("/sandbox".length);
      return stripped || "/";
    }
    return normalized;
  }

  return {
    async list(path: string): Promise<string[]> {
      const normalized = normalizeVirtualFsPath(path);
      if (normalized === "/") {
        const entries = new Set<string>(["sandbox"]);
        try {
          const runtimeRootEntries = await runtimeFs.readdir("/");
          if (runtimeRootEntries.includes("memory")) {
            entries.add("memory");
          }
        } catch {}
        return Array.from(entries);
      }
      return await runtimeFs.readdir(toRuntimePath(normalized));
    },
    async stat(path: string): Promise<{ isDirectory: boolean; isFile: boolean; size: number }> {
      const normalized = normalizeVirtualFsPath(path);
      if (normalized === "/" || normalized === "/sandbox") {
        return { isDirectory: true, isFile: false, size: 0 };
      }
      const stat = await runtimeFs.stat(toRuntimePath(normalized));
      return { isDirectory: stat.isDirectory, isFile: stat.isFile, size: stat.size };
    },
    async read(path: string): Promise<ArrayBuffer> {
      const bytes = await runtimeFs.readFileBuffer(toRuntimePath(path));
      return toArrayBuffer(bytes);
    },
    async readText(path: string): Promise<string> {
      return await runtimeFs.readFile(toRuntimePath(path));
    },
    async write(path: string, content: ArrayBuffer | string): Promise<void> {
      await runtimeFs.writeFile(toRuntimePath(path), toBytes(content));
    },
    async delete(path: string): Promise<void> {
      await runtimeFs.rm(toRuntimePath(path), { recursive: true });
    },
  };
}

const cachedFiles = new Map<string, string>();

async function downloadBundleFile(url: string, bundleCacheDir?: string | null): Promise<string> {
  const cachedFile = cachedFiles.get(url);
  if (cachedFile) return cachedFile;

  const cacheDir = bundleCacheDir ?? join(import.meta.dir, "..", ".cache", "bundles");
  await mkdir(cacheDir, { recursive: true });

  const fileName = `tokenspace-bundle-${randomUUID()}.mjs`;
  const filePath = join(cacheDir, fileName);

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download bundle file: ${response.status} ${response.statusText}`);
  }
  const fileContent = await response.text();
  await Bun.write(filePath, fileContent);
  cachedFiles.set(url, filePath);
  return filePath;
}

const bundleImportCache = new Map<string, Promise<Record<string, unknown>>>();

function importBundle(bundlePath: string): Promise<Record<string, unknown>> {
  const cachedImport = bundleImportCache.get(bundlePath);
  if (cachedImport) return cachedImport;

  const importPromise = import(bundlePath);
  bundleImportCache.set(bundlePath, importPromise);
  return importPromise;
}

function formatValue(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Error) return `Error: ${value.message}`;
  if (value instanceof Promise) return "[Promise]";

  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}
