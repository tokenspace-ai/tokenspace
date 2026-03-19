import { readFile } from "node:fs/promises";
import path from "node:path";
import { parseArgs } from "node:util";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const IMAGE = "ghcr.io/tokenspace-ai/executor";
const DOCKERFILE = path.join(REPO_ROOT, "services/executor/Dockerfile");
const DEFAULT_PLATFORMS = "linux/amd64,linux/arm64";

async function run(command: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exitCode !== 0) {
    throw new Error(`${command.join(" ")} failed (exit ${exitCode})\n${stderr || stdout}`);
  }
  return stdout.trim();
}

function parseBoolean(value: string | undefined, flag: string): boolean {
  if (value === undefined) {
    return true;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new Error(`Invalid value for --${flag}: ${value}. Expected true or false.`);
}

async function readExecutorVersion(): Promise<string> {
  const pkgPath = path.join(REPO_ROOT, "services/executor/package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
  return pkg.version;
}

async function verifyManifest(imageRef: string, platforms: string): Promise<void> {
  const inspect = await run(["docker", "buildx", "imagetools", "inspect", imageRef], REPO_ROOT);
  const missingPlatforms = platforms
    .split(",")
    .map((platform) => platform.trim())
    .filter((platform) => platform.length > 0 && !inspect.includes(platform));
  if (missingPlatforms.length > 0) {
    throw new Error(`Image ${imageRef} is missing platforms: ${missingPlatforms.join(", ")}\n${inspect}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      version: { type: "string" },
      latest: { type: "string", default: "true" },
      platforms: { type: "string", default: DEFAULT_PLATFORMS },
    },
    strict: true,
    allowPositionals: false,
  });
  const version = values.version ?? (await readExecutorVersion());
  const publishLatest = parseBoolean(values.latest, "latest");
  const platforms = values.platforms ?? DEFAULT_PLATFORMS;
  const tags = [`${IMAGE}:${version}`];
  if (publishLatest) {
    tags.push(`${IMAGE}:latest`);
  }

  console.log(`Building and pushing ${tags.join(", ")} for ${platforms}`);

  await run(
    [
      "docker",
      "buildx",
      "build",
      "--platform",
      platforms,
      "--build-arg",
      `EXECUTOR_VERSION=${version}`,
      "-f",
      DOCKERFILE,
      ...tags.flatMap((tag) => ["-t", tag]),
      "--push",
      ".",
    ],
    REPO_ROOT,
  );

  for (const tag of tags) {
    console.log(`Verifying ${tag}`);
    await verifyManifest(tag, platforms);
  }

  console.log(`Published ${tags.join(", ")}`);
}

await main();
