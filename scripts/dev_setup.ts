import { basename, resolve } from "node:path";
import { $ } from "bun";
import { checkBunVersion } from "./lib/bun-version";
import {
  envFileExists,
  extractPortFromUrl,
  getEnvValue,
  parseEnvFile,
  readEnvFile,
  updateEnvValue,
  writeEnvFile,
} from "./lib/env";
import { checkPortsAvailable } from "./lib/ports";

function getProjectFolderName(): string {
  const workspaceRoot = resolve(__dirname, "..");
  return basename(workspaceRoot);
}

interface CheckResult {
  name: string;
  passed: boolean;
  message: string;
}

function checkBunVersionResult(): CheckResult {
  const error = checkBunVersion();
  if (!error) {
    return {
      name: "Bun version",
      passed: true,
      message: `Bun ${Bun.version} installed`,
    };
  }
  return {
    name: "Bun version",
    passed: false,
    message: error,
  };
}

async function checkEnvFile(): Promise<CheckResult> {
  if (!(await envFileExists())) {
    return {
      name: ".env file",
      passed: false,
      message: ".env file not found. Copy .env.example to .env and configure it.",
    };
  }
  return {
    name: ".env file",
    passed: true,
    message: ".env file exists",
  };
}

async function checkRequiredEnvVars(): Promise<CheckResult> {
  if (!(await envFileExists())) {
    return {
      name: "Required env vars",
      passed: false,
      message: "Cannot check env vars - .env file missing",
    };
  }

  const content = await readEnvFile();
  const env = parseEnvFile(content);

  const aiGatewayKey = getEnvValue(env, "AI_GATEWAY_API_KEY");

  if (!aiGatewayKey) {
    return {
      name: "Required env vars",
      passed: false,
      message: "AI_GATEWAY_API_KEY is not set in .env",
    };
  }

  if (aiGatewayKey === "...") {
    return {
      name: "Required env vars",
      passed: false,
      message: 'AI_GATEWAY_API_KEY is set to "..." - please provide a real API key',
    };
  }

  return {
    name: "Required env vars",
    passed: true,
    message: "Required environment variables are configured",
  };
}

async function checkOrSetConvexDeployment(): Promise<CheckResult> {
  if (!(await envFileExists())) {
    return {
      name: "CONVEX_DEPLOYMENT",
      passed: false,
      message: "Cannot check CONVEX_DEPLOYMENT - .env file missing",
    };
  }

  const projectFolder = getProjectFolderName();
  let content = await readEnvFile();
  const env = parseEnvFile(content);
  const currentValue = getEnvValue(env, "CONVEX_DEPLOYMENT");

  if (currentValue === projectFolder) {
    return {
      name: "CONVEX_DEPLOYMENT",
      passed: true,
      message: `CONVEX_DEPLOYMENT=${projectFolder}`,
    };
  }

  // Update the value
  content = updateEnvValue(content, "CONVEX_DEPLOYMENT", projectFolder);
  await writeEnvFile(content);

  if (!currentValue) {
    return {
      name: "CONVEX_DEPLOYMENT",
      passed: true,
      message: `Set CONVEX_DEPLOYMENT=${projectFolder}`,
    };
  }

  return {
    name: "CONVEX_DEPLOYMENT",
    passed: true,
    message: `Updated CONVEX_DEPLOYMENT from "${currentValue}" to "${projectFolder}"`,
  };
}

