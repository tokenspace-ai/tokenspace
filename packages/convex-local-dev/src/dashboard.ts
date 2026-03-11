import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ConvexBackend } from "./backend";
import type { ConvexLogger } from "./logger";
import { downloadConvexDashboard, extractZip } from "./utils";

export interface ConvexDashboard {
  readonly url: string;
  readonly port: number;
  stop(): Promise<void>;
}

export interface ConvexDashboardOptions {
  name?: string | undefined;
  port: number;
  version?: string | undefined;
  logger?: ConvexLogger;
  backendPort: number;
  adminKey: string;
}

export async function launchConvexDashboard(
  backend: ConvexBackend,
  options: ConvexDashboardOptions,
): Promise<ConvexDashboard> {
  const requestedVersion = options.version ?? backend.binaryVersion;
  const cacheDir = path.join(os.homedir(), ".convex-local-backend", "releases");

  // Download dashboard to get the actual version
  const { zipPath, version } = await downloadConvexDashboard({
    cacheTtlMs: 0,
    version: requestedVersion,
  });

  const dashboardDir = path.join(cacheDir, `dashboard-${version}`);

  if (!existsSync(dashboardDir)) {
    options.logger?.info(`Downloaded dashboard zip file to ${zipPath}`);
    await extractZip(zipPath, dashboardDir);
  }

  const deploymentsUrl = `http://127.0.0.1:${options.port}/deployments`;

  const dashboard = new ConvexDashboardImpl({
    ...options,
    directory: dashboardDir,
    deploymentsUrl,
  });
  await dashboard.start();

  options.logger?.info(`  Dashboard URL:   ${dashboard.url}`);

  return dashboard;
}

interface ConvexDashboardImplOptions extends ConvexDashboardOptions {
  directory: string;
  deploymentsUrl: string;
}

class ConvexDashboardImpl implements ConvexDashboard {
  readonly url: string;
  readonly port: number;
  readonly directory: string;
  readonly name: string;
  readonly backendUrl: string;
  readonly adminKey: string;
  readonly deploymentsUrl: string;
  private server: Bun.Server<unknown> | undefined;
  constructor(options: ConvexDashboardImplOptions) {
    this.url = `http://127.0.0.1:${options.port}`;
    this.port = options.port;
    this.directory = options.directory;
    this.name = options.name ?? "local-dev";
    this.backendUrl = `http://127.0.0.1:${options.backendPort}`;
    this.adminKey = options.adminKey;
    this.deploymentsUrl = options.deploymentsUrl;
  }
  stop(): Promise<void> {
    return this.server?.stop() ?? Promise.resolve();
  }

  async start(): Promise<void> {
    const directory = this.directory;
    const name = this.name;
    const backendUrl = this.backendUrl;
    const adminKey = this.adminKey;
    const deploymentsUrl = this.deploymentsUrl;
    this.server = Bun.serve({
      port: this.port,
      hostname: "0.0.0.0",
      development: true,
      async fetch(req) {
        const pathname = new URL(req.url).pathname;
        if (pathname === "/deployments") {
          return new Response(
            JSON.stringify({
              deployments: [
                {
                  name,
                  url: backendUrl,
                  adminKey,
                },
              ],
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          );
        }

        const fp = path.join(directory, pathname);
        const f = Bun.file(fp);
        if (!(await f.exists())) {
          let content = await Bun.file(path.join(directory, "index.html")).text();
          content = content.replace(
            /"defaultListDeploymentsApiUrl":\s*".+?"/g,
            `"defaultListDeploymentsApiUrl":${JSON.stringify(deploymentsUrl)}`,
          );
          return new Response(content, {
            headers: { "Content-Type": "text/html" },
          });
        }

        return new Response(f);
      },
    });
  }
}
