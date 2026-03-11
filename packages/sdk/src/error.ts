export class TokenspaceError extends Error {
  constructor(
    message: string,
    public readonly cause?: Error,
    public readonly details?: string,
    public readonly data?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "TokenspaceError";
  }
}
