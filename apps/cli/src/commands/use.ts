import pc from "picocolors";
import { getDefaultWorkspaceSlug, setDefaultWorkspaceSlug } from "../auth.js";
import { exitWithError, getWorkspaceBySlug, listWorkspaces } from "../client.js";
import { promptSelect } from "../prompts.js";

async function resolveWorkspaceSlugFromPicker(): Promise<string> {
  const workspaces = (await listWorkspaces()).sort((left, right) => left.slug.localeCompare(right.slug));
  if (workspaces.length === 0) {
    exitWithError("No workspaces found for this account.");
  }

  const currentDefault = getDefaultWorkspaceSlug();
  return await promptSelect(
    "Select a default tokenspace:",
    workspaces.map((workspace) => ({
      label:
        workspace.slug === currentDefault
          ? `${workspace.name} (${workspace.slug}) [current default]`
          : `${workspace.name} (${workspace.slug})`,
      value: workspace.slug,
    })),
  );
}

export async function useWorkspace(slug?: string): Promise<void> {
  const workspaceSlug = slug?.trim() ? slug.trim() : await resolveWorkspaceSlugFromPicker();

  const workspace = await getWorkspaceBySlug(workspaceSlug);
  if (!workspace) {
    exitWithError(`Tokenspace '${workspaceSlug}' not found`);
  }

  setDefaultWorkspaceSlug(workspace.slug);

  console.log(pc.green(`✓ Default tokenspace set to ${pc.bold(workspace.slug)}`));
}
