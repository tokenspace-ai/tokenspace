import { beforeAll, describe, expect, it } from "bun:test";
import { getSharedContext, getSharedHarness, waitForSetup } from "./setup";

describe("workspace file HTTP route", () => {
  beforeAll(async () => {
    await waitForSetup();
  });

  it("rejects invalid traversal paths before attempting auth", async () => {
    const { revisionId } = getSharedContext();
    const backend = getSharedHarness().getBackend();
    const siteUrl = `http://127.0.0.1:${backend.siteProxyPort}`;

    const response = await fetch(
      `${siteUrl}/api/fs/file?revisionId=${encodeURIComponent(revisionId)}&path=${encodeURIComponent("../secret.svg")}`,
    );

    expect(response.status).toBe(400);
    expect(await response.text()).toContain("path is invalid");
  });

  it("requires authentication for valid revision file requests", async () => {
    const { revisionId } = getSharedContext();
    const backend = getSharedHarness().getBackend();
    const siteUrl = `http://127.0.0.1:${backend.siteProxyPort}`;

    const response = await fetch(
      `${siteUrl}/api/fs/file?revisionId=${encodeURIComponent(revisionId)}&path=${encodeURIComponent("TOKENSPACE.md")}`,
    );

    expect(response.status).toBe(401);
    expect(await response.text()).toContain("Unauthorized");
  });

  it("answers CORS preflight for authenticated browser file requests", async () => {
    const { revisionId } = getSharedContext();
    const backend = getSharedHarness().getBackend();
    const siteUrl = `http://127.0.0.1:${backend.siteProxyPort}`;

    const response = await fetch(
      `${siteUrl}/api/fs/file?revisionId=${encodeURIComponent(revisionId)}&path=${encodeURIComponent("TOKENSPACE.md")}`,
      {
        method: "OPTIONS",
        headers: {
          Origin: "http://localhost:26355",
          "Access-Control-Request-Method": "GET",
          "Access-Control-Request-Headers": "authorization",
        },
      },
    );

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:26355");
    expect(response.headers.get("access-control-allow-methods")).toContain("GET");
    expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
  });
});
