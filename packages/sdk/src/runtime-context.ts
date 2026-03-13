import { AsyncLocalStorage } from "node:async_hooks";
import type { Approval, SerializableApproval } from "./approvals";
import type { TokenspaceFilesystem } from "./builtin-types";
import type { CredentialStore } from "./credentials";
import type { UserStore } from "./users";

export type RuntimeExecutionContext = {
  credentialStore?: CredentialStore;
  userStore?: UserStore;
  approvals: Approval[];
  filesystem?: TokenspaceFilesystem;
};

const runtimeExecutionStorage = new AsyncLocalStorage<RuntimeExecutionContext>();

let fallbackCredentialStore: CredentialStore | undefined;
let fallbackUserStore: UserStore | undefined;
let fallbackApprovals: Approval[] = [];

function cloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((entry) => cloneValue(entry)) as T;
  }

  if (value != null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, cloneValue(entry)])) as T;
  }

  return value;
}

function cloneApproval(approval: Approval | SerializableApproval): Approval {
  return approval.data ? { action: approval.action, data: cloneValue(approval.data) } : { action: approval.action };
}

function normalizeApprovals(approvals: Approval[] | SerializableApproval[]): Approval[] {
  return approvals.map((approval) => cloneApproval(approval));
}

export function runWithExecutionContext<T>(
  context: {
    credentialStore?: CredentialStore | null;
    userStore?: UserStore | null;
    approvals?: Approval[] | SerializableApproval[] | null;
    filesystem?: TokenspaceFilesystem | null;
  },
  fn: () => T,
): T {
  return runtimeExecutionStorage.run(
    {
      credentialStore: context.credentialStore ?? undefined,
      userStore: context.userStore ?? undefined,
      approvals: normalizeApprovals(context.approvals ?? []),
      filesystem: context.filesystem ?? undefined,
    },
    fn,
  );
}

export function getExecutionContext(): RuntimeExecutionContext | undefined {
  return runtimeExecutionStorage.getStore();
}

export function getCredentialStore(): CredentialStore | undefined {
  return getExecutionContext()?.credentialStore ?? fallbackCredentialStore;
}

export function setFallbackCredentialStore(store: CredentialStore | undefined): void {
  fallbackCredentialStore = store;
}

export function getUserStore(): UserStore | undefined {
  return getExecutionContext()?.userStore ?? fallbackUserStore;
}

export function setFallbackUserStore(store: UserStore | undefined): void {
  fallbackUserStore = store;
}

export function getApprovals(): Approval[] {
  return getExecutionContext()?.approvals ?? fallbackApprovals;
}

export function replaceApprovals(approvals: Approval[] | SerializableApproval[]): void {
  const nextApprovals = normalizeApprovals(approvals);
  const context = getExecutionContext();

  if (context) {
    context.approvals = nextApprovals;
    return;
  }

  fallbackApprovals = nextApprovals;
}

export function pushApproval(approval: Approval): void {
  getApprovals().push(cloneApproval(approval));
}
