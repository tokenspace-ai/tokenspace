import type { JSONValue, ModelMessage, SystemModelMessage } from "ai";

const ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS = {
  anthropic: {
    cacheControl: { type: "ephemeral" as const },
  },
};

const BEDROCK_PROMPT_CACHE_PROVIDER_OPTIONS = {
  bedrock: {
    cachePoint: { type: "default" as const },
  },
};

const ANTHROPIC_THINKING_BUDGET_TOKENS = 1024;

const ANTHROPIC_PROVIDER_ORDER = ["bedrock", "anthropic", "vertex"] as const;

type GatewayProviderOptions = {
  user?: string;
  tags?: string[];
  order?: string[];
  only?: string[];
};

type ProviderOptionsTarget = "request" | "prompt-cache";

type CreateProviderOptionsArgs = {
  modelId: string;
  userId?: string;
  tags?: string[];
  providerOptions?: ModelMessage["providerOptions"];
  target?: ProviderOptionsTarget;
};

export function isAnthropicModel(modelId: string): boolean {
  return modelId.startsWith("anthropic/");
}

function asProviderSection(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function getGatewayProviderOptions(modelId: string, userId?: string, tags?: string[]): Record<string, JSONValue> {
  const gatewayOptions: GatewayProviderOptions = {
    user: userId,
    tags,
  };

  if (isAnthropicModel(modelId)) {
    Object.assign(gatewayOptions, { order: [...ANTHROPIC_PROVIDER_ORDER], only: [...ANTHROPIC_PROVIDER_ORDER] });
  }

  if (modelId.startsWith("google/")) {
    Object.assign(gatewayOptions, { only: ["vertex"] });
  }

  return gatewayOptions as Record<string, JSONValue>;
}

export function createProviderOptions({
  modelId,
  userId,
  tags,
  providerOptions,
  target = "request",
}: CreateProviderOptionsArgs): NonNullable<ModelMessage["providerOptions"]> {
  const next = { ...(providerOptions ?? {}) } as Record<string, unknown>;

  if (target === "request") {
    const gatewayDefaults = getGatewayProviderOptions(modelId, userId, tags);
    const gatewayOverrides = asProviderSection(next.gateway) as Record<string, JSONValue>;
    next.gateway = {
      ...gatewayDefaults,
      ...gatewayOverrides,
    };
  }

  if (!isAnthropicModel(modelId)) {
    return next as NonNullable<ModelMessage["providerOptions"]>;
  }

  const anthropicOptions = asProviderSection(next.anthropic);
  const bedrockOptions = asProviderSection(next.bedrock);

  if (target === "prompt-cache") {
    next.anthropic = {
      ...anthropicOptions,
      cacheControl:
        (anthropicOptions.cacheControl as Record<string, unknown> | undefined) ??
        ANTHROPIC_PROMPT_CACHE_PROVIDER_OPTIONS.anthropic.cacheControl,
    };
    next.bedrock = {
      ...bedrockOptions,
      cachePoint:
        (bedrockOptions.cachePoint as Record<string, unknown> | undefined) ??
        BEDROCK_PROMPT_CACHE_PROVIDER_OPTIONS.bedrock.cachePoint,
    };
    return next as NonNullable<ModelMessage["providerOptions"]>;
  }

  next.anthropic = {
    ...anthropicOptions,
    thinking: (anthropicOptions.thinking as Record<string, unknown> | undefined) ?? {
      type: "enabled" as const,
      budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS,
    },
  };
  next.bedrock = {
    ...bedrockOptions,
    reasoningConfig: (bedrockOptions.reasoningConfig as Record<string, unknown> | undefined) ?? {
      type: "enabled" as const,
      budgetTokens: ANTHROPIC_THINKING_BUDGET_TOKENS,
    },
  };

  return next as NonNullable<ModelMessage["providerOptions"]>;
}

export function applyAnthropicDynamicPromptCaching(messages: ModelMessage[]): ModelMessage[] {
  if (messages.length === 0) return messages;
  const indexes = messages.map((_, index) => index);
  const indexesToCache = new Set([
    // Add cache points to the first two system messages
    ...indexes.filter((index) => messages[index]?.role === "system").slice(0, 2),
    // Add cache points to the last two messages
    ...indexes.slice(-2),
  ]);
  return messages.map((message, index) =>
    indexesToCache.has(index)
      ? {
          ...message,
          providerOptions: createProviderOptions({
            modelId: "anthropic/",
            providerOptions: message.providerOptions,
            target: "prompt-cache",
          }),
        }
      : message,
  );
}

export function getSystemPromptForModel(
  modelId: string,
  systemPrompt: string,
  providerOptions?: ModelMessage["providerOptions"],
): string | SystemModelMessage {
  if (!isAnthropicModel(modelId)) {
    return systemPrompt;
  }

  return {
    role: "system",
    content: systemPrompt,
    providerOptions: createProviderOptions({
      modelId,
      providerOptions,
      target: "prompt-cache",
    }),
  };
}
