import { describe, expect, it } from "bun:test";
import {
  buildExecutorSetupPayload,
  createOpaqueToken,
  EXECUTOR_BOOTSTRAP_ENV_VAR,
  EXECUTOR_CONVEX_URL_ENV_VAR,
  EXECUTOR_HEARTBEAT_INTERVAL_MS,
  EXECUTOR_HEARTBEAT_TIMEOUT_MS,
  EXECUTOR_INSTANCE_TOKEN_REFRESH_WINDOW_MS,
  EXECUTOR_INSTANCE_TOKEN_TTL_MS,
  parseOpaqueToken,
  shouldRotateInstanceToken,
  verifyExecutorBootstrapToken,
  verifyExecutorInstanceToken,
  verifyOpaqueToken,
} from "../convex/executorAuth";

describe("executorAuth", () => {
  it("creates and verifies opaque tokens", async () => {
    const token = await createOpaqueToken();
    const parsed = parseOpaqueToken(token.token);

    expect(parsed.tokenId).toBe(token.tokenId);
    expect(await verifyOpaqueToken(parsed.secret, token.tokenHash)).toBe(true);
    expect(await verifyOpaqueToken("wrong-secret", token.tokenHash)).toBe(false);
  });

  it("rejects malformed opaque tokens", () => {
    expect(() => parseOpaqueToken("missing-delimiter")).toThrow("Invalid executor token");
    expect(() => parseOpaqueToken("too.many.parts.here")).toThrow("Invalid executor token");
    expect(() => parseOpaqueToken(".secret")).toThrow("Invalid executor token");
  });

  it("rotates instance tokens only inside the refresh window", () => {
    expect(shouldRotateInstanceToken(10_000, 10_000 - EXECUTOR_INSTANCE_TOKEN_REFRESH_WINDOW_MS + 1)).toBe(true);
    expect(shouldRotateInstanceToken(10_000, 10_000 - EXECUTOR_INSTANCE_TOKEN_REFRESH_WINDOW_MS - 1)).toBe(false);
  });

  it("builds setup payload with snippets and defaults", async () => {
    const bootstrapToken = (await createOpaqueToken()).token;
    const setup = buildExecutorSetupPayload(bootstrapToken, "https://example.convex.cloud");

    expect(setup.bootstrapTokenEnvVar).toBe(EXECUTOR_BOOTSTRAP_ENV_VAR);
    expect(setup.convexUrlEnvVar).toBe(EXECUTOR_CONVEX_URL_ENV_VAR);
    expect(setup.heartbeatIntervalMs).toBe(EXECUTOR_HEARTBEAT_INTERVAL_MS);
    expect(setup.heartbeatTimeoutMs).toBe(EXECUTOR_HEARTBEAT_TIMEOUT_MS);
    expect(setup.instanceTokenTtlMs).toBe(EXECUTOR_INSTANCE_TOKEN_TTL_MS);
    expect(setup.instanceTokenRefreshWindowMs).toBe(EXECUTOR_INSTANCE_TOKEN_REFRESH_WINDOW_MS);
    expect(setup.snippets.compose).toContain("services:");
    expect(setup.snippets.compose).toContain(EXECUTOR_BOOTSTRAP_ENV_VAR);
    expect(setup.snippets.compose).toContain(bootstrapToken);
    expect(setup.snippets.docker).toContain(EXECUTOR_BOOTSTRAP_ENV_VAR);
    expect(setup.snippets.docker).toContain(bootstrapToken);
    expect(setup.snippets.raw).toContain("@tokenspace/executor");
    expect(setup.snippets.raw).toContain(bootstrapToken);
    expect(setup.snippets.compose).toContain("https://example.convex.cloud");
    expect(setup.snippets.docker).toContain("https://example.convex.cloud");
    expect(setup.snippets.raw).toContain("https://example.convex.cloud");
    expect(setup.snippets.compose).not.toContain("<your-convex-url>");
    expect(setup.snippets.docker).not.toContain("<your-convex-url>");
    expect(setup.snippets.raw).not.toContain("<your-convex-url>");
  });

  it("verifies bootstrap tokens against executor state", async () => {
    const bootstrapToken = await createOpaqueToken();
    const executor = {
      _id: "executor_1",
      name: "Shared Fleet",
      status: "active",
      authMode: "opaque_secret",
      tokenVersion: 1,
      bootstrapTokenId: bootstrapToken.tokenId,
      bootstrapTokenHash: bootstrapToken.tokenHash,
      bootstrapIssuedAt: 1_000,
      createdBy: "creator-user",
      createdAt: 900,
      updatedAt: 950,
    };

    const verified = await verifyExecutorBootstrapToken(
      {
        runQuery: async (_ref: unknown, args: Record<string, unknown>) => {
          if ("bootstrapTokenId" in args) {
            return executor;
          }
          return null;
        },
      } as any,
      bootstrapToken.token,
    );

    expect(verified.executorId).toBe("executor_1");

    await expect(
      verifyExecutorBootstrapToken(
        {
          runQuery: async () => ({
            ...executor,
            status: "disabled",
          }),
        } as any,
        bootstrapToken.token,
      ),
    ).rejects.toThrow("Executor is not active");
  });

  it("verifies instance tokens and rejects expired or mismatched versions", async () => {
    const instanceToken = await createOpaqueToken();
    const instance = {
      _id: "instance_1",
      executorId: "executor_1",
      tokenVersion: 2,
      status: "online",
      registeredAt: 1_000,
      lastHeartbeatAt: 1_500,
      expiresAt: 2_000,
      instanceTokenId: instanceToken.tokenId,
      instanceTokenHash: instanceToken.tokenHash,
      instanceTokenIssuedAt: 1_000,
      instanceTokenExpiresAt: 2_000,
    };
    const executor = {
      _id: "executor_1",
      name: "Shared Fleet",
      status: "active",
      authMode: "opaque_secret",
      tokenVersion: 2,
      bootstrapTokenId: "bootstrap-id",
      bootstrapTokenHash: "bootstrap-hash",
      bootstrapIssuedAt: 900,
      createdBy: "creator-user",
      createdAt: 900,
      updatedAt: 950,
    };

    const mockCtx = (overrides?: Partial<typeof instance>, executorOverrides?: Partial<typeof executor>) =>
      ({
        runQuery: async (_ref: unknown, args: Record<string, unknown>) => {
          if ("instanceTokenId" in args) {
            return { ...instance, ...overrides };
          }
          if ("prevInstanceTokenId" in args) {
            return null;
          }
          if ("executorId" in args) {
            return { ...executor, ...executorOverrides };
          }
          return null;
        },
      }) as any;

    const verified = await verifyExecutorInstanceToken(mockCtx(), instanceToken.token, 1_000);

    expect(verified.instanceId).toBe("instance_1");
    expect(verified.tokenVersion).toBe(2);

    await expect(
      verifyExecutorInstanceToken(mockCtx({ instanceTokenExpiresAt: 999 }), instanceToken.token, 1_000),
    ).rejects.toThrow("Executor instance token expired");

    await expect(verifyExecutorInstanceToken(mockCtx({ expiresAt: 999 }), instanceToken.token, 1_000)).rejects.toThrow(
      "Executor instance heartbeat lease expired",
    );

    await expect(
      verifyExecutorInstanceToken(mockCtx(undefined, { tokenVersion: 3 }), instanceToken.token, 1_000),
    ).rejects.toThrow("Executor token version mismatch");
  });

  it("accepts previous token during grace window after rotation", async () => {
    const oldToken = await createOpaqueToken();
    const newToken = await createOpaqueToken();
    const instance = {
      _id: "instance_1",
      executorId: "executor_1",
      tokenVersion: 2,
      status: "online",
      registeredAt: 1_000,
      lastHeartbeatAt: 1_500,
      expiresAt: 5_000,
      instanceTokenId: newToken.tokenId,
      instanceTokenHash: newToken.tokenHash,
      instanceTokenIssuedAt: 2_000,
      instanceTokenExpiresAt: 5_000,
      prevInstanceTokenId: oldToken.tokenId,
      prevInstanceTokenHash: oldToken.tokenHash,
      prevInstanceTokenExpiresAt: 3_000,
    };
    const executor = {
      _id: "executor_1",
      name: "Shared Fleet",
      status: "active",
      authMode: "opaque_secret",
      tokenVersion: 2,
      bootstrapTokenId: "bootstrap-id",
      bootstrapTokenHash: "bootstrap-hash",
      bootstrapIssuedAt: 900,
      createdBy: "creator-user",
      createdAt: 900,
      updatedAt: 950,
    };

    const mockCtx = {
      runQuery: async (_ref: unknown, args: Record<string, unknown>) => {
        if ("instanceTokenId" in args) {
          return null;
        }
        if ("prevInstanceTokenId" in args) {
          return instance;
        }
        if ("executorId" in args) {
          return executor;
        }
        return null;
      },
    } as any;

    const verified = await verifyExecutorInstanceToken(mockCtx, oldToken.token, 2_500);
    expect(verified.instanceId).toBe("instance_1");

    await expect(verifyExecutorInstanceToken(mockCtx, oldToken.token, 3_001)).rejects.toThrow(
      "Executor instance token expired",
    );
  });
});
