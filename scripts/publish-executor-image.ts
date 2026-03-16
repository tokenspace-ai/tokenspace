import { readFile } from "node:fs/promises";
import path from "node:path";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const IMAGE = "ghcr.io/tokenspace-ai/executor";
const DOCKERFILE = path.join(REPO_ROOT, "services/executor/Dockerfile");

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

async function main(): Promise<void> {
  const pkgPath = path.join(REPO_ROOT, "services/executor/package.json");
  const pkg = JSON.parse(await readFile(pkgPath, "utf8")) as { version: string };
  const version = pkg.version;

  console.log(`Building ${IMAGE}:${version}`);

  await run(
    [
      "docker",
      "build",
      "--build-arg",
      `EXECUTOR_VERSION=${version}`,
      "-t",
      `${IMAGE}:${version}`,
      "-t",
      `${IMAGE}:latest`,
      "-f",
      DOCKERFILE,
      ".",
    ],
    REPO_ROOT,
  );

  console.log(`Pushing ${IMAGE}:${version}`);
  await run(["docker", "push", `${IMAGE}:${version}`], REPO_ROOT);

  console.log(`Pushing ${IMAGE}:latest`);
  await run(["docker", "push", `${IMAGE}:latest`], REPO_ROOT);

  console.log("Done");
}

await main();
