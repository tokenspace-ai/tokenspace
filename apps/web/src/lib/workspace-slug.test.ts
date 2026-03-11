import { describe, expect, it } from "bun:test";
import { getInvalidBranchNameReason, parseWorkspaceSlug } from "./workspace-slug";

describe("workspace slug utilities", () => {
  it("rejects reserved branch delimiters", () => {
    expect(getInvalidBranchNameReason("feature:hotfix")).toContain(":");
    expect(getInvalidBranchNameReason("feature@hotfix")).toContain("@");
    expect(getInvalidBranchNameReason("feature-hotfix")).toBeNull();
  });

  it("parses revision-aware slugs without treating valid branch names as revisions", () => {
    expect(parseWorkspaceSlug("workspace:feature")).toEqual({
      workspaceSlug: "workspace",
      branchName: "feature",
      workingStateHash: undefined,
      revisionId: undefined,
    });
  });
});
