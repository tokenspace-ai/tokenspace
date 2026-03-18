import { spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import ts from "typescript";

export type CredentialRequirementSummary = {
  path: string;
  exportName: string;
  id: string;
  label?: string;
  group?: string;
  kind: "secret" | "env" | "oauth";
  scope: "workspace" | "session" | "user";
  description?: string;
  iconPath?: string;
  placeholder?: string;
  optional?: boolean;
  fallback?: string;
  config?: Record<string, unknown>;
};

export type ExtractedCredentialRequirement = Omit<CredentialRequirementSummary, "iconPath"> & {
  icon?: string;
};

type CredentialScope = "workspace" | "session" | "user";
type RawCredentialKind = "secret" | "env" | "oauth";
type ExtractCredentialsPayload = {
  credentials: Array<{
    exportName: string;
    value: unknown;
  }>;
};

const WORKSPACE_CREDENTIALS_SOURCE_PATH = "src/credentials.ts";
const DEFAULT_CREDENTIAL_EVAL_TIMEOUT_MS = 10_000;
const EVAL_RESULT_MARKER = "__TOKENSPACE_CREDENTIALS_RESULT__";

const EVALUATION_SCRIPT = `
const marker = ${JSON.stringify(EVAL_RESULT_MARKER)};
const moduleUrl = process.argv[1];

if (!moduleUrl) {
  console.error("Missing credentials module URL");
  process.exit(1);
}

try {
  const namespace = await import(moduleUrl);
  const credentials = [];

  for (const [exportName, value] of Object.entries(namespace)) {
    if (exportName === "default") continue;
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;

    const kind = value.kind;
    if (kind === "secret" || kind === "env" || kind === "oauth") {
      credentials.push({ exportName, value });
    }
  }

  console.log(marker + JSON.stringify({ credentials }));
} catch (error) {
  if (error instanceof Error) {
    console.error(error.stack ?? error.message);
  } else {
    console.error(String(error));
  }
  process.exit(1);
}
`;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertNonEmptyString(value: unknown, source: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${source} must be a non-empty string`);
  }
  return value;
}

function readOptionalString(value: unknown, source: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new Error(`${source} must be a string when provided`);
  }
  return value;
}

function readOptionalBoolean(value: unknown, source: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new Error(`${source} must be a boolean when provided`);
  }
  return value;
}

function assertScope(value: unknown, source: string): CredentialScope {
  if (value === "workspace" || value === "session" || value === "user") {
    return value;
  }
  throw new Error(`${source} has invalid or missing "scope"`);
}

function assertCredentialKind(value: unknown, source: string): RawCredentialKind {
  if (value === "secret" || value === "env" || value === "oauth") {
    return value;
  }
  throw new Error(`${source} has unsupported credential kind`);
}

function normalizeScopes(value: unknown, source: string): string[] {
  if (!Array.isArray(value)) {
    throw new Error(`${source} must be an array`);
  }

  return value.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new Error(`${source}[${index}] must be a string`);
    }
    return entry;
  });
}

function normalizeCredentialValue(
  exportName: string,
  value: unknown,
  sourcePath: string,
): ExtractedCredentialRequirement {
  const source = `${sourcePath}: export "${exportName}"`;
  if (!isRecord(value)) {
    throw new Error(`${source} is not an object`);
  }

  const kind = assertCredentialKind(value.kind, source);
  const id = assertNonEmptyString(value.id, `${source}.id`);
  const label = normalizeOptionalMetadataString(readOptionalString(value.label, `${source}.label`));
  const group = normalizeOptionalMetadataString(readOptionalString(value.group, `${source}.group`));
  const description = readOptionalString(value.description, `${source}.description`);
  const icon = normalizeOptionalMetadataString(readOptionalString(value.icon, `${source}.icon`));
  const optional = readOptionalBoolean(value.optional, `${source}.optional`);
  const fallback = readOptionalString(value.fallback, `${source}.fallback`);

  if (kind === "secret") {
    const placeholder = readOptionalString(value.placeholder, `${source}.placeholder`);
    return {
      path: sourcePath,
      exportName,
      id,
      label,
      group,
      kind,
      scope: assertScope(value.scope, source),
      description,
      ...(icon ? { icon } : {}),
      placeholder,
      optional,
      fallback,
    };
  }

  if (kind === "env") {
    const variableName = assertNonEmptyString(value.variableName, `${source}.variableName`);
    const decryptionKey = readOptionalString(value.decryptionKey, `${source}.decryptionKey`);
    const scope = assertScope(value.scope, source);
    if (scope !== "workspace") {
      throw new Error(`${source} env credentials must use scope "workspace"`);
    }

    const config: Record<string, unknown> = { variableName };
    if (decryptionKey !== undefined) {
      config.decryptionKey = decryptionKey;
    }

    return {
      path: sourcePath,
      exportName,
      id,
      label,
      group,
      kind,
      scope,
      description,
      ...(icon ? { icon } : {}),
      optional,
      fallback,
      config,
    };
  }

  const grantType = value.grantType;
  if (grantType !== "authorization_code" && grantType !== "client_credentials" && grantType !== "implicit") {
    throw new Error(`${source}.grantType has invalid or missing value`);
  }

  return {
    path: sourcePath,
    exportName,
    id,
    label,
    group,
    kind,
    scope: assertScope(value.scope, source),
    description,
    ...(icon ? { icon } : {}),
    optional,
    fallback,
    config: {
      grantType,
      clientId: assertNonEmptyString(value.clientId, `${source}.clientId`),
      clientSecret: assertNonEmptyString(value.clientSecret, `${source}.clientSecret`),
      authorizeUrl: assertNonEmptyString(value.authorizeUrl, `${source}.authorizeUrl`),
      tokenUrl: assertNonEmptyString(value.tokenUrl, `${source}.tokenUrl`),
      scopes: normalizeScopes(value.scopes, `${source}.scopes`),
    },
  };
}

function normalizeOptionalMetadataString(value: string | undefined): string | undefined {
  const normalized = value?.trim();
  return normalized ? normalized : undefined;
}

function getExportSpecifierName(specifier: ts.ExportSpecifier): string {
  return (specifier.name ?? specifier.propertyName).text;
}

function collectCredentialExportOrder(sourceText: string, sourcePath: string): string[] {
  const sourceFile = ts.createSourceFile(sourcePath, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const exportNames: string[] = [];
  const seen = new Set<string>();
  const pushName = (name: string | null | undefined) => {
    if (!name || seen.has(name)) {
      return;
    }
    seen.add(name);
    exportNames.push(name);
  };

  for (const statement of sourceFile.statements) {
    if (
      ts.isVariableStatement(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          pushName(declaration.name.text);
        }
      }
      continue;
    }

    if (
      ts.isFunctionDeclaration(statement) &&
      statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword)
    ) {
      pushName(statement.name?.text);
      continue;
    }

    if (ts.isExportDeclaration(statement) && !statement.moduleSpecifier && statement.exportClause) {
      if (ts.isNamedExports(statement.exportClause)) {
        for (const specifier of statement.exportClause.elements) {
          pushName(getExportSpecifierName(specifier));
        }
      }
    }
  }

  return exportNames;
}

async function runCredentialsEvaluation(
  workspaceDir: string,
  credentialsModulePath: string,
  timeoutMs: number,
): Promise<ExtractCredentialsPayload> {
  const credentialsModuleUrl = pathToFileURL(credentialsModulePath).href;

  const child = spawn("bun", ["-e", EVALUATION_SCRIPT, credentialsModuleUrl], {
    cwd: workspaceDir,
    stdio: ["ignore", "pipe", "pipe"],
    env: process.env,
  });

  let stdout = "";
  let stderr = "";
  let timedOut = false;

  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);

  child.stdout.on("data", (chunk: Buffer | string) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk: Buffer | string) => {
    stderr += chunk.toString();
  });

  const exitCode = await new Promise<number | null>((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", (code) => resolve(code));
  }).finally(() => {
    clearTimeout(timeout);
  });

  if (timedOut) {
    throw new Error(
      `Credential extraction timed out after ${timeoutMs}ms while evaluating "${WORKSPACE_CREDENTIALS_SOURCE_PATH}"`,
    );
  }

  if (exitCode !== 0) {
    const details = (stderr || stdout).trim();
    if (details) {
      throw new Error(`Failed to evaluate "${WORKSPACE_CREDENTIALS_SOURCE_PATH}": ${details}`);
    }
    throw new Error(`Failed to evaluate "${WORKSPACE_CREDENTIALS_SOURCE_PATH}" (exit code ${exitCode ?? "unknown"})`);
  }

  const resultLine = stdout
    .trim()
    .split(/\r?\n/)
    .reverse()
    .find((line) => line.startsWith(EVAL_RESULT_MARKER));

  if (!resultLine) {
    throw new Error(`Credential evaluation did not return a result payload for "${WORKSPACE_CREDENTIALS_SOURCE_PATH}"`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(resultLine.slice(EVAL_RESULT_MARKER.length));
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`Credential evaluation returned malformed JSON: ${details}`);
  }

  if (!isRecord(parsed) || !Array.isArray(parsed.credentials)) {
    throw new Error("Credential evaluation returned an invalid payload");
  }

  return {
    credentials: parsed.credentials as ExtractCredentialsPayload["credentials"],
  };
}

export async function extractCredentialRequirementsFromWorkspace(
  workspaceDir: string,
  options?: {
    timeoutMs?: number;
  },
): Promise<ExtractedCredentialRequirement[]> {
  const sourcePath = path.join(workspaceDir, WORKSPACE_CREDENTIALS_SOURCE_PATH);

  try {
    await access(sourcePath, fsConstants.F_OK);
  } catch {
    return [];
  }

  const timeoutMs = options?.timeoutMs ?? DEFAULT_CREDENTIAL_EVAL_TIMEOUT_MS;
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new Error(`Invalid credential evaluation timeout: ${String(timeoutMs)}`);
  }

  const [sourceText, payload] = await Promise.all([
    readFile(sourcePath, "utf8"),
    runCredentialsEvaluation(workspaceDir, sourcePath, timeoutMs),
  ]);

  const exportOrder = collectCredentialExportOrder(sourceText, sourcePath);
  const exportOrderIndex = new Map(exportOrder.map((exportName, index) => [exportName, index]));
  const byCredentialId = new Map<string, string>();
  const requirements: ExtractedCredentialRequirement[] = [];

  for (const item of payload.credentials) {
    if (!isRecord(item)) {
      throw new Error("Credential evaluation returned an invalid export entry");
    }
    const exportName = assertNonEmptyString(item.exportName, "Credential export name");
    const requirement = normalizeCredentialValue(exportName, item.value, WORKSPACE_CREDENTIALS_SOURCE_PATH);

    const previousExport = byCredentialId.get(requirement.id);
    if (previousExport) {
      throw new Error(
        `${WORKSPACE_CREDENTIALS_SOURCE_PATH}: duplicate credential id "${requirement.id}" in exports "${previousExport}" and "${exportName}"`,
      );
    }
    byCredentialId.set(requirement.id, exportName);
    requirements.push(requirement);
  }

  return [...requirements].sort((a, b) => {
    const aOrder = exportOrderIndex.get(a.exportName);
    const bOrder = exportOrderIndex.get(b.exportName);
    if (aOrder !== undefined && bOrder !== undefined) {
      return aOrder - bOrder;
    }
    if (aOrder !== undefined) {
      return -1;
    }
    if (bOrder !== undefined) {
      return 1;
    }
    return 0;
  });
}
