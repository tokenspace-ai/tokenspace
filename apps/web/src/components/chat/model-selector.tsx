import { useQuery } from "@tanstack/react-query";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAction, useQuery as useConvexQuery } from "convex/react";
import { BotIcon, CheckIcon, ChevronDownIcon } from "lucide-react";
import { useCallback, useMemo, useState } from "react";
import {
  ModelSelector,
  ModelSelectorContent,
  ModelSelectorEmpty,
  ModelSelectorGroup,
  ModelSelectorInput,
  ModelSelectorItem,
  ModelSelectorList,
  ModelSelectorLogo,
  ModelSelectorName,
  ModelSelectorTrigger,
} from "@/components/ai-elements/model-selector";
import { Button } from "../ui/button";

function useAvailableModels() {
  const getAvailableModels = useAction(api.ai.chat.getAvailableModels);
  const { data: availableModels } = useQuery({
    queryKey: ["availableModels"],
    queryFn: () => getAvailableModels({}),
  });
  return availableModels;
}

type ConnectedModelSelectorProps = {
  currentModelId: string;
  onModelSelect: (modelId: string) => void;
  revisionId?: Id<"revisions">;
};

const ignoredProviders = new Set(["azure"]);

function getConfiguredModelId(model: { id?: string; modelId: string }): string {
  const id = model.id?.trim();
  return id || model.modelId;
}

