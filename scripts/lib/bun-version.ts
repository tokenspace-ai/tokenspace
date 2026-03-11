import { readFileSync } from "node:fs";

function getRequiredVersion(): string | undefined {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  return pkg.packageManager?.match(/bun@(\d+\.\d+\.\d+)/)?.[1];
}

function compareVersions(a: string, b: string): number {
  const partsA = a.split(".").map(Number);
  const partsB = b.split(".").map(Number);
  const maxLen = Math.max(partsA.length, partsB.length);

  for (let i = 0; i < maxLen; i++) {
    const numA = partsA[i] ?? 0;
    const numB = partsB[i] ?? 0;
    if (numA > numB) return 1;
    if (numA < numB) return -1;
  }
  return 0;
}

/**
 * Returns an error message if the running bun version is older than
 * the version declared in package.json's `packageManager` field.
 * Returns `undefined` when the check passes or no version is declared.
 */
export function checkBunVersion(): string | undefined {
  const required = getRequiredVersion();
  if (!required) return undefined;

  const current = Bun.version;
  if (compareVersions(current, required) >= 0) return undefined;

  return `Bun ${required} or later is required (currently running ${current}).`;
}
