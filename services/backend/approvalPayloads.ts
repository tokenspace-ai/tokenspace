function parseJsonContainerString(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  if (!(trimmed.startsWith("{") || trimmed.startsWith("["))) {
    return value;
  }

  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

export function normalizeApprovalPayload<T>(value: T): T {
  return parseJsonContainerString(value) as T;
}

export function normalizeApprovalRecord<T extends { data?: unknown }>(record: T): T {
  return {
    ...record,
    data: normalizeApprovalPayload(record.data),
  };
}

export function normalizeApprovalRequestRecord<T extends { data?: unknown; info?: unknown }>(record: T): T {
  return {
    ...record,
    data: normalizeApprovalPayload(record.data),
    info: normalizeApprovalPayload(record.info),
  };
}
