import * as path from "node:path";
import {
  AutoDeployer,
  type ConvexBackend,
  type ConvexDashboard,
  type ConvexLogger,
  launchConvexBackend,
  launchConvexDashboard,
  watchFunctionLogs,
} from "@tokenspace/convex-local-dev";

export async function runConvexLocalDev({
  port,
  siteProxyPort,
  dashboardPort,
  startDashboard = true,
  logger: loggerInput,
  instanceName,
  env,
}: {
  port: number;
  siteProxyPort?: number;
  startDashboard?: boolean;
  dashboardPort?: number;
  logger?: ConvexLogger;
  instanceName: string;
  env?: Record<string, string>;
}): Promise<{ backend: ConvexBackend; dashboard?: ConvexDashboard; stop: () => Promise<void> }> {
  let backend: ConvexBackend | undefined;
  let dashboard: ConvexDashboard | undefined;
  let autoDeployer: AutoDeployer | undefined;
  let logWatcherAbortController: AbortController | undefined;

  // Default no-op logger
  const logger: ConvexLogger = loggerInput ?? {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  try {
    const backendDir = path.join(process.cwd(), ".convex");

    backend = await launchConvexBackend(
      {
        port,
        siteProxyPort: siteProxyPort ?? port + 1,
        instanceName,
        projectDir: __dirname,
        logger,
        backendLogFile: path.join(process.cwd(), ".convex", "server.log"),
      },
      backendDir,
    );

    if (env) {
      for (const [key, value] of Object.entries(env)) {
        await backend.setEnv(key, value);
      }
    }

    if (startDashboard) {
      dashboard = await launchConvexDashboard(backend, {
        port: dashboardPort ?? port + 2,
        logger,
        backendPort: port,
        adminKey: backend.adminKey,
        name: backend.instanceName,
      });
    }

    autoDeployer = new AutoDeployer(backend, {
      convexDir: path.join(__dirname, "convex"),
      watchDirs: [
        path.join(__dirname, "..", "..", "packages", "durable-agents", "src", "component"),
        path.join(__dirname, "..", "..", "packages", "durable-agents", "src", "client"),
      ],
      logger,
    });
    autoDeployer.start().catch((e) => {
      if (!e.message.includes("The operation was aborted"))
        logger.error("Error watching convex directory for changes", { error: e as Error });
    });

    // Start watching function logs
    logWatcherAbortController = new AbortController();
    watchFunctionLogs(backend.backendUrl!, backend.adminKey, logger, logWatcherAbortController.signal).catch((e) => {
      if (!e.message?.includes("aborted")) {
        logger.error("Error watching function logs", { error: e as Error });
      }
    });

    return {
      backend,
      dashboard,
      stop: () => {
        logWatcherAbortController?.abort();
        return Promise.all([
          backend?.stop() ?? Promise.resolve(),
          dashboard?.stop() ?? Promise.resolve(),
          autoDeployer?.stop() ?? Promise.resolve(),
        ]).then(() => {});
      },
    };
  } catch (e) {
    logger.error("Error starting convex local dev server", { error: e as Error });
    logWatcherAbortController?.abort();
    await Promise.all([
      backend?.stop() ?? Promise.resolve(),
      dashboard?.stop() ?? Promise.resolve(),
      autoDeployer?.stop() ?? Promise.resolve(),
    ]);
    throw e;
  }
}
