import { describe, expect, it } from "bun:test";
import {
  extractCapabilityMethodsFromDeclaration,
  getCapabilityNamespace,
  selectCapabilityIconPath,
  stripLeadingMarkdownFrontmatter,
} from "../convex/capabilityExplorer";

describe("extractCapabilityMethodsFromDeclaration", () => {
  it("extracts callable declarations and preserves args field docs", () => {
    const methods = extractCapabilityMethodsFromDeclaration(`
type SearchResult = { rows: string[] };
/**
 * @param args.query Query SPL
 * @param args.timeRange.earliest Earliest time
 * @param args.timeRange.latest Latest time
 */
declare const searchSplunk: (args: {
  query: string;
  timeRange: {
    earliest: string;
    latest: string;
  };
}) => Promise<SearchResult>;
declare const ping: () => Promise<void>;
interface IgnoredConfig { enabled: boolean; }
type IgnoredAlias = string;
`);

    expect(methods).toEqual([
      {
        name: "searchSplunk",
        signature:
          "searchSplunk: (args: { query: string; timeRange: { earliest: string; latest: string; }; }) => Promise<SearchResult>",
        params: [
          { path: "query", description: "Query SPL" },
          { path: "timeRange.earliest", description: "Earliest time" },
          { path: "timeRange.latest", description: "Latest time" },
        ],
      },
      {
        name: "ping",
        signature: "ping: () => Promise<void>",
        params: [],
      },
    ]);
  });

  it("supports declare function exports and ignores non-callable const declarations", () => {
    const methods = extractCapabilityMethodsFromDeclaration(`
declare function listTeams(args: { limit?: number }): Promise<string[]>;
declare const DEFAULT_LIMIT = 20;
declare const metadata: { namespace: string };
`);

    expect(methods).toEqual([
      {
        name: "listTeams",
        signature: "function listTeams(args: { limit?: number }): Promise<string[]>",
        params: [],
      },
    ]);
  });

  it("extracts callable methods from namespaced capability declarations", () => {
    const methods = extractCapabilityMethodsFromDeclaration(`
declare namespace github {
  /**
   * @param args.owner Repository owner
   * @param args.repo Repository name
   */
  const getRepository: (args: {
    owner: string;
    repo: string;
  }) => Promise<{ id: number }>;
  const VERSION: "2022-11-28";
}
`);

    expect(methods).toEqual([
      {
        name: "getRepository",
        signature: "getRepository: (args: { owner: string; repo: string; }) => Promise<{ id: number }>",
        params: [
          { path: "owner", description: "Repository owner" },
          { path: "repo", description: "Repository name" },
        ],
      },
    ]);
  });
});

describe("capability explorer helpers", () => {
  it("derives the namespace from capability summary paths", () => {
    expect(
      getCapabilityNamespace({
        path: "capabilities/github/CAPABILITY.md",
        typesPath: "capabilities/github/capability.d.ts",
      }),
    ).toBe("github");
  });

  it("prefers svg icons over png icons", () => {
    expect(selectCapabilityIconPath("github", { hasSvg: true, hasPng: true })).toBe("capabilities/github/icon.svg");
    expect(selectCapabilityIconPath("github", { hasSvg: false, hasPng: true })).toBe("capabilities/github/icon.png");
    expect(selectCapabilityIconPath("github", { hasSvg: false, hasPng: false })).toBeUndefined();
  });

  it("strips leading markdown frontmatter from CAPABILITY guides", () => {
    expect(
      stripLeadingMarkdownFrontmatter(`---
name: GitHub
description: Interact with GitHub resources
---
# GitHub

Guide body
`),
    ).toBe(`# GitHub

Guide body
`);
  });
});
