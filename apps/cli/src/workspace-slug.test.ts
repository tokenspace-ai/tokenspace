import { describe, expect, it } from "bun:test";
import { assertValidWorkspaceSlug, getInvalidWorkspaceSlugReason } from "./workspace-slug.js";

describe("workspace slug validation", () => {
  it("accepts normal workspace slugs", () => {
    expect(getInvalidWorkspaceSlugReason("team-dev")).toBeNull();
    expect(() => assertValidWorkspaceSlug("team-dev")).not.toThrow();
  });

  it("rejects reserved branch and revision delimiters", () => {
    expect(getInvalidWorkspaceSlugReason("team:dev")).toContain("':'");
    expect(getInvalidWorkspaceSlugReason("team@rev")).toContain("'@'");
    expect(() => assertValidWorkspaceSlug("team:dev")).toThrow("Workspace slugs cannot contain ':'");
    expect(() => assertValidWorkspaceSlug("team@rev")).toThrow("Workspace slugs cannot contain '@'");
  });
});
