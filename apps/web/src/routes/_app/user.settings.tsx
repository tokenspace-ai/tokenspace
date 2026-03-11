import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useAccessToken } from "@workos/authkit-tanstack-react-start/client";
import { UserProfile, UserSecurity, UserSessions, WorkOsWidgets } from "@workos-inc/widgets";
import { ArrowLeftIcon, Shield, UserCircle2, UserRoundCheck } from "lucide-react";
import { useCallback } from "react";
import { z } from "zod";
import { Logo } from "@/components/logo";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useTheme } from "@/lib/theme";

const tabs = ["profile", "sessions", "security"] as const;

export const Route = createFileRoute("/_app/user/settings")({
  component: UserSettingsPage,
  validateSearch: z.object({
    tab: z.enum(tabs).catch("profile"),
  }),
});

function UserSettingsPage() {
  const { tab } = Route.useSearch();
  const navigate = useNavigate();
  const { getAccessToken } = useAccessToken();
  const { resolvedTheme } = useTheme();

  const authToken = useCallback(async (): Promise<string> => {
    const token = await getAccessToken();
    if (!token) {
      throw new Error("Unable to fetch a WorkOS access token.");
    }
    return token;
  }, [getAccessToken]);

  return (
    <div className="">
      <WorkOsWidgets
        className="max-h-80"
        theme={{ appearance: resolvedTheme === "light" ? "light" : "dark", accentColor: "yellow" }}
      >
        <div className="mx-auto w-full max-w-5xl space-y-6 px-4 py-8 sm:px-6 sm:py-10">
          <div className="flex justify-between">
            <div className="pb-2">
              <Link to="/" className="text-sm text-muted-foreground flex items-center gap-2">
                <ArrowLeftIcon className="size-4" />
                <div>Back</div>
              </Link>
            </div>
            <Logo className="h-8 w-auto" />
          </div>
          <div className="space-y-1">
            <h1 className="text-2xl font-semibold tracking-tight">User Settings</h1>
            <p className="text-sm text-muted-foreground">
              Manage your profile details, active sessions, and account security.
            </p>
          </div>
          <Tabs
            value={tab}
            onValueChange={(v) =>
              navigate({ to: Route.fullPath, search: { tab: v as (typeof tabs)[number] }, replace: true })
            }
            className="w-full"
          >
            <TabsList className="h-auto w-full max-w-2xl grid grid-cols-3 gap-1 bg-muted/70 p-1">
              <TabsTrigger value="profile" className="gap-2 py-2">
                <UserCircle2 className="size-4" />
                Profile
              </TabsTrigger>
              <TabsTrigger value="sessions" className="gap-2 py-2">
                <UserRoundCheck className="size-4" />
                Sessions
              </TabsTrigger>
              <TabsTrigger value="security" className="gap-2 py-2">
                <Shield className="size-4" />
                Security
              </TabsTrigger>
            </TabsList>

            <TabsContent value="profile" className="mt-4">
              <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                <UserProfile authToken={authToken} className="min-h-80" />
              </section>
            </TabsContent>

            <TabsContent value="sessions" className="mt-4">
              <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                <UserSessions authToken={authToken} className="min-h-80" />
              </section>
            </TabsContent>

            <TabsContent value="security" className="mt-4">
              <section className="rounded-xl border bg-card p-4 shadow-sm sm:p-6">
                <UserSecurity authToken={authToken} className="min-h-80" />
              </section>
            </TabsContent>
          </Tabs>
        </div>
      </WorkOsWidgets>
    </div>
  );
}
