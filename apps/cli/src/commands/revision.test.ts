import { describe, expect, it } from "bun:test";
import { toBuildManifestSummary } from "./revision";

describe("revision manifest helpers", () => {
  it("strips artifact paths before sending manifest summaries to backend actions", () => {
    const summary = toBuildManifestSummary({
      schemaVersion: 1,
      compilerVersion: "0.1.2",
      sourceFingerprint: "fingerprint",
      mode: "local",
      artifacts: {
        revisionFs: { hash: "rev-hash", size: 10, path: "revision-fs.json" },
        bundle: { hash: "bundle-hash", size: 20, path: "bundle.js" },
        metadata: { hash: "meta-hash", size: 30, path: "metadata.json" },
        diagnostics: { hash: "diag-hash", size: 40, path: "diagnostics.json" },
        deps: { hash: "deps-hash", size: 50, path: "deps.json" },
      },
    });

    expect(summary).toEqual({
      schemaVersion: 1,
      compilerVersion: "0.1.2",
      sourceFingerprint: "fingerprint",
      mode: "local",
      artifacts: {
        revisionFs: { hash: "rev-hash", size: 10 },
        bundle: { hash: "bundle-hash", size: 20 },
        metadata: { hash: "meta-hash", size: 30 },
        diagnostics: { hash: "diag-hash", size: 40 },
        deps: { hash: "deps-hash", size: 50 },
      },
    });
  });
});
