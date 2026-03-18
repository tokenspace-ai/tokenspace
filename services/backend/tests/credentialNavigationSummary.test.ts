import { describe, expect, it } from "bun:test";
import { summarizeCredentialNavigationState } from "../convex/credentials";

describe("summarizeCredentialNavigationState", () => {
  it("tracks missing user-scoped credentials for members", () => {
    const result = summarizeCredentialNavigationState({
      requirements: [
        { id: "github-token", kind: "secret", scope: "user" },
        { id: "optional-user-token", kind: "secret", scope: "user", optional: true },
        { id: "workspace-oauth", kind: "oauth", scope: "workspace" },
      ],
      userBindings: [],
      isWorkspaceAdmin: false,
    });

    expect(result.hasAnyRequirements).toBe(true);
    expect(result.hasUserScopedRequirements).toBe(true);
    expect(result.configurableUserScopedCount).toBe(2);
    expect(result.requiredUserScopedCount).toBe(1);
    expect(result.missingConfigurableUserScopedCount).toBe(2);
    expect(result.missingUserScopedCount).toBe(1);
    expect(result.configurableWorkspaceScopedCount).toBe(1);
    expect(result.requiredWorkspaceScopedCount).toBe(1);
    expect(result.missingConfigurableCount).toBe(2);
    expect(result.missingWorkspaceScopedCount).toBe(0);
    expect(result.missingActionableCount).toBe(1);
  });

  it("includes workspace-scoped missing credentials for admins", () => {
    const result = summarizeCredentialNavigationState({
      requirements: [
        { id: "github-token", kind: "secret", scope: "user" },
        { id: "slack-oauth", kind: "oauth", scope: "workspace" },
        { id: "executor-env", kind: "env", scope: "workspace" },
        { id: "session-secret", kind: "secret", scope: "session" },
      ],
      userBindings: [{ credentialId: "github-token", kind: "secret" }],
      workspaceBindings: [],
      isWorkspaceAdmin: true,
    });

    expect(result.hasWorkspaceScopedRequirements).toBe(true);
    expect(result.hasSessionScopedRequirements).toBe(true);
    expect(result.configurableUserScopedCount).toBe(1);
    expect(result.configurableWorkspaceScopedCount).toBe(1);
    expect(result.requiredUserScopedCount).toBe(1);
    expect(result.requiredWorkspaceScopedCount).toBe(1);
    expect(result.missingConfigurableUserScopedCount).toBe(0);
    expect(result.missingConfigurableWorkspaceScopedCount).toBe(1);
    expect(result.missingConfigurableCount).toBe(1);
    expect(result.missingUserScopedCount).toBe(0);
    expect(result.missingWorkspaceScopedCount).toBe(1);
    expect(result.missingActionableCount).toBe(1);
  });

  it("treats configured credentials as satisfied", () => {
    const result = summarizeCredentialNavigationState({
      requirements: [
        { id: "github-token", kind: "secret", scope: "user" },
        { id: "slack-oauth", kind: "oauth", scope: "workspace" },
      ],
      userBindings: [{ credentialId: "github-token", kind: "secret" }],
      workspaceBindings: [{ credentialId: "slack-oauth", kind: "oauth" }],
      isWorkspaceAdmin: true,
    });

    expect(result.missingUserScopedCount).toBe(0);
    expect(result.missingWorkspaceScopedCount).toBe(0);
    expect(result.missingConfigurableCount).toBe(0);
    expect(result.missingActionableCount).toBe(0);
  });

  it("treats expired oauth bindings as missing", () => {
    const result = summarizeCredentialNavigationState({
      requirements: [
        { id: "github-token", kind: "oauth", scope: "user" },
        { id: "slack-oauth", kind: "oauth", scope: "workspace", optional: true },
      ],
      userBindings: [{ credentialId: "github-token", kind: "oauth", isExpired: true }],
      workspaceBindings: [{ credentialId: "slack-oauth", kind: "oauth", isExpired: true }],
      isWorkspaceAdmin: true,
    });

    expect(result.configurableUserScopedCount).toBe(1);
    expect(result.configurableWorkspaceScopedCount).toBe(1);
    expect(result.missingConfigurableUserScopedCount).toBe(1);
    expect(result.missingConfigurableWorkspaceScopedCount).toBe(1);
    expect(result.missingConfigurableCount).toBe(2);
    expect(result.requiredUserScopedCount).toBe(1);
    expect(result.missingUserScopedCount).toBe(1);
    expect(result.requiredWorkspaceScopedCount).toBe(0);
    expect(result.missingWorkspaceScopedCount).toBe(0);
    expect(result.missingActionableCount).toBe(1);
  });
});
