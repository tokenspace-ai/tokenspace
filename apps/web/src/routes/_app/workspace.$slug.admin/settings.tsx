import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Id } from "@tokenspace/backend/convex/_generated/dataModel";
import { useAction, useMutation, useQuery } from "convex/react";
import { Loader2, Trash2 } from "lucide-react";
import { useRef, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Separator } from "@/components/ui/separator";
import { WorkspaceIcon } from "@/components/workspace-icon";
import { parseWorkspaceSlug } from "@/lib/workspace-slug";

export const Route = createFileRoute("/_app/workspace/$slug/admin/settings")({
  component: SettingsPage,
  ssr: false,
});

const MAX_ICON_BYTES = 5 * 1024 * 1024;

function SettingsPage() {
  const { slug } = Route.useParams();
  const navigate = useNavigate();

  const { workspaceSlug } = parseWorkspaceSlug(slug);
  const workspace = useQuery(api.workspace.getBySlug, { slug: workspaceSlug });

  const updateWorkspace = useMutation(api.workspace.update);
  const removeWorkspace = useMutation(api.workspace.remove);
  const getIconUploadMetadata = useAction(api.workspace.getIconUploadMetadata);
  const setUploadedIcon = useAction(api.workspace.setUploadedIcon);
  const clearUploadedIcon = useMutation(api.workspace.clearUploadedIcon);

  const [name, setName] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const [isUploadingIcon, setIsUploadingIcon] = useState(false);
  const [isRemovingIcon, setIsRemovingIcon] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
  const iconInputRef = useRef<HTMLInputElement>(null);

  if (!workspace) {
    return (
      <div className="flex h-full items-center justify-center">
        <div className="text-muted-foreground">Loading...</div>
      </div>
    );
  }

  const currentName = name ?? workspace.name;
  const hasChanges = currentName !== workspace.name;

  const handleSave = async () => {
    if (!currentName.trim()) {
      toast.error("Tokenspace name is required");
      return;
    }

    setIsSaving(true);
    try {
      await updateWorkspace({
        workspaceId: workspace._id,
        name: currentName.trim(),
      });
      setName(null);
      toast.success("Settings saved");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to save settings");
      console.error(error);
    } finally {
      setIsSaving(false);
    }
  };

  const handleIconUpload = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.currentTarget.value = "";
    if (!file) {
      return;
    }

    const mimeType = resolveIconMimeType(file);
    if (!mimeType) {
      toast.error("Icon must be a PNG or SVG file");
      return;
    }

    const fileBuffer = await file.arrayBuffer();
    const bytes = new Uint8Array(fileBuffer);
    if (bytes.length === 0 || bytes.length > MAX_ICON_BYTES) {
      toast.error(`Icon must be between 1 byte and ${formatBytes(MAX_ICON_BYTES)}`);
      return;
    }

    setIsUploadingIcon(true);
    try {
      const hash = await hashBytes(fileBuffer);
      const metadata = await getIconUploadMetadata({
        workspaceId: workspace._id,
        hash,
        size: bytes.length,
        mimeType,
      });

      if (metadata.kind === "existing") {
        await setUploadedIcon({
          workspaceId: workspace._id,
          mimeType,
          blobId: metadata.blobId,
        });
      } else {
        const storageId = await uploadToStorage(metadata.uploadUrl, fileBuffer, mimeType);
        await setUploadedIcon({
          workspaceId: workspace._id,
          mimeType,
          storageId,
          hash,
          size: bytes.length,
        });
      }

      toast.success("Tokenspace icon updated");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to upload icon");
      console.error(error);
    } finally {
      setIsUploadingIcon(false);
    }
  };

  const handleRemoveUploadedIcon = async () => {
    setIsRemovingIcon(true);
    try {
      await clearUploadedIcon({ workspaceId: workspace._id });
      toast.success("Uploaded tokenspace icon removed");
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to remove icon");
      console.error(error);
    } finally {
      setIsRemovingIcon(false);
    }
  };

  const handleDelete = async () => {
    setIsDeleting(true);
    try {
      await removeWorkspace({ workspaceId: workspace._id });
      toast.success(`Tokenspace "${workspace.name}" deleted`);
      setIsDeleteDialogOpen(false);
      navigate({ to: "/workspaces" });
    } catch (error) {
      toast.error(error instanceof Error ? error.message : "Failed to delete tokenspace");
      console.error(error);
    } finally {
      setIsDeleting(false);
    }
  };

  const iconSource = workspace.iconSource;
  const iconPath = workspace.iconPath;
  const usingUploadedIcon = iconSource === "uploaded";
  const isWorkspaceAdmin = workspace.role === "workspace_admin";

  return (
    <div className="flex flex-1 flex-col overflow-y-auto">
      <div className="mx-auto w-full max-w-2xl space-y-8 p-8">
        <div>
          <h1 className="text-lg font-semibold">General</h1>
          <p className="text-sm text-muted-foreground">Manage your tokenspace settings.</p>
        </div>

        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Icon</Label>
            <div className="rounded-lg border bg-card p-4">
              <div className="flex items-start gap-4">
                <WorkspaceIcon
                  name={workspace.name}
                  iconUrl={workspace.iconUrl}
                  className="size-16 rounded-xl border"
                  fallbackClassName="bg-muted text-muted-foreground"
                />
                <div className="space-y-2">
                  <p className="text-sm">
                    {usingUploadedIcon
                      ? "Using uploaded icon."
                      : iconSource === "filesystem"
                        ? `Using ${iconPath ?? "icon file"} from the tokenspace filesystem.`
                        : "No icon configured."}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Upload a PNG or SVG icon, or add `icon.svg` / `icon.png` in the root of the tokenspace filesystem.
                  </p>
                  <div className="flex flex-wrap gap-2">
                    <input
                      ref={iconInputRef}
                      type="file"
                      accept="image/png,image/svg+xml,.png,.svg"
                      className="hidden"
                      onChange={handleIconUpload}
                    />
                    <Button
                      type="button"
                      variant="outline"
                      size="sm"
                      onClick={() => iconInputRef.current?.click()}
                      disabled={isUploadingIcon || isRemovingIcon || !isWorkspaceAdmin}
                    >
                      {isUploadingIcon ? (
                        <>
                          <Loader2 className="size-4 mr-2 animate-spin" />
                          Uploading...
                        </>
                      ) : (
                        "Upload Icon"
                      )}
                    </Button>
                    {usingUploadedIcon && (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        onClick={handleRemoveUploadedIcon}
                        disabled={isUploadingIcon || isRemovingIcon || !isWorkspaceAdmin}
                      >
                        {isRemovingIcon ? (
                          <>
                            <Loader2 className="size-4 mr-2 animate-spin" />
                            Removing...
                          </>
                        ) : (
                          "Remove Uploaded Icon"
                        )}
                      </Button>
                    )}
                  </div>
                </div>
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label htmlFor="workspace-name">Name</Label>
            <Input
              id="workspace-name"
              value={currentName}
              onChange={(e) => setName(e.target.value)}
              placeholder="My Tokenspace"
              disabled={!isWorkspaceAdmin}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="workspace-slug" className="text-muted-foreground">
              Slug
            </Label>
            <Input
              id="workspace-slug"
              value={workspace.slug}
              disabled
              className="font-mono text-muted-foreground bg-muted/50"
            />
            <p className="text-xs text-muted-foreground">
              The URL-friendly identifier cannot be changed after creation.
            </p>
          </div>

          <div className="flex justify-end">
            <Button onClick={handleSave} disabled={isSaving || !hasChanges || !isWorkspaceAdmin}>
              {isSaving ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Saving...
                </>
              ) : (
                "Save Changes"
              )}
            </Button>
          </div>
        </div>

        <Separator />

        {!isWorkspaceAdmin && (
          <div className="rounded-lg border p-4 text-sm text-muted-foreground">
            You have member access to this tokenspace. Only workspace admins can change settings.
          </div>
        )}

        {isWorkspaceAdmin && (
          <div className="space-y-4">
            <h2 className="text-sm font-medium text-destructive">Danger Zone</h2>

            <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-4">
              <div className="flex items-start justify-between gap-4">
                <div className="space-y-1">
                  <p className="text-sm font-medium">Delete Tokenspace</p>
                  <p className="text-xs text-muted-foreground">
                    Permanently delete this tokenspace and all its data including branches, commits, and files. This
                    action cannot be undone.
                  </p>
                </div>
                <Button
                  variant="destructive"
                  size="sm"
                  onClick={() => setIsDeleteDialogOpen(true)}
                  className="shrink-0"
                >
                  <Trash2 className="size-4 mr-1.5" />
                  Delete
                </Button>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* Delete Confirmation Dialog */}
      <AlertDialog open={isDeleteDialogOpen} onOpenChange={setIsDeleteDialogOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle className="flex items-center gap-2">
              <Trash2 className="size-5 text-destructive" />
              Delete Tokenspace
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div className="space-y-3">
                <p>
                  Are you sure you want to delete{" "}
                  <span className="font-semibold text-foreground">{workspace.name}</span>?
                </p>
                <p className="text-sm">This will permanently delete:</p>
                <ul className="list-disc list-inside text-sm space-y-1 text-muted-foreground">
                  <li>All branches and commits</li>
                  <li>All files and working changes</li>
                  <li>All compiled artifacts</li>
                </ul>
                <p className="text-sm text-destructive font-medium">This action cannot be undone.</p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isDeleting}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDelete}
              disabled={isDeleting}
              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
            >
              {isDeleting ? (
                <>
                  <Loader2 className="size-4 mr-2 animate-spin" />
                  Deleting...
                </>
              ) : (
                <>
                  <Trash2 className="size-4 mr-2" />
                  Delete Tokenspace
                </>
              )}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function resolveIconMimeType(file: File): "image/png" | "image/svg+xml" | null {
  if (file.type === "image/png" || file.type === "image/svg+xml") {
    return file.type;
  }

  const filename = file.name.toLowerCase();
  if (filename.endsWith(".png")) {
    return "image/png";
  }
  if (filename.endsWith(".svg")) {
    return "image/svg+xml";
  }

  return null;
}

async function hashBytes(buffer: ArrayBuffer): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new Error("Web Crypto API unavailable: secure context required");
  }
  const hashBuffer = await subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function uploadToStorage(
  uploadUrl: string,
  data: ArrayBuffer,
  mimeType: "image/png" | "image/svg+xml",
): Promise<Id<"_storage">> {
  const response = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": mimeType,
    },
    body: new Blob([data], { type: mimeType }),
  });

  if (!response.ok) {
    throw new Error(`Failed to upload icon (${response.status})`);
  }

  const payload = (await response.json()) as { storageId?: string };
  if (!payload.storageId) {
    throw new Error("Storage upload did not return a storageId");
  }
  return payload.storageId as Id<"_storage">;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
