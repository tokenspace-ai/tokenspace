import { v } from "convex/values";
import YAML from "yaml";

export type WorkspaceModelDefinition = {
  id?: string;
  modelId: string;
  label?: string;
  isDefault: boolean;
  systemPrompt?: string;
  providerOptions?: Record<string, unknown>;
};

export type CapabilitySummary = {
  path: string;
  typesPath: string;
  name: string;
  description: string;
};

export type SkillSummary = {
  path: string;
  name: string;
  description: string;
};

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

export const vWorkspaceModelDefinition = v.object({
  id: v.optional(v.string()),
  modelId: v.string(),
  label: v.optional(v.string()),
  isDefault: v.boolean(),
  systemPrompt: v.optional(v.string()),
  providerOptions: v.optional(v.any()),
});

export const vCapabilitySummary = v.object({
  path: v.string(),
  typesPath: v.string(),
  name: v.string(),
  description: v.string(),
});

export const vSkillSummary = v.object({
  path: v.string(),
  name: v.string(),
  description: v.string(),
});

export const vCredentialRequirementSummary = v.object({
  path: v.string(),
  exportName: v.string(),
  id: v.string(),
  label: v.optional(v.string()),
  group: v.optional(v.string()),
  kind: v.union(v.literal("secret"), v.literal("env"), v.literal("oauth")),
  scope: v.union(v.literal("workspace"), v.literal("session"), v.literal("user")),
  description: v.optional(v.string()),
  iconPath: v.optional(v.string()),
  placeholder: v.optional(v.string()),
  optional: v.optional(v.boolean()),
  fallback: v.optional(v.string()),
  config: v.optional(v.any()),
});

export const DEFAULT_MODELS: WorkspaceModelDefinition[] = [
  { isDefault: true, modelId: "anthropic/claude-haiku-4.5" },
  { isDefault: false, modelId: "anthropic/claude-opus-4.6" },
  { isDefault: false, modelId: "google/gemini-3-pro-preview" },
];

export function getDefaultWorkspaceModels(): WorkspaceModelDefinition[] {
  return DEFAULT_MODELS.map((model) => ({ ...model }));
}

function readYamlFrontmatter(content: string): unknown | null {
  const normalized = content.replace(/\r\n/g, "\n").replace(/^\uFEFF/, "");
  if (!normalized.startsWith("---\n")) {
    return null;
  }

  const lines = normalized.split("\n");
  if (lines[0]?.trim() !== "---") {
    return null;
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (line === "---" || line === "...") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return null;
  }

  const frontmatterYaml = lines.slice(1, endIndex).join("\n");
  if (!frontmatterYaml.trim()) {
    return null;
  }

  try {
    return YAML.parse(frontmatterYaml);
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeJsonValue(value: unknown, source: string): unknown {
  if (value === null) {
    return null;
  }
  if (typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new Error(`${source} contains a non-finite number`);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item, index) => normalizeJsonValue(item, `${source}[${index}]`));
  }
  if (isRecord(value)) {
    const next: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value)) {
      next[key] = normalizeJsonValue(entry, `${source}.${key}`);
    }
    return next;
  }
  throw new Error(`${source} must contain only JSON-compatible values`);
}

function normalizeProviderOptions(
  providerOptions: unknown,
  source: string,
  modelIdentifier: string,
): Record<string, unknown> | undefined {
  if (providerOptions === undefined || providerOptions === null) {
    return undefined;
  }
  if (!isRecord(providerOptions)) {
    throw new Error(`${source} entry "${modelIdentifier}" has an invalid providerOptions object`);
  }
  return normalizeJsonValue(providerOptions, `${source} entry "${modelIdentifier}".providerOptions`) as Record<
    string,
    unknown
  >;
}

function parseNamedDescriptionFrontmatter(content: string): { name: string; description: string } | null {
  const parsed = readYamlFrontmatter(content);
  if (!isRecord(parsed)) {
    return null;
  }

  const name = parsed.name;
  const description = parsed.description;

  if (typeof name !== "string" || typeof description !== "string") {
    return null;
  }

  const trimmedName = name.trim();
  const trimmedDescription = description.trim();

  if (!trimmedName || !trimmedDescription) {
    return null;
  }

  return {
    name: trimmedName,
    description: trimmedDescription,
  };
}

export function extractPromptMetadataFromEntries(entries: Array<{ path: string; content: string }>): {
  capabilities: CapabilitySummary[];
  skills: SkillSummary[];
} {
  const capabilities: CapabilitySummary[] = [];
  const skills: SkillSummary[] = [];

  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of sorted) {
    if (entry.path.startsWith("capabilities/") && entry.path.endsWith("/CAPABILITY.md")) {
      const frontmatter = parseNamedDescriptionFrontmatter(entry.content);
      if (!frontmatter) {
        continue;
      }

      capabilities.push({
        path: entry.path,
        typesPath: entry.path.replace(/CAPABILITY\.md$/, "capability.d.ts"),
        name: frontmatter.name,
        description: frontmatter.description,
      });
      continue;
    }

    if (
      (entry.path.startsWith("skills/") || entry.path.startsWith("system/skills/")) &&
      entry.path.endsWith("/SKILL.md")
    ) {
      const frontmatter = parseNamedDescriptionFrontmatter(entry.content);
      if (!frontmatter) {
        continue;
      }

      skills.push({
        path: entry.path,
        name: frontmatter.name,
        description: frontmatter.description,
      });
    }
  }

  return { capabilities, skills };
}

