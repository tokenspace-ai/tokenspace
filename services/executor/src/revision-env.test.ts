import { describe, expect, it } from "bun:test";
import { rewriteRevisionPackageJsonWorkspaceDeps } from "./revision-env";

describe("rewriteRevisionPackageJsonWorkspaceDeps", () => {
  it("strips workspace deps from every dependency block while deduplicating link targets", async () => {
    const pkg: Record<string, unknown> = {
      dependencies: {
        "@tokenspace/sdk": "^0.1.2",
      },
      peerDependencies: {
        "@tokenspace/sdk": "workspace:*",
      },
      optionalDependencies: {
        "@tokenspace/compiler": "workspace:*",
      },
    };

    const { stripped, linkTargets } = await rewriteRevisionPackageJsonWorkspaceDeps(pkg, async (packageName) => {
      return `/monorepo/${packageName}`;
    });

    expect(stripped).toBe(true);
    expect(pkg).toEqual({
      dependencies: {
        "@tokenspace/sdk": "^0.1.2",
      },
    });
    expect(linkTargets).toEqual([
      { name: "@tokenspace/sdk", target: "/monorepo/@tokenspace/sdk" },
      { name: "@tokenspace/compiler", target: "/monorepo/@tokenspace/compiler" },
    ]);
  });
});
