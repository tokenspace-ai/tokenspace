import type { Readable } from "node:stream";
import pc from "picocolors";
import {
  type CredentialRequirement,
  exitWithError,
  getCredentialRequirementsForRevision,
  getCurrentWorkingStateHash,
  getDefaultBranch,
  getWorkspaceBySlug,
  getWorkspaceRevision,
  listWorkspaceCredentialBindings,
  upsertWorkspaceSecretCredential,
  type WorkspaceCredentialBinding,
} from "../client.js";
import {
  findNearestLinkedWorkspaceRoot,
  printWorkspaceResolution,
  readLinkedWorkspaceConfig,
} from "../local-workspace.js";
import { promptSecret } from "../prompts.js";
import { readStdinValue } from "../stdin.js";

export { stripSingleTrailingNewline } from "../stdin.js";

type SetWorkspaceCredentialOptions = {
  stdin?: boolean;
};

type CredentialGroup = {
  key: string;
  label?: string;
  requirements: CredentialRequirement[];
};

type SettableWorkspaceSecretResult = { ok: true; requirement: CredentialRequirement } | { ok: false; error: string };

type CredentialCommandContext = {
  resolvedDir: string;
  workspace: NonNullable<Awaited<ReturnType<typeof getWorkspaceBySlug>>>;
  branch: NonNullable<Awaited<ReturnType<typeof getDefaultBranch>>>;
  revisionId: NonNullable<Awaited<ReturnType<typeof getWorkspaceRevision>>>;
};

function requirementDisplayName(requirement: { id: string; label?: string }): string {
  return requirement.label?.trim() || requirement.id;
}

function requirementBadgeLabel(requirement: { scope: string; kind: string; optional?: boolean }): string {
  return `${requirement.scope}/${requirement.kind}${requirement.optional ? " · optional" : ""}`;
}

function sortCredentialRequirements(requirements: CredentialRequirement[]): CredentialRequirement[] {
  return [...requirements].sort((left, right) => {
    const group = (left.group ?? "").localeCompare(right.group ?? "");
    if (group !== 0) {
      return group;
    }
    const name = requirementDisplayName(left).localeCompare(requirementDisplayName(right));
    if (name !== 0) {
      return name;
    }
    return left.id.localeCompare(right.id);
  });
}

export function partitionCredentialRequirements(requirements: CredentialRequirement[]): {
  runtime: CredentialRequirement[];
  workspace: CredentialRequirement[];
} {
  const sorted = sortCredentialRequirements(requirements);
  return {
    workspace: sorted.filter((requirement) => requirement.scope === "workspace"),
    runtime: sorted.filter((requirement) => requirement.scope !== "workspace"),
  };
}

function groupCredentialRequirements(requirements: CredentialRequirement[]): CredentialGroup[] {
  const groups: CredentialGroup[] = [];
  const byKey = new Map<string, CredentialGroup>();

  for (const requirement of requirements) {
    const key = requirement.group ?? "__ungrouped__";
    let group = byKey.get(key);
    if (!group) {
      group = {
        key,
        label: requirement.group,
        requirements: [],
      };
      byKey.set(key, group);
      groups.push(group);
    }
    group.requirements.push(requirement);
  }

  return groups;
}

function formatTimestamp(timestamp: number): string {
  return new Date(timestamp).toLocaleString();
}

function isUnauthorizedError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("Unauthorized");
}

function getConfigString(config: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = config?.[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function toConfigRecord(config: CredentialRequirement["config"]): Record<string, unknown> | undefined {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    return undefined;
  }
  return config;
}

function formatIndentedLines(prefix: string, text: string): string[] {
  return text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => `${prefix}${line}`);
}

function printRequirementDescription(description: string | undefined): void {
  if (!description) {
    return;
  }
  for (const line of formatIndentedLines("    ", description)) {
    console.log(pc.dim(line));
  }
}