function validateModels(models: WorkspaceModelDefinition[], source: string): WorkspaceModelDefinition[] {
  if (!Array.isArray(models)) {
    throw new Error(`${source} must contain an array of model definitions`);
  }

  const normalized = models.map((model, index) => {
    if (!model || typeof model !== "object") {
      throw new Error(`${source} entry at index ${index} must be an object`);
    }

    const modelId = typeof model.modelId === "string" ? model.modelId.trim() : "";
    if (!modelId) {
      throw new Error(`${source} entry at index ${index} is missing a non-empty modelId`);
    }
    const id = typeof model.id === "string" ? model.id.trim() : modelId;
    if (!id) {
      throw new Error(`${source} entry "${modelId}" is missing a non-empty id`);
    }

    const isDefault = model.isDefault === undefined ? false : model.isDefault;
    if (typeof isDefault !== "boolean") {
      throw new Error(`${source} entry "${id}" must set isDefault to true or false`);
    }

    const normalizedModel: WorkspaceModelDefinition = {
      id,
      modelId,
      isDefault,
    };

    if (model.label !== undefined) {
      if (typeof model.label !== "string") {
        throw new Error(`${source} entry "${id}" has an invalid label`);
      }
      const label = model.label.trim();
      if (label) {
        normalizedModel.label = label;
      }
    }

    if (model.systemPrompt !== undefined) {
      if (typeof model.systemPrompt !== "string") {
        throw new Error(`${source} entry "${id}" has an invalid systemPrompt`);
      }
      const systemPrompt = model.systemPrompt.trim();
      if (systemPrompt) {
        normalizedModel.systemPrompt = systemPrompt;
      }
    }

    const providerOptions = normalizeProviderOptions(model.providerOptions, source, id);
    if (providerOptions) {
      normalizedModel.providerOptions = providerOptions;
    }

    return normalizedModel;
  });

  if (normalized.length === 0) {
    throw new Error(`${source} must contain at least one model`);
  }

  const ids = new Set<string>();
  for (const model of normalized) {
    const id = model.id ?? model.modelId;
    if (ids.has(id)) {
      throw new Error(`${source} contains duplicate id "${id}"`);
    }
    ids.add(id);
  }

  const defaultCount = normalized.filter((model) => model.isDefault).length;
  if (defaultCount !== 1) {
    throw new Error(`${source} must contain exactly one default model (isDefault: true)`);
  }

  return normalized;
}

export function parseWorkspaceModelsYaml(content: string, source = "src/models.yaml"): WorkspaceModelDefinition[] {
  let parsed: unknown;
  try {
    parsed = YAML.parse(content);
  } catch (error) {
    const details = error instanceof Error ? error.message : String(error);
    throw new Error(`${source} is not valid YAML: ${details}`);
  }

  const rawModels = Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.models)
      ? parsed.models
      : undefined;

  if (!rawModels) {
    throw new Error(`${source} must contain a top-level "models" array or be an array itself`);
  }

  return validateModels(rawModels as WorkspaceModelDefinition[], source);
}

export function ensureValidWorkspaceModels(
  models: WorkspaceModelDefinition[],
  source = "workspace model configuration",
): WorkspaceModelDefinition[] {
  return validateModels(models, source);
}

export function serializeWorkspaceModelsYaml(models: WorkspaceModelDefinition[]): string {
  const normalized = ensureValidWorkspaceModels(models);
  const yaml = YAML.stringify({ models: normalized }, { lineWidth: 0 });
  return `${yaml.trimEnd()}\n`;
}

export function resolveDefaultModel(models: WorkspaceModelDefinition[]): WorkspaceModelDefinition | null {
  return models.find((model) => model.isDefault) ?? null;
}

export function getWorkspaceModelId(model: Pick<WorkspaceModelDefinition, "id" | "modelId">): string {
  const id = typeof model.id === "string" ? model.id.trim() : "";
  return id || model.modelId;
}

export function resolveWorkspaceModelSelection(
  models: WorkspaceModelDefinition[],
  selectedModelId: string,
): WorkspaceModelDefinition | null {
  const normalizedSelection = selectedModelId.trim();
  if (!normalizedSelection) {
    return null;
  }

  return (
    models.find((model) => getWorkspaceModelId(model) === normalizedSelection) ??
    models.find((model) => model.modelId === normalizedSelection) ??
    null
  );
}
