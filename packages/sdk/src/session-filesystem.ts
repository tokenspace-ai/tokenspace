import type { TokenspaceFilesystem } from "./builtin-types";
import { TokenspaceError } from "./error";
import { getExecutionContext } from "./runtime-context";

export class SessionFilesystemNotInitializedError extends TokenspaceError {
  constructor() {
    super(
      "Session filesystem not initialized",
      undefined,
      "Runtime must call runWithExecutionContext(...) with a filesystem before execution",
      {
        errorType: "SESSION_FILESYSTEM_NOT_INITIALIZED",
      },
    );
    this.name = "SessionFilesystemNotInitializedError";
  }
}

export function getSessionFilesystem(): TokenspaceFilesystem {
  const filesystem = getExecutionContext()?.filesystem;
  if (!filesystem) {
    throw new SessionFilesystemNotInitializedError();
  }
  return filesystem;
}