function printWorkspaceRequirement(args: {
  bindingByKey: Map<string, WorkspaceCredentialBinding>;
  bindingsVisible: boolean;
  requirement: CredentialRequirement;
}): void {
  const { requirement, bindingByKey, bindingsVisible } = args;
  const config = toConfigRecord(requirement.config);
  const binding = requirement.kind === "env" ? undefined : bindingByKey.get(`${requirement.id}:${requirement.kind}`);

  console.log(`  ${pc.bold(requirementDisplayName(requirement))} ${pc.dim(`(${requirement.id})`)}`);
  console.log(pc.dim(`    ${requirementBadgeLabel(requirement)}`));
  printRequirementDescription(requirement.description);

  if (requirement.kind === "env") {
    const variableName = getConfigString(config, "variableName");
    if (variableName) {
      console.log(pc.dim(`    Environment variable: ${variableName}`));
    }
    console.log(pc.dim("    Value source: executor environment only; not stored in Tokenspace."));
    return;
  }

  if (bindingsVisible) {
    console.log(binding ? pc.green("    Status: configured") : pc.red("    Status: not configured"));
    if (binding) {
      console.log(pc.dim(`    Last updated: ${formatTimestamp(binding.updatedAt)}`));
    }
  } else {
    console.log(pc.dim("    Status: unavailable (workspace admin access required)"));
  }

  if (requirement.kind === "oauth") {
    const grantType = getConfigString(config, "grantType");
    if (grantType) {
      console.log(pc.dim(`    Grant type: ${grantType}`));
    }
    console.log(pc.dim("    OAuth credentials are list-only in CLI v1."));
  }
}

function printRuntimeRequirement(requirement: CredentialRequirement): void {
  const config = toConfigRecord(requirement.config);

  console.log(`  ${pc.bold(requirementDisplayName(requirement))} ${pc.dim(`(${requirement.id})`)}`);
  console.log(pc.dim(`    ${requirementBadgeLabel(requirement)}`));
  printRequirementDescription(requirement.description);

  if (requirement.kind === "env") {
    const variableName = getConfigString(config, "variableName");
    if (variableName) {
      console.log(pc.dim(`    Environment variable: ${variableName}`));
    }
    console.log(pc.dim("    Runtime-scoped env credentials must be provided by the executor environment."));
    return;
  }

  if (requirement.kind === "oauth") {
    const grantType = getConfigString(config, "grantType");
    if (grantType) {
      console.log(pc.dim(`    Grant type: ${grantType}`));
    }
  }

  console.log(pc.dim("    Configured at runtime in chat/playground; CLI set is not supported in v1."));
}

function printCredentialGroups(
  groups: CredentialGroup[],
  renderRequirement: (requirement: CredentialRequirement) => void,
): void {
  for (const group of groups) {
    if (group.label) {
      console.log(pc.bold(group.label));
    }
    for (const requirement of group.requirements) {
      renderRequirement(requirement);
    }
    console.log("");
  }
}

async function loadCredentialCommandContext(): Promise<CredentialCommandContext> {
  const resolvedDir = await findNearestLinkedWorkspaceRoot(process.cwd());
  if (!resolvedDir) {
    exitWithError("No linked tokenspace found. Run `tokenspace link` first.");
  }

  const linked = await readLinkedWorkspaceConfig(resolvedDir);
  if (!linked) {
    exitWithError("Linked tokenspace metadata is missing or invalid.");
  }

  const workspace = await getWorkspaceBySlug(linked.workspaceSlug);
  if (!workspace) {
    exitWithError(`Tokenspace '${linked.workspaceSlug}' not found`);
  }

  const branch = await getDefaultBranch(workspace._id);
  if (!branch) {
    exitWithError(`No default branch found in tokenspace '${linked.workspaceSlug}'`);
  }

  const workingStateHash = (await getCurrentWorkingStateHash(workspace._id, branch._id)) ?? undefined;
  const revisionId = await getWorkspaceRevision(workspace._id, branch._id, workingStateHash);
  if (!revisionId) {
    exitWithError(`No compiled revision found for '${linked.workspaceSlug}'. Run \`tokenspace push\` first.`);
  }

  return {
    resolvedDir,
    workspace,
    branch,
    revisionId,
  };
}

function printContextHeader(title: string, context: CredentialCommandContext): void {
  console.log(pc.cyan(`${title} ${pc.bold(context.workspace.slug)}`));
  printWorkspaceResolution("Workspace", context.resolvedDir);
  console.log(pc.dim(`  Branch: ${context.branch.name}`));
  console.log(pc.dim(`  Revision: ${context.revisionId}`));
}

function getSupportedWorkspaceSecretIds(requirements: CredentialRequirement[]): string[] {
  return requirements
    .filter((requirement) => requirement.scope === "workspace" && requirement.kind === "secret")
    .map((requirement) => requirement.id)
    .sort((left, right) => left.localeCompare(right));
}

