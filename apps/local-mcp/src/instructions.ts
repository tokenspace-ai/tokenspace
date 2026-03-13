import type { SkillSummary } from "@tokenspace/compiler";
import type { LocalSession } from "./types";

const systemSkills: SkillSummary[] = [
  {
    path: "system/skills/bash/SKILL.md",
    name: "bash",
    description: "Use Tokenspace's sandboxed bash environment (just-bash) safely and effectively",
  },
];

function getCapabilitiesXml(session: LocalSession): string {
  return session.buildResult.metadata.capabilities
    .map(
      (capability) => `<capability>
    <path>${capability.path}</path>
    <types>${capability.typesPath}</types>
    <name>${capability.name}</name>
    <description>${capability.description}</description>
</capability>`,
    )
    .join("\n");
}

function getAvailableSkills(session: LocalSession): SkillSummary[] {
  return [...session.buildResult.metadata.skills, ...systemSkills];
}

function getSkillsXml(session: LocalSession): string {
  return getAvailableSkills(session)
    .map(
      (skill) => `<skill>
    <path>${skill.path}</path>
    <name>${skill.name}</name>
    <description>${skill.description}</description>
</skill>`,
    )
    .join("\n");
}

function getCapabilitiesSummary(session: LocalSession): string {
  return session.buildResult.metadata.capabilities
    .map(
      (capability) => `${capability.typesPath.replace(/^capabilities\/([^/]+)\/.*$/, "$1")}: ${capability.description}`,
    )
    .join("; ");
}

function getCapabilitiesList(session: LocalSession): string {
  return session.buildResult.metadata.capabilities
    .map((capability) => {
      const namespace = capability.typesPath.replace(/^capabilities\/([^/]+)\/.*$/, "$1");
      return `- ${namespace}: ${capability.description}`;
    })
    .join("\n");
}

function getSkillsSummary(session: LocalSession): string {
  return getAvailableSkills(session)
    .map((skill) => `${skill.name} (${skill.path})`)
    .join("; ");
}

export async function generateInstructions(session: LocalSession): Promise<string> {
  const capabilities = getCapabilitiesXml(session);
  const skills = getSkillsXml(session);
  const workspaceInstructions = session.buildResult.metadata.tokenspaceMd;

  return `\
# How to use this TokenSpace

- Your main tools to fulfill user requests are "runCode", which executes TypeScript code in the runtime environment and "bash", which executes bash commands in the runtime environment.
- Before generating TypeScript, call \`readFile\` on \`/sandbox/builtins.d.ts\` when you need builtins. It documents the exact built-in globals for session state, filesystem access, approvals, user info, and bash.
- Use type declarations in \`capabilities/*.d.ts\` to understand the available tools and their arguments
- Capability APIs are exposed as namespace globals (for example \`github.createIssue({...})\`), not flat top-level functions.
- You can chain multiple tool calls into efficient code blocks

Here is a list of all capabilities in this tokenspace:
<available_capabilities>
${capabilities}
</available_capabilities>

When you have a task matching a capability, immediately call the \`readFile\` tool to read the appropriate CAPABILITY.md file and follow its instructions.

Similarly, here is a list of skills in the tokenspace:

<available_skills>
${skills}
</available_skills>

When you have a task matching a skill, immediately call the \`readFile\` tool to read the appropriate SKILL.md file and follow its instructions.

# Filesystem

You have access to a virtual filesystem mounted at \`/sandbox\`, which contains files that can help you fulfill your requests:
- \`builtins.d.ts\` documents the built-in globals for session state, filesystem access, approvals, user info, and bash helpers. Read it before writing code that uses builtins or when you need exact method names.
- Type declarations for all APIs available to you in capabilities/*.d.ts
- Docs for integrations and systems in docs/*.md (try to read information about systems before interacting with them)
- Skills in skills/** (tokenspace-provided) and system/skills/** (platform-provided). Skills are folders containing a SKILL.md with focused instructions. When a task matches a skill, read its SKILL.md and follow its guidance.
- You can write to the filesystem, and changes are scoped to your current session. They won't affect other sessions or the base revision filesystem.
- You have access to a \`bash\` tool that lets you execute bash commands in a virtual shell environment.
- Use this filesystem to write notes, state, and artifacts that should persist across conversation turns.

# Guardrails and Approvals

Some actions you can call via typescript functions require approval.
Type definitions comments may contain "@APPROVAL_REQUIRED" to indicate that an action requires approval.
Functions with the annotations may not always require approval, depending on the parameters passed to them.
If an action requires approval, an exception will be thrown with errorType "APPROVAL_REQUIRED" containing the required approval details and the execution of the typescript code will be halted.
You can then call the \`requestApproval\` tool to obtain the approval from the user.
Once the user approves, you can retry the code execution and it will succeed.${
    workspaceInstructions
      ? `\

# Workspace Instructions

The workspace includes additional instructions in \`TOKENSPACE.md\`. Treat them as workspace-specific guidance.

<workspace_instructions>
${workspaceInstructions}
</workspace_instructions>`
      : ""
  }
