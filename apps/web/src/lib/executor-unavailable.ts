export type ExecutorUnavailablePayload = {
  errorType: "EXECUTOR_UNAVAILABLE";
  reason: "unassigned_executor" | "no_healthy_instance";
  workspaceId: string;
  executorId?: string;
};

export function parseExecutorUnavailablePayload(data: unknown): ExecutorUnavailablePayload | null {
  if (!data || typeof data !== "object" || Array.isArray(data)) return null;
  const maybe = data as Partial<ExecutorUnavailablePayload>;
  if (maybe.errorType !== "EXECUTOR_UNAVAILABLE") return null;
  if (
    (maybe.reason !== "unassigned_executor" && maybe.reason !== "no_healthy_instance") ||
    typeof maybe.workspaceId !== "string" ||
    (maybe.executorId !== undefined && typeof maybe.executorId !== "string")
  ) {
    return null;
  }

  return {
    errorType: "EXECUTOR_UNAVAILABLE",
    reason: maybe.reason,
    workspaceId: maybe.workspaceId,
    executorId: maybe.executorId,
  };
}

export function buildExecutorSettingsPath(workspaceSlug: string): string {
  return `/workspace/${workspaceSlug}/admin/executor`;
}

export function executorUnavailableTitle(payload: ExecutorUnavailablePayload): string {
  return payload.reason === "unassigned_executor" ? "Executor not configured" : "Assigned executor is offline";
}

export function executorUnavailableHint(
  payload: ExecutorUnavailablePayload,
  options?: { workspaceSlug?: string; retryLabel?: string },
): string {
  const retryLabel = options?.retryLabel ?? "try again";
  const destination = options?.workspaceSlug
    ? `Open ${buildExecutorSettingsPath(options.workspaceSlug)}`
    : "Open Settings -> Executor";

  if (payload.reason === "unassigned_executor") {
    return `${destination}, assign a workspace executor, then ${retryLabel}.`;
  }

  return `${destination}, start a healthy executor instance, then ${retryLabel}.`;
}