async function checkOrSetupPorts(): Promise<CheckResult> {
  if (!(await envFileExists())) {
    return {
      name: "Port configuration",
      passed: false,
      message: "Cannot check ports - .env file missing",
    };
  }

  let content = await readEnvFile();
  const env = parseEnvFile(content);

  const webPort = getEnvValue(env, "WEB_PORT");
  const convexUrl = getEnvValue(env, "CONVEX_URL");

  // Check if ports are configured
  if (!webPort || !convexUrl) {
    console.log("  ⚙️  No ports configured, running shuffle-ports...");
    try {
      await $`bun run shuffle-ports`.quiet();
      return {
        name: "Port configuration",
        passed: true,
        message: "Ports were not configured - ran shuffle-ports to set them up",
      };
    } catch (e) {
      return {
        name: "Port configuration",
        passed: false,
        message: `Failed to run shuffle-ports: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  const expectedAppUrl = `http://localhost:${webPort}`;
  const currentAppUrl = getEnvValue(env, "TOKENSPACE_APP_URL");

  if (currentAppUrl !== expectedAppUrl) {
    content = updateEnvValue(content, "TOKENSPACE_APP_URL", expectedAppUrl);
    await writeEnvFile(content);
  }

  return {
    name: "Port configuration",
    passed: true,
    message: `Ports configured (WEB_PORT=${webPort}, CONVEX_URL=${convexUrl}, TOKENSPACE_APP_URL=${expectedAppUrl})`,
  };
}

async function checkPortsAvailability(): Promise<CheckResult> {
  if (!(await envFileExists())) {
    return {
      name: "Port availability",
      passed: false,
      message: "Cannot check port availability - .env file missing",
    };
  }

  const content = await readEnvFile();
  const env = parseEnvFile(content);

  const webPortStr = getEnvValue(env, "WEB_PORT");
  const convexUrl = getEnvValue(env, "CONVEX_URL");

  if (!webPortStr || !convexUrl) {
    return {
      name: "Port availability",
      passed: false,
      message: "Ports not configured in .env",
    };
  }

  const webPort = Number.parseInt(webPortStr, 10);
  const convexPort = extractPortFromUrl(convexUrl);

  if (Number.isNaN(webPort)) {
    return {
      name: "Port availability",
      passed: false,
      message: `Invalid WEB_PORT value: ${webPortStr}`,
    };
  }

  if (!convexPort) {
    return {
      name: "Port availability",
      passed: false,
      message: `Could not extract port from CONVEX_URL: ${convexUrl}`,
    };
  }

  // Convex uses port, port+1 (site proxy), and port+2 (dashboard)
  const portsToCheck = [webPort, convexPort, convexPort + 1, convexPort + 2];
  const unavailablePorts = await checkPortsAvailable(portsToCheck);

  if (unavailablePorts.length > 0) {
    const portDescriptions = unavailablePorts.map((p: number) => {
      if (p === webPort) return `${p} (WEB_PORT)`;
      if (p === convexPort) return `${p} (Convex main)`;
      if (p === convexPort + 1) return `${p} (Convex site proxy)`;
      if (p === convexPort + 2) return `${p} (Convex dashboard)`;
      return String(p);
    });

    return {
      name: "Port availability",
      passed: false,
      message: `Ports in use: ${portDescriptions.join(", ")}. Run 'bun run shuffle-ports' to get new ports.`,
    };
  }

  return {
    name: "Port availability",
    passed: true,
    message: `All required ports are available (${webPort}, ${convexPort}-${convexPort + 2})`,
  };
}

function printResult(result: CheckResult) {
  const icon = result.passed ? "✅" : "❌";
  console.log(`${icon} ${result.name}: ${result.message}`);
}

async function main() {
  console.log("🔧 Tokenspace Dev Setup\n");
  console.log("Checking development environment...\n");

  let allPassed = true;
  const results: CheckResult[] = [];

  // 1. Check Bun version
  const bunCheck = checkBunVersionResult();
  results.push(bunCheck);
  printResult(bunCheck);
  if (!bunCheck.passed) {
    allPassed = false;
  }

  // 2. Check .env file exists
  const envCheck = await checkEnvFile();
  results.push(envCheck);
  printResult(envCheck);
  if (!envCheck.passed) {
    allPassed = false;
    // Can't continue without .env file
    console.log("\n❌ Setup failed. Please fix the issues above and try again.");
    process.exit(1);
  }

  // 3. Check required env vars
  const envVarsCheck = await checkRequiredEnvVars();
  results.push(envVarsCheck);
  printResult(envVarsCheck);
  if (!envVarsCheck.passed) {
    allPassed = false;
  }

  // 4. Check/set CONVEX_DEPLOYMENT
  const convexDeploymentCheck = await checkOrSetConvexDeployment();
  results.push(convexDeploymentCheck);
  printResult(convexDeploymentCheck);
  if (!convexDeploymentCheck.passed) {
    allPassed = false;
  }

  // 5. Check/setup ports
  const portsSetupCheck = await checkOrSetupPorts();
  results.push(portsSetupCheck);
  printResult(portsSetupCheck);
  if (!portsSetupCheck.passed) {
    allPassed = false;
  }

  // 6. Check port availability (only if ports are configured)
  if (portsSetupCheck.passed) {
    const portsAvailCheck = await checkPortsAvailability();
    results.push(portsAvailCheck);
    printResult(portsAvailCheck);
    if (!portsAvailCheck.passed) {
      allPassed = false;
    }
  }

  console.log("");

  if (allPassed) {
    console.log("✅ All checks passed! You're ready to run 'bun run dev'");
  } else {
    console.log("❌ Some checks failed. Please fix the issues above and try again.");
    process.exit(1);
  }
}

main().catch((e) => {
  console.error("Error:", e instanceof Error ? e.message : String(e));
  process.exit(1);
});