`;
}

export async function generateRunCodeDescription(session: LocalSession): Promise<string> {
  const capabilitySummary = getCapabilitiesSummary(session);
  const capabilityList = getCapabilitiesList(session);
  const skillsSummary = getSkillsSummary(session);

  return [
    "Execute TypeScript against the current Tokenspace workspace and session sandbox.",
    "Before generating code that uses builtins, read /sandbox/builtins.d.ts with readFile. It documents builtins for session state, filesystem access, approvals, user info, and bash helpers.",
    "Capability APIs are exposed as namespace globals, not flat functions.",
    capabilitySummary ? `Available capability namespaces: ${capabilitySummary}.` : undefined,
    capabilityList ? `Available capabilities:\n${capabilityList}` : undefined,
    "Use readFile to inspect /sandbox/capabilities/*/CAPABILITY.md and capability.d.ts before using unfamiliar APIs.",
    "The virtual filesystem is rooted at /sandbox and includes capabilities/, docs/, skills/, system/skills/, TOKENSPACE.md, and session-persistent writable files.",
    skillsSummary
      ? `Available skills: ${skillsSummary}. Read matching SKILL.md files with readFile before proceeding.`
      : undefined,
    "If execution needs approval or credentials, the tool returns structured errors and the local control UI can approve or configure them.",
    'Use the "system-instructions" prompt for the full filesystem and skill guidance if the client does not honor server instructions.',
  ]
    .filter((line): line is string => Boolean(line))
    .join(" ");
}

export async function generateSystemInstructionsPrompt(session: LocalSession): Promise<string> {
  const skills = getAvailableSkills(session)
    .map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`)
    .join("\n");

  return `\
# Tokenspace System Instructions

## Main Tool

- Use \`runCode\` for most workspace tasks. It executes TypeScript against the current Tokenspace runtime.
- Before generating TypeScript that relies on builtins, read \`/sandbox/builtins.d.ts\` with \`readFile\`. It documents builtins for session state, filesystem access, approvals, user info, and bash helpers.
- Capability APIs are exposed as namespace globals like \`github.createIssue({...})\`.
- Before using an unfamiliar capability, read its \`CAPABILITY.md\` and \`capability.d.ts\` from \`/sandbox/capabilities/**\` with \`readFile\`.

## Filesystem

- The runtime filesystem is virtual and rooted at \`/sandbox\`.
- It contains type declarations in \`capabilities/**\`, docs in \`docs/**\`, workspace skills in \`skills/**\`, platform skills in \`system/skills/**\`, and workspace guidance in \`TOKENSPACE.md\` when present.
- Files you write under \`/sandbox\` persist for the life of the current local MCP session only.
- \`readFile\` and \`writeFile\` operate on this virtual filesystem, not your host machine.
- \`bash\` also runs inside this sandboxed filesystem.

## Skills

${skills || "- No skills are currently advertised for this workspace."}

## Approvals And Credentials

- Some actions require approval and will fail with \`APPROVAL_REQUIRED\`. Use \`requestApproval\`, then retry after a human approves in the local control UI.
- Missing credentials return structured credential errors. Configure secrets in the local control UI and retry.
- The MCP resources \`tokenspace://workspace/metadata\`, \`tokenspace://workspace/token-space-md\`, and \`tokenspace://approvals/pending\` can be read for discovery.
`;
}

export async function generateWorkspaceOverview(session: LocalSession): Promise<string> {
  const capabilities = session.buildResult.metadata.capabilities
    .map((capability) => {
      const namespace = capability.typesPath.replace(/^capabilities\/([^/]+)\/.*$/, "$1");
      return `- ${namespace}: ${capability.description} (${capability.path})`;
    })
    .join("\n");
  const skills = getAvailableSkills(session)
    .map((skill) => `- ${skill.name}: ${skill.description} (${skill.path})`)
    .join("\n");

  return `\
# Tokenspace Workspace Overview

## Main Guidance

- Prefer \`runCode\` for workspace tasks.
- Before generating TypeScript that relies on builtins, read \`/sandbox/builtins.d.ts\` with \`readFile\`.
- Capability APIs are namespace globals such as \`github.createIssue({...})\`.
- Before using a capability, read its \`CAPABILITY.md\` and \`capability.d.ts\` with \`readFile\`.
- If the client did not load MCP server instructions automatically, use this overview as your bootstrap context.

## Capabilities

${capabilities || "- No capabilities are currently advertised for this workspace."}

## Filesystem

- All file access is scoped to the virtual filesystem at \`/sandbox\`.
- Use \`readFile\` and \`writeFile\` for sandbox files only.
- The sandbox includes \`capabilities/**\`, \`docs/**\`, \`skills/**\`, \`system/skills/**\`, and \`TOKENSPACE.md\` when present.
- Files written to \`/sandbox\` persist only for the current local MCP session.

## Skills

${skills || "- No skills are currently advertised for this workspace."}

## Discovery

- Read \`tokenspace://workspace/metadata\` for structured workspace metadata.
- Read \`tokenspace://workspace/token-space-md\` when present for workspace instructions.
- Read \`tokenspace://approvals/pending\` for pending approval requests.

## Approvals And Credentials

- Approval-required actions fail with \`APPROVAL_REQUIRED\`; call \`requestApproval\` and retry after approval.
- Missing credentials return structured credential errors; open the local control UI URL in the error payload to configure them.
`;
}