export function resolveSettableWorkspaceSecretRequirement(
  requirements: CredentialRequirement[],
  credentialId: string,
): SettableWorkspaceSecretResult {
  const requirement = requirements.find((entry) => entry.id === credentialId);
  if (!requirement) {
    const availableIds = getSupportedWorkspaceSecretIds(requirements);
    const availableMessage =
      availableIds.length > 0
        ? ` Available workspace secret credentials: ${availableIds.join(", ")}`
        : " No workspace-scoped secret credentials are declared in the current revision.";
    return {
      ok: false,
      error: `Credential "${credentialId}" is not declared in the current revision.${availableMessage}`,
    };
  }

  const displayName = requirementDisplayName(requirement);
  if (requirement.scope !== "workspace") {
    return {
      ok: false,
      error: `Credential "${displayName}" has scope "${requirement.scope}". Only workspace-scoped secret credentials can be set with this command.`,
    };
  }

  if (requirement.kind === "env") {
    return {
      ok: false,
      error: `Credential "${displayName}" is an env credential. Env credentials are provided by executor environment variables and cannot be set with this CLI command.`,
    };
  }

  if (requirement.kind === "oauth") {
    return {
      ok: false,
      error: `Credential "${displayName}" is an OAuth credential. OAuth connect is list-only in CLI v1.`,
    };
  }

  return { ok: true, requirement };
}

export async function readSecretFromStdin(input: Readable = process.stdin): Promise<string> {
  return await readStdinValue(input);
}

export async function listCredentials(): Promise<void> {
  const context = await loadCredentialCommandContext();
  const requirements = await getCredentialRequirementsForRevision(context.revisionId);
  const { runtime, workspace } = partitionCredentialRequirements(requirements);

  let bindingsVisible = context.workspace.role === "workspace_admin";
  let bindings: WorkspaceCredentialBinding[] = [];

  if (bindingsVisible) {
    try {
      bindings = await listWorkspaceCredentialBindings(context.workspace._id);
    } catch (error) {
      if (!isUnauthorizedError(error)) {
        throw error;
      }
      bindingsVisible = false;
    }
  }

  const bindingByKey = new Map<string, WorkspaceCredentialBinding>();
  for (const binding of bindings) {
    bindingByKey.set(`${binding.credentialId}:${binding.kind}`, binding);
  }

  printContextHeader("Listing credentials for", context);
  console.log("");

  console.log(pc.bold("Workspace Credentials"));
  if (workspace.length === 0) {
    console.log(pc.dim("  No workspace-scoped credentials are defined in `src/credentials.ts`."));
    console.log("");
  } else {
    printCredentialGroups(groupCredentialRequirements(workspace), (requirement) =>
      printWorkspaceRequirement({
        requirement,
        bindingByKey,
        bindingsVisible,
      }),
    );
  }

  console.log(pc.bold("Runtime-Scoped Credentials"));
  if (runtime.length === 0) {
    console.log(pc.dim("  No runtime-scoped credentials are defined in `src/credentials.ts`."));
    return;
  }

  printCredentialGroups(groupCredentialRequirements(runtime), printRuntimeRequirement);
}

export async function setWorkspaceCredential(
  credentialId: string,
  options: SetWorkspaceCredentialOptions,
  io: { stdin?: Readable } = {},
): Promise<void> {
  const context = await loadCredentialCommandContext();
  if (context.workspace.role !== "workspace_admin") {
    exitWithError("Only workspace admins can set workspace-scoped credentials.");
  }

  const requirements = await getCredentialRequirementsForRevision(context.revisionId);
  const selection = resolveSettableWorkspaceSecretRequirement(requirements, credentialId);
  if (!selection.ok) {
    exitWithError(selection.error);
  }

  const value = options.stdin
    ? await readSecretFromStdin(io.stdin ?? process.stdin)
    : await promptSecret(pc.cyan(`Secret value for ${requirementDisplayName(selection.requirement)}: `));

  if (value.trim().length === 0) {
    exitWithError("Secret value is required.");
  }

  await upsertWorkspaceSecretCredential(context.workspace._id, context.revisionId, selection.requirement.id, value);

  printContextHeader("Saving credential for", context);
  console.log("");
  console.log(
    pc.green(
      `✓ Saved workspace secret ${pc.bold(requirementDisplayName(selection.requirement))} ${pc.dim(`(${selection.requirement.id})`)}`,
    ),
  );
}
