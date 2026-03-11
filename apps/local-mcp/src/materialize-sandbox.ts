import { mkdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import type { RevisionFilesystemArtifact } from "@tokenspace/compiler";
import { resolveSandboxPath } from "./path-safety";
import type { LocalSystemContentFile } from "./types";

type MaterializeSandboxOptions = {
  sandboxDir: string;
  revisionFs: RevisionFilesystemArtifact;
  localSystemFiles?: LocalSystemContentFile[];
};

async function writeSandboxFile(sandboxDir: string, filePath: string, content: string | Uint8Array): Promise<void> {
  const { absolutePath } = await resolveSandboxPath({
    sandboxRoot: sandboxDir,
    path: filePath,
  });
  await mkdir(path.dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, content);
}

export async function materializeSandbox(options: MaterializeSandboxOptions): Promise<void> {
  await rm(options.sandboxDir, { recursive: true, force: true });
  await mkdir(options.sandboxDir, { recursive: true });

  for (const declaration of options.revisionFs.declarations) {
    await writeSandboxFile(options.sandboxDir, declaration.fileName, declaration.content);
  }

  for (const file of options.revisionFs.files) {
    const content = file.binary ? Buffer.from(file.content, "base64") : file.content;
    await writeSandboxFile(options.sandboxDir, file.path, content);
  }

  for (const file of options.revisionFs.system) {
    await writeSandboxFile(options.sandboxDir, path.posix.join("system", file.path), file.content);
  }

  for (const file of options.localSystemFiles ?? []) {
    await writeSandboxFile(options.sandboxDir, path.posix.join("system", file.path), file.content);
  }

  await writeSandboxFile(options.sandboxDir, "builtins.d.ts", options.revisionFs.builtins);
}