export function ConnectedModelSelector({ currentModelId, onModelSelect, revisionId }: ConnectedModelSelectorProps) {
  const [modelSelectorOpen, setModelSelectorOpen] = useState(false);
  const availableModels = useAvailableModels();
  const workspaceModels = useConvexQuery(api.workspace.getModelsForRevision, revisionId ? { revisionId } : "skip");

  const languageModels = useMemo(
    () =>
      availableModels?.filter(
        (model) => model.modelType === "language" && !ignoredProviders.has(model.specification.provider),
      ),
    [availableModels],
  );

  const workspaceConfiguredModels = useMemo(() => {
    if (!workspaceModels || workspaceModels.length === 0) {
      return null;
    }

    return workspaceModels.map((model) => {
      const configId = getConfiguredModelId(model);
      const details = availableModels?.find((availableModel) => availableModel.id === model.modelId);
      return {
        ...model,
        configId,
        details,
        title: model.label ?? details?.name ?? model.modelId,
      };
    });
  }, [workspaceModels, availableModels]);

  const hasWorkspaceConfiguredModels = !!workspaceConfiguredModels && workspaceConfiguredModels.length > 0;

  const filteredModels = useMemo(() => {
    if (!languageModels) {
      return undefined;
    }
    if (!hasWorkspaceConfiguredModels) {
      return languageModels;
    }

    const configuredModelIds = new Set(workspaceConfiguredModels.map((model) => model.modelId));
    return languageModels.filter(
      (model) =>
        configuredModelIds.has(model.id) || (typeof model.id === "string" && model.id.startsWith("mock:replay:")),
    );
  }, [languageModels, hasWorkspaceConfiguredModels, workspaceConfiguredModels]);

  const currentWorkspaceModel = useMemo(() => {
    if (!workspaceConfiguredModels) {
      return null;
    }
    return (
      workspaceConfiguredModels.find((model) => model.configId === currentModelId) ??
      workspaceConfiguredModels.find((model) => model.modelId === currentModelId) ??
      null
    );
  }, [workspaceConfiguredModels, currentModelId]);

  const currentModel = useMemo(() => {
    if (currentWorkspaceModel) {
      return currentWorkspaceModel;
    }
    return availableModels?.find((model) => model.id === currentModelId) ?? null;
  }, [currentWorkspaceModel, availableModels, currentModelId]);

  const providers = useMemo(
    () => [
      ...new Set(["anthropic", "google", "openai", ...(filteredModels?.map((m) => m.specification.provider) ?? [])]),
    ],
    [filteredModels],
  );

  const handleModelSelect = useCallback((modelId: string) => {
    onModelSelect(modelId);
    setModelSelectorOpen(false);
  }, []);

  return (
    <ModelSelector open={modelSelectorOpen} onOpenChange={setModelSelectorOpen}>
      <ModelSelectorTrigger asChild>
        <Button
          variant="ghost"
          size="sm"
          className="h-8 gap-2 px-2 text-xs font-medium text-muted-foreground hover:text-foreground"
        >
          {currentWorkspaceModel?.details ? (
            <ModelSelectorLogo provider={currentWorkspaceModel.details.specification.provider} className="size-4" />
          ) : currentModel && "specification" in currentModel ? (
            <ModelSelectorLogo provider={currentModel.specification.provider} className="size-4" />
          ) : (
            <BotIcon className="size-4" />
          )}
          <span>
            {currentWorkspaceModel?.title ??
              (currentModel && "name" in currentModel ? currentModel.name : "Select model")}
          </span>
          <ChevronDownIcon className="size-3 opacity-50" />
        </Button>
      </ModelSelectorTrigger>
      <ModelSelectorContent>
        <ModelSelectorInput placeholder="Search models..." />
        <ModelSelectorList>
          <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>

          {hasWorkspaceConfiguredModels ? (
            <ModelSelectorGroup heading="Tokenspace Models">
              {workspaceConfiguredModels.map((model) => (
                <ModelSelectorItem
                  key={model.configId}
                  value={model.configId}
                  onSelect={() => handleModelSelect(model.configId)}
                  className="flex items-center gap-3"
                >
                  {model.details?.specification?.provider ? (
                    <ModelSelectorLogo provider={model.details.specification.provider} className="size-8 shrink-0" />
                  ) : (
                    <BotIcon className="size-8 shrink-0" />
                  )}
                  <div className="flex flex-1 flex-col gap-0.5">
                    <ModelSelectorName>{model.title}</ModelSelectorName>
                    <span className="line-clamp-2 text-xs text-muted-foreground">
                      {model.configId !== model.modelId ? `${model.configId} · ` : ""}
                      {model.modelId}
                      {model.details?.pricing ? <ModelPricing pricing={model.details.pricing} /> : null}
                    </span>
                  </div>
                  {(currentModelId === model.configId || currentModelId === model.modelId) && (
                    <CheckIcon className="size-4 text-primary" />
                  )}
                </ModelSelectorItem>
              ))}
            </ModelSelectorGroup>
          ) : (
            providers.map((provider) => {
              const providerModels = filteredModels?.filter((model) => model.specification.provider === provider);

              if (!providerModels?.length) {
                return null;
              }

              return (
                <ModelSelectorGroup key={provider} heading={provider}>
                  {providerModels.map((model) => (
                    <ModelSelectorItem
                      key={model.id}
                      value={model.id}
                      onSelect={() => handleModelSelect(model.id)}
                      className="flex items-center gap-3"
                    >
                      <ModelSelectorLogo provider={model.specification.provider} className="size-8 shrink-0" />
                      <div className="flex flex-1 flex-col gap-0.5">
                        <ModelSelectorName>{model.name}</ModelSelectorName>
                        <span className="line-clamp-2 text-xs text-muted-foreground">
                          {model.id} {model.pricing ? <ModelPricing pricing={model.pricing} /> : null}
                        </span>
                      </div>
                      {currentModelId === model.id && <CheckIcon className="size-4 text-primary" />}
                    </ModelSelectorItem>
                  ))}
                </ModelSelectorGroup>
              );
            })
          )}
        </ModelSelectorList>
      </ModelSelectorContent>
    </ModelSelector>
  );
}

const numberFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

function ModelPricing({
  pricing,
}: {
  pricing: {
    input: string;
    output: string;
    cachedInputTokens?: string;
    cacheCreationInputTokens?: string;
  };
}) {
  const input = Number.parseFloat(pricing.input) * 1_000_000;
  const output = Number.parseFloat(pricing.output) * 1_000_000;
  return (
    <span>
      &bull; {numberFormatter.format(input)} / {numberFormatter.format(output)}
    </span>
  );
}
