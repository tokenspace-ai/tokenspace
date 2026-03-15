export type PublicPackageSpec = {
  dir: string;
  name: string;
  requiredFiles: string[];
  allowSystemDir?: boolean;
  allowedPrefixes?: string[];
  smokeCheck?: "cli" | "compiler" | "local-mcp" | "library";
};

export const PUBLIC_PACKAGES: PublicPackageSpec[] = [
  {
    dir: "apps/cli",
    name: "tokenspace",
    requiredFiles: ["dist/cli.js", "LICENSE", "README.md", "assets/init/dependency-versions.json"],
    allowedPrefixes: ["assets/"],
    smokeCheck: "cli",
  },
  {
    dir: "packages/sdk",
    name: "@tokenspace/sdk",
    requiredFiles: [
      "dist/index.js",
      "dist/index.d.ts",
      "dist/credentials.js",
      "dist/credentials.d.ts",
      "LICENSE",
      "README.md",
    ],
    smokeCheck: "library",
  },
  {
    dir: "packages/compiler",
    name: "@tokenspace/compiler",
    requiredFiles: ["dist/index.js", "dist/index.d.ts", "dist/cli.js", "LICENSE", "README.md"],
    smokeCheck: "compiler",
  },
  {
    dir: "packages/runtime-core",
    name: "@tokenspace/runtime-core",
    requiredFiles: ["dist/index.js", "dist/index.d.ts", "LICENSE", "README.md"],
    smokeCheck: "library",
  },
  {
    dir: "apps/local-mcp",
    name: "@tokenspace/local-mcp",
    requiredFiles: ["dist/index.js", "dist/index.d.ts", "dist/cli.js", "LICENSE", "README.md"],
    allowSystemDir: true,
    smokeCheck: "local-mcp",
  },
  {
    dir: "packages/types",
    name: "@tokenspace/types",
    requiredFiles: ["dist/index.js", "dist/index.d.ts", "LICENSE", "README.md"],
    smokeCheck: "library",
  },
  {
    dir: "packages/system-content",
    name: "@tokenspace/system-content",
    requiredFiles: ["dist/index.js", "dist/index.d.ts", "LICENSE", "README.md"],
    smokeCheck: "library",
  },
  {
    dir: "services/executor",
    name: "@tokenspace/executor",
    requiredFiles: ["dist/main.js", "LICENSE", "README.md"],
    smokeCheck: "cli",
  },
  {
    dir: "services/backend",
    name: "@tokenspace/backend",
    requiredFiles: ["convex/_generated/api.js", "convex/_generated/api.d.ts", "convex/_generated/dataModel.d.ts"],
    allowedPrefixes: ["convex/"],
  },
  {
    dir: "packages/session-fs",
    name: "@tokenspace/session-fs",
    requiredFiles: ["dist/index.js", "dist/index.d.ts"],
    smokeCheck: "library",
  },
];

export const PUBLIC_PACKAGE_DIRS = new Set(PUBLIC_PACKAGES.map((pkg) => pkg.dir));
export const PUBLIC_PACKAGE_NAMES = new Set(PUBLIC_PACKAGES.map((pkg) => pkg.name));
