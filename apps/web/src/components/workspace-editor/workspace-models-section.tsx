import { useQuery } from "@tanstack/react-query";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { gateway } from "ai";
import { useMutation } from "convex/react";
import { Star, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { toast } from "sonner";
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
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

interface WorkspaceModel {
  id?: string;
  modelId: string;
  label?: string;
  isDefault: boolean;
  systemPrompt?: string;
  providerOptions?: Record<string, unknown>;
}

interface WorkspaceModelsSectionProps {
  workspaceId: Id<"workspaces">;
  branchId: Id<"branches">;
  models: WorkspaceModel[];
  onSaved?: () => void;
}

function useAvailableModels() {
  const { data: availableModels } = useQuery({
    queryKey: ["availableModels", "gateway"],
    queryFn: () => gateway.getAvailableModels(),
    select: (data) => data.models,
  });
  return availableModels;
}

function getConfiguredModelId(model: Pick<WorkspaceModel, "id" | "modelId">): string {
  const id = model.id?.trim();
  return id || model.modelId;
}

function formatProviderOptions(providerOptions?: Record<string, unknown>): string {
  if (!providerOptions) {
    return "";
  }
  return JSON.stringify(providerOptions, null, 2);
}

function parseProviderOptionsJson(rawValue: string): { providerOptions?: Record<string, unknown>; error?: string } {
  const trimmed = rawValue.trim();
  if (!trimmed) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      error:
        error instanceof Error
          ? `Provider options must be valid JSON: ${error.message}`
          : "Provider options must be valid JSON",
    };
  }

  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return {
      error: "Provider options must be a JSON object",
    };
  }

  return {
    providerOptions: parsed as Record<string, unknown>,
  };
}

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
  const numberFormatter = new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const input = Number.parseFloat(pricing.input) * 1_000_000;
  const output = Number.parseFloat(pricing.output) * 1_000_000;
  return (
    <span>
      &bull; {numberFormatter.format(input)} / {numberFormatter.format(output)}
    </span>
  );
}

