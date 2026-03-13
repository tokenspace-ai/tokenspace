import type { TokenspaceUserInfo, UserLookup } from "./builtin-types";
import { TokenspaceError } from "./error";
import { getUserStore, setFallbackUserStore } from "./runtime-context";

export type { TokenspaceUserInfo, UserLookup } from "./builtin-types";

export type UserInfoUnavailableReason = "not_initialized" | "non_interactive" | "local_mcp";

export type UserStore = {
  getCurrentUserInfo: () => Promise<TokenspaceUserInfo>;
  getInfo: (args: UserLookup) => Promise<TokenspaceUserInfo | null>;
};

export class UserInfoUnavailableError extends TokenspaceError {
  constructor(message: string, reason: UserInfoUnavailableReason, details?: string) {
    super(message, undefined, details, {
      errorType: "USER_INFO_UNAVAILABLE",
      reason,
    });
    this.name = "UserInfoUnavailableError";
  }
}

export function _setUserStore(store?: UserStore): void {
  setFallbackUserStore(store);
}

function requireUserStore(): UserStore {
  const userStore = getUserStore();
  if (!userStore) {
    throw new UserInfoUnavailableError(
      "User info is unavailable for this execution",
      "not_initialized",
      "Runtime must call runWithExecutionContext(...) or _setUserStore(...) before execution",
    );
  }
  return userStore;
}

export async function getCurrentUserInfo(): Promise<TokenspaceUserInfo> {
  return await requireUserStore().getCurrentUserInfo();
}

export async function getInfo(args: UserLookup): Promise<TokenspaceUserInfo | null> {
  return await requireUserStore().getInfo(args);
}

export const users = {
  getCurrentUserInfo,
  getInfo,
} as const;
