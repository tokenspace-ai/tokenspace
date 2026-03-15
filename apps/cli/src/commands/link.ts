import path from "node:path";
import { api } from "@tokenspace/backend/convex/_generated/api";
import pc from "picocolors";
import { getClient, getWorkspaceBySlug, type Workspace } from "../client.js";
import {
  ensureGitignoreEntry,
  formatDisplayPath,
  pathExists,
  readLinkedWorkspaceConfig,
  writeLinkedWorkspaceConfig,
} from "../local-workspace.js";
import { confirm, prompt } from "../prompts.js";
import { assertValidWorkspaceSlug } from "../workspace-slug.js";

interface LinkOptions {
  slug?: string;
  create?: boolean;
  name?: string;
  relink?: boolean;
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

async function createWorkspaceInteractive(nameOption?: string, slugOption?: string): Promise<Workspace> {
  const client = await getClient();

  let name = nameOption;
  if (!name) {
    name = await prompt(pc.cyan("Tokenspace name: "));
  }
  if (!name) {
    throw new Error("Tokenspace name is required");
  }

  let slug = slugOption;
  if (!slug) {
    const suggested = slugify(name);
    const answer = await prompt(pc.cyan(`Tokenspace slug (${pc.dim(suggested)}): `));
    slug = answer || suggested;
  }

  if (!slug) {
    throw new Error("Tokenspace slug is required");
  }

  assertValidWorkspaceSlug(slug);

  await client.mutation(api.workspace.create, { name, slug });
  const workspace = await getWorkspaceBySlug(slug);
  if (!workspace) {
    throw new Error(`Created tokenspace '${slug}' but could not load it afterwards`);
  }
  return workspace;
}

async function resolveWorkspace(
  options: LinkOptions,
  callbacks: { beforeCreate?: () => Promise<boolean> } = {},
): Promise<Workspace | null> {
  if (options.create) {
    if (callbacks.beforeCreate && !(await callbacks.beforeCreate())) {
      return null;
    }
    return await createWorkspaceInteractive(options.name, options.slug);
  }
  if (options.slug) {
    const workspace = await getWorkspaceBySlug(options.slug);
    if (!workspace) {
      throw new Error(`Tokenspace '${options.slug}' not found`);
    }
    return workspace;
  }

  const client = await getClient();
  const workspaces = await client.query(api.workspace.list);

  console.log(pc.bold("Available tokenspaces:"));
  if (workspaces.length === 0) {
    console.log(pc.dim("  No existing tokenspaces found. Creating a new one."));
    if (callbacks.beforeCreate && !(await callbacks.beforeCreate())) {
      return null;
    }
    return await createWorkspaceInteractive();
  }

  workspaces.forEach((workspace: Workspace, index: number) => {
    console.log(`  ${index + 1}. ${workspace.slug} ${pc.dim(`(${workspace.name})`)}`);
  });
  console.log(`  ${workspaces.length + 1}. ${pc.cyan("Create a new tokenspace")}`);

  while (true) {
    const answer = await prompt(pc.cyan("Select a tokenspace: "));
    const index = Number.parseInt(answer, 10);
    if (Number.isNaN(index) || index < 1 || index > workspaces.length + 1) {
      console.log(pc.yellow("Enter a valid number from the list."));
      continue;
    }
    if (index === workspaces.length + 1) {
      if (callbacks.beforeCreate && !(await callbacks.beforeCreate())) {
        return null;
      }
      return await createWorkspaceInteractive();
    }
    return workspaces[index - 1]!;
  }
}

export async function linkWorkspace(options: LinkOptions): Promise<void> {
  const workspaceDir = path.resolve(process.cwd());
  if (!(await pathExists(workspaceDir))) {
    throw new Error(`Directory does not exist: ${workspaceDir}`);
  }

  const existing = await readLinkedWorkspaceConfig(workspaceDir);
  let relinkConfirmed = Boolean(options.relink);
  const workspace = await resolveWorkspace(options, {
    beforeCreate: async () => {
      if (!existing || relinkConfirmed) {
        return true;
      }
      const shouldRelink = await confirm(
        `This directory is linked to '${existing.workspaceSlug}'. Replace it with a new tokenspace?`,
        false,
      );
      if (shouldRelink) {
        relinkConfirmed = true;
      }
      return shouldRelink;
    },
  });
  if (!workspace) {
    console.log(pc.yellow("Link unchanged."));
    return;
  }

  if (existing && existing.workspaceSlug === workspace.slug) {
    console.log(pc.green(`Workspace already linked to ${pc.bold(workspace.slug)}`));
    console.log(pc.dim(`  Directory: ${formatDisplayPath(process.cwd(), workspaceDir)}`));
    return;
  }

  if (existing && !relinkConfirmed) {
    const shouldRelink = await confirm(
      `This directory is linked to '${existing.workspaceSlug}'. Replace it with '${workspace.slug}'?`,
      false,
    );
    if (!shouldRelink) {
      console.log(pc.yellow("Link unchanged."));
      return;
    }
  }

  await writeLinkedWorkspaceConfig(workspaceDir, workspace.slug);
  await ensureGitignoreEntry(workspaceDir);

  console.log(pc.green(`✓ Linked to ${pc.bold(workspace.slug)}`));
  console.log(pc.dim(`  Directory: ${formatDisplayPath(process.cwd(), workspaceDir)}`));
  console.log(
    pc.dim(`  Link file: ${formatDisplayPath(process.cwd(), path.join(workspaceDir, ".tokenspace/link.json"))}`),
  );
  console.log();
  console.log(pc.bold("Next steps"));
  console.log("  tokenspace pull");
  console.log("  tokenspace push");
}