export function WorkspaceModelsSection({ workspaceId, branchId, models, onSaved }: WorkspaceModelsSectionProps) {
  const availableModels = useAvailableModels();
  const [isAddModelSelectorOpen, setIsAddModelSelectorOpen] = useState(false);
  const [addingModelId, setAddingModelId] = useState<string | null>(null);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [draftId, setDraftId] = useState("");
  const [draftLabel, setDraftLabel] = useState("");
  const [draftSystemPrompt, setDraftSystemPrompt] = useState("");
  const [draftProviderOptionsJson, setDraftProviderOptionsJson] = useState("");
  const [configuredModelDefs, setConfiguredModelDefs] = useState<WorkspaceModel[]>(models);

  useEffect(() => {
    setConfiguredModelDefs(models);
  }, [models]);

  const addModel = useMutation(api.workspace.addModel);
  const removeModel = useMutation(api.workspace.removeModel);
  const updateModel = useMutation(api.workspace.updateModel);
  const setDefaultModel = useMutation(api.workspace.setDefaultModel);

  const modelMap = useMemo(() => {
    const map = new Map(availableModels?.map((m) => [m.id, m]) ?? []);
    return map;
  }, [availableModels]);

  const configuredModels = useMemo(
    () =>
      configuredModelDefs.map((model) => ({
        ...model,
        configId: getConfiguredModelId(model),
        details: modelMap.get(model.modelId),
      })),
    [configuredModelDefs, modelMap],
  );

  const editingModel = useMemo(
    () => configuredModels.find((model) => model.configId === editingModelId) ?? null,
    [configuredModels, editingModelId],
  );

  const addingModelDetails = useMemo(() => {
    if (!addingModelId) {
      return null;
    }
    return modelMap.get(addingModelId) ?? null;
  }, [addingModelId, modelMap]);

  const resetDraft = useCallback(() => {
    setDraftId("");
    setDraftLabel("");
    setDraftSystemPrompt("");
    setDraftProviderOptionsJson("");
  }, []);

  const closeAddDialog = useCallback(() => {
    setAddingModelId(null);
    resetDraft();
  }, [resetDraft]);

  const closeEditDialog = useCallback(() => {
    setEditingModelId(null);
    resetDraft();
  }, [resetDraft]);

  const handleModelSelectForAdd = useCallback((modelId: string) => {
    setIsAddModelSelectorOpen(false);
    setAddingModelId(modelId);
    setDraftId(modelId);
    setDraftLabel("");
    setDraftSystemPrompt("");
    setDraftProviderOptionsJson("");
  }, []);

  const handleConfirmAddModel = useCallback(async () => {
    if (!addingModelId) {
      return;
    }

    const parsedProviderOptions = parseProviderOptionsJson(draftProviderOptionsJson);
    if (parsedProviderOptions.error) {
      toast.error(parsedProviderOptions.error);
      return;
    }

    try {
      const updated = await addModel({
        workspaceId,
        branchId,
        modelId: addingModelId,
        id: draftId.trim() || addingModelId,
        label: draftLabel.trim() || undefined,
        isDefault: configuredModelDefs.length === 0,
        systemPrompt: draftSystemPrompt.trim() || undefined,
        providerOptions: parsedProviderOptions.providerOptions,
      });
      setConfiguredModelDefs(updated);
      onSaved?.();
      toast.success("Model added");
      closeAddDialog();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to add model");
      console.error(error);
    }
  }, [
    addingModelId,
    addModel,
    workspaceId,
    branchId,
    draftId,
    draftLabel,
    configuredModelDefs.length,
    draftSystemPrompt,
    draftProviderOptionsJson,
    onSaved,
    closeAddDialog,
  ]);

  const handleRemoveModel = useCallback(
    async (id: string) => {
      try {
        const updated = await removeModel({
          workspaceId,
          branchId,
          id,
        });
        setConfiguredModelDefs(updated);
        onSaved?.();
        toast.success("Model removed");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to remove model");
        console.error(error);
      }
    },
    [removeModel, workspaceId, branchId, onSaved],
  );

  const handleSetDefault = useCallback(
    async (id: string) => {
      try {
        const updated = await setDefaultModel({
          workspaceId,
          branchId,
          id,
        });
        setConfiguredModelDefs(updated);
        onSaved?.();
        toast.success("Default model updated");
      } catch (error) {
        toast.error(error instanceof Error ? error.message : "Failed to update default model");
        console.error(error);
      }
    },
    [setDefaultModel, workspaceId, branchId, onSaved],
  );

  const handleEditClick = useCallback((model: WorkspaceModel) => {
    const configId = getConfiguredModelId(model);
    setEditingModelId(configId);
    setDraftId(configId);
    setDraftLabel(model.label ?? "");
    setDraftSystemPrompt(model.systemPrompt ?? "");
    setDraftProviderOptionsJson(formatProviderOptions(model.providerOptions));
  }, []);

  const handleUpdateModel = useCallback(async () => {
    if (!editingModelId || !editingModel) {
      return;
    }

    const parsedProviderOptions = parseProviderOptionsJson(draftProviderOptionsJson);
    if (parsedProviderOptions.error) {
      toast.error(parsedProviderOptions.error);
      return;
    }

    try {
      const updated = await updateModel({
        workspaceId,
        branchId,
        id: editingModelId,
        nextId: draftId,
        label: draftLabel,
        systemPrompt: draftSystemPrompt,
        providerOptions: parsedProviderOptions.providerOptions ?? null,
      });
      setConfiguredModelDefs(updated);
      onSaved?.();
      toast.success("Model updated");
      closeEditDialog();
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to update model");
      console.error(error);
    }
  }, [
    editingModelId,
    editingModel,
    draftProviderOptionsJson,
    updateModel,
    workspaceId,
    branchId,
    draftId,
    draftLabel,
    draftSystemPrompt,
    onSaved,
    closeEditDialog,
  ]);

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-medium text-foreground">Models</h3>
        <ModelSelector open={isAddModelSelectorOpen} onOpenChange={setIsAddModelSelectorOpen}>
          <ModelSelectorTrigger asChild>
            <Button variant="outline" size="sm">
              Add Model
            </Button>
          </ModelSelectorTrigger>
          <ModelSelectorContent>
            <ModelSelectorInput placeholder="Search models..." />
            <ModelSelectorList>
              <ModelSelectorEmpty>No models found.</ModelSelectorEmpty>
              {availableModels && availableModels.length > 0 && (
                <ModelSelectorGroup key="all" heading="All Models">
                  {availableModels.map((model) => (
                    <ModelSelectorItem
                      key={model.id}
                      value={model.id}
                      onSelect={() => handleModelSelectForAdd(model.id)}
                      className="flex items-center gap-3"
                    >
                      <ModelSelectorLogo provider={model.specification.provider} className="size-6 shrink-0" />
                      <div className="flex flex-1 flex-col gap-0.5">
                        <ModelSelectorName>{model.name}</ModelSelectorName>
                        <span className="text-xs text-muted-foreground line-clamp-1">
                          {model.id} {model.pricing ? <ModelPricing pricing={model.pricing} /> : null}
                        </span>
                      </div>
                    </ModelSelectorItem>
                  ))}
                </ModelSelectorGroup>
              )}
            </ModelSelectorList>
          </ModelSelectorContent>
        </ModelSelector>
      </div>

      {configuredModels.length === 0 ? (
        <div className="rounded-lg border border-dashed p-6 text-center">
          <p className="text-sm text-muted-foreground">No models configured yet</p>
        </div>
      ) : (
        <div className="space-y-2">
          {configuredModels.map((model) => {
            const title = model.label ?? model.details?.name ?? model.modelId;
            const hasProviderOptions = !!model.providerOptions && Object.keys(model.providerOptions).length > 0;

            return (
              <div key={model.configId} className="flex items-start gap-3 rounded-lg border p-3">
                <div className="flex flex-1 flex-col gap-2">
                  <div className="flex items-center gap-2">
                    {model.details?.specification?.provider && (
                      <ModelSelectorLogo provider={model.details.specification.provider} className="size-4" />
                    )}
                    <span className="text-sm font-medium">{title}</span>
                    {model.isDefault && <Star className="ml-auto size-4 fill-yellow-500 text-yellow-500" />}
                  </div>
                  {model.label && (
                    <span className="text-xs text-muted-foreground">
                      Base model: {model.details?.name ?? model.modelId}
                    </span>
                  )}
                  <span className="text-xs text-muted-foreground">
                    {model.modelId}
                    {model.details?.pricing ? <ModelPricing pricing={model.details.pricing} /> : null}
                  </span>
                  {model.configId !== model.modelId && (
                    <span className="text-xs text-muted-foreground">ID: {model.configId}</span>
                  )}
                  {hasProviderOptions && (
                    <span className="text-xs text-muted-foreground">Provider options override configured</span>
                  )}
                  {model.systemPrompt && (
                    <p className="line-clamp-2 text-xs text-muted-foreground">{model.systemPrompt}</p>
                  )}
                </div>

                <div className="flex items-center gap-1">
                  {!model.isDefault && (
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => handleSetDefault(model.configId)}
                      title="Set as default"
                    >
                      <Star className="size-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleEditClick(model)}
                    title="Edit model configuration"
                  >
                    Edit
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => handleRemoveModel(model.configId)}
                    title="Remove model"
                  >
                    <Trash2 className="size-4 text-destructive" />
                  </Button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <Dialog open={addingModelId !== null} onOpenChange={(open) => !open && closeAddDialog()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Add Model</DialogTitle>
            <DialogDescription>Configure this model entry before adding it to the tokenspace.</DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            {addingModelId && (
              <div className="rounded-lg border p-3 text-sm">
                <div className="flex items-center gap-2">
                  {addingModelDetails?.specification?.provider && (
                    <ModelSelectorLogo provider={addingModelDetails.specification.provider} className="size-4" />
                  )}
                  <span className="font-medium">{addingModelDetails?.name ?? addingModelId}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">{addingModelId}</p>
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="add-model-id">ID</Label>
              <Input
                id="add-model-id"
                placeholder={addingModelId ?? ""}
                value={draftId}
                onChange={(event) => setDraftId(event.target.value)}
              />
              <p className="text-xs text-muted-foreground">Unique tokenspace identifier. Defaults to the model ID.</p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="add-model-label">Label (optional)</Label>
              <Input
                id="add-model-label"
                placeholder={addingModelDetails?.name ?? addingModelId ?? ""}
                value={draftLabel}
                onChange={(event) => setDraftLabel(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="add-system-prompt">System Prompt (optional)</Label>
              <Textarea
                id="add-system-prompt"
                placeholder="Add an additional system prompt to append to the base system prompt..."
                value={draftSystemPrompt}
                onChange={(event) => setDraftSystemPrompt(event.target.value)}
                rows={4}
                className="resize-none"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="add-provider-options">Provider Options Override (JSON, optional)</Label>
              <Textarea
                id="add-provider-options"
                placeholder={
                  '{\n  "anthropic": {\n    "thinking": {\n      "type": "enabled",\n      "budgetTokens": 2048\n    }\n  }\n}'
                }
                value={draftProviderOptionsJson}
                onChange={(event) => setDraftProviderOptionsJson(event.target.value)}
                rows={10}
                className="resize-y font-mono text-xs"
              />
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" onClick={closeAddDialog}>
                Cancel
              </Button>
            </DialogClose>
            <Button onClick={handleConfirmAddModel}>Add Model</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={editingModelId !== null} onOpenChange={(open) => !open && closeEditDialog()}>
        <DialogContent className="sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>Edit Model</DialogTitle>
            <DialogDescription>
              Update configuration for{" "}
              {editingModel?.label ?? editingModel?.details?.name ?? editingModel?.modelId ?? "this model"}.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="edit-model-id">ID</Label>
              <Input
                id="edit-model-id"
                placeholder={editingModel?.modelId ?? ""}
                value={draftId}
                onChange={(event) => setDraftId(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-model-label">Label (optional)</Label>
              <Input
                id="edit-model-label"
                placeholder={editingModel?.label ?? editingModel?.details?.name ?? editingModel?.modelId ?? ""}
                value={draftLabel}
                onChange={(event) => setDraftLabel(event.target.value)}
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-system-prompt">System Prompt (optional)</Label>
              <Textarea
                id="edit-system-prompt"
                placeholder="Add an additional system prompt to append to the base system prompt..."
                value={draftSystemPrompt}
                onChange={(event) => setDraftSystemPrompt(event.target.value)}
                rows={6}
                className="resize-none"
              />
            </div>

            <div className="space-y-2">
              <Label htmlFor="edit-provider-options">Provider Options Override (JSON, optional)</Label>
              <Textarea
                id="edit-provider-options"
                placeholder={
                  '{\n  "anthropic": {\n    "thinking": {\n      "type": "enabled",\n      "budgetTokens": 2048\n    }\n  }\n}'
                }
                value={draftProviderOptionsJson}
                onChange={(event) => setDraftProviderOptionsJson(event.target.value)}
                rows={10}
                className="resize-y font-mono text-xs"
              />
            </div>
          </div>

          <DialogFooter>
            <DialogClose asChild>
              <Button variant="outline" onClick={closeEditDialog}>
                Cancel
              </Button>
            </DialogClose>
            <Button onClick={handleUpdateModel}>Save</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
