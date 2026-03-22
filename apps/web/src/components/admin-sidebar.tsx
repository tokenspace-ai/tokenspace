import { Link, useLocation, useParams } from "@tanstack/react-router";
import {
  ArrowLeftIcon,
  BrainCircuitIcon,
  Code2,
  FolderOpen,
  GitBranchIcon,
  KeyRoundIcon,
  ServerIcon,
  SettingsIcon,
  UsersIcon,
} from "lucide-react";
import { UserMenu } from "@/components/header/user-menu";
import {
  type Branch,
  type RevisionState,
  SidebarWorkspaceSelector,
  type Workspace,
  type WorkspaceWorkingChange,
} from "@/components/sidebar-workspace-selector";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarRail,
  useSidebar,
} from "@/components/ui/sidebar";

type AdminNavItem =
  | "editor"
  | "revision-files"
  | "settings"
  | "git-sync"
  | "credentials"
  | "members"
  | "models"
  | "executor";

type AdminNavItemConfig = {
  id: AdminNavItem;
  label: string;
  icon: typeof Code2;
  to:
    | "/workspace/$slug/admin/editor"
    | "/workspace/$slug/admin/revision-files"
    | "/workspace/$slug/admin/settings"
    | "/workspace/$slug/admin/git-sync"
    | "/workspace/$slug/admin/credentials"
    | "/workspace/$slug/admin/members"
    | "/workspace/$slug/admin/models"
    | "/workspace/$slug/admin/executor";
};

const workspaceNavItems: AdminNavItemConfig[] = [
  { id: "settings", label: "General", icon: SettingsIcon, to: "/workspace/$slug/admin/settings" },
  { id: "git-sync", label: "Git Sync", icon: GitBranchIcon, to: "/workspace/$slug/admin/git-sync" },
  { id: "executor", label: "Execution Environment", icon: ServerIcon, to: "/workspace/$slug/admin/executor" },
  { id: "members", label: "Members", icon: UsersIcon, to: "/workspace/$slug/admin/members" },
];

const accessNavItems: AdminNavItemConfig[] = [
  { id: "credentials", label: "Credentials", icon: KeyRoundIcon, to: "/workspace/$slug/admin/credentials" },
];

const revisionNavItems: AdminNavItemConfig[] = [
  { id: "editor", label: "Editor", icon: Code2, to: "/workspace/$slug/admin/editor" },
  { id: "models", label: "Models", icon: BrainCircuitIcon, to: "/workspace/$slug/admin/models" },
  { id: "revision-files", label: "Revision Files", icon: FolderOpen, to: "/workspace/$slug/admin/revision-files" },
];

function useCurrentAdminRoute(): AdminNavItem | undefined {
  const { pathname } = useLocation();

  if (pathname.includes("/admin/editor")) return "editor";
  if (pathname.includes("/admin/revision-files")) return "revision-files";
  if (pathname.includes("/admin/members")) return "members";
  if (pathname.includes("/admin/settings")) return "settings";
  if (pathname.includes("/admin/git-sync")) return "git-sync";
  if (pathname.includes("/admin/executor")) return "executor";
  if (pathname.includes("/admin/credentials")) return "credentials";
  if (pathname.includes("/admin/models")) return "models";
  return undefined;
}

interface AdminSidebarProps {
  workspaces: Workspace[];
  branches: Branch[];
  currentWorkspaceSlug?: string;
  currentBranchId?: string;
  revisionState: RevisionState;
  onBranchChange: (branchId: string) => void;
  workingChanges: WorkspaceWorkingChange[];
  onCommitChanges: (message: string) => Promise<void>;
  user: {
    id: string;
    email?: string | null;
    firstName?: string | null;
    lastName?: string | null;
    profilePictureUrl?: string | null;
  } | null;
  onSignOut: () => void;
}

export function AdminSidebar({
  workspaces,
  branches,
  currentWorkspaceSlug,
  currentBranchId,
  revisionState,
  onBranchChange,
  workingChanges,
  onCommitChanges,
  user,
  onSignOut,
}: AdminSidebarProps) {
  const params = useParams({ strict: false }) as { slug?: string };
  const slug = params.slug;
  const currentRoute = useCurrentAdminRoute();
  const { state } = useSidebar();
  const collapsed = state === "collapsed";

  return (
    <Sidebar variant="sidebar" collapsible="icon" className="border-r">
      <SidebarHeader className="border-b p-2">
        <SidebarWorkspaceSelector
          workspaces={workspaces}
          branches={branches}
          currentWorkspaceSlug={currentWorkspaceSlug}
          currentBranchId={currentBranchId}
          revisionState={revisionState}
          onBranchChange={onBranchChange}
          workingChanges={workingChanges}
          onCommitChanges={onCommitChanges}
          collapsed={collapsed}
        />
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              <SidebarMenuItem>
                <SidebarMenuButton asChild tooltip="Back to App">
                  <Link to="/workspace/$slug" params={{ slug: slug ?? "" }}>
                    <ArrowLeftIcon />
                    <span>Back to App</span>
                  </Link>
                </SidebarMenuButton>
              </SidebarMenuItem>
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {workspaceNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = currentRoute === item.id;
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                      <Link to={item.to} params={{ slug: slug ?? "" }}>
                        <Icon className="size-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Access &amp; Secrets</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {accessNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = currentRoute === item.id;
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                      <Link to={item.to} params={{ slug: slug ?? "" }}>
                        <Icon className="size-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Current Revision</SidebarGroupLabel>
          <SidebarGroupContent>
            <SidebarMenu>
              {revisionNavItems.map((item) => {
                const Icon = item.icon;
                const isActive = currentRoute === item.id;
                return (
                  <SidebarMenuItem key={item.id}>
                    <SidebarMenuButton asChild isActive={isActive} tooltip={item.label}>
                      <Link to={item.to} params={{ slug: slug ?? "" }}>
                        <Icon className="size-4" />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="">
        {user && <UserMenu user={user} onSignOut={onSignOut} variant="sidebar" collapsed={collapsed} />}
      </SidebarFooter>

      <SidebarRail />
    </Sidebar>
  );
}
