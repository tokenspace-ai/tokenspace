import { NavLink, Outlet } from "react-router-dom";
import { Logo } from "@/ui/components/logo";
import { Badge } from "@/ui/components/ui/badge";

const tabs = [
  { to: "/info", label: "Info" },
  { to: "/credentials", label: "Credentials" },
  { to: "/approvals", label: "Approvals" },
] as const;

export function Layout() {
  return (
    <div className="min-h-screen">
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <header className="mb-8 space-y-4">
          <Logo className="h-7" />
          <div className="space-y-2">
            <div className="flex items-center gap-3">
              <h1 className="text-2xl font-semibold tracking-tight">Local MCP</h1>
              <Badge variant="outline" className="text-xs font-normal">
                localhost control plane
              </Badge>
            </div>
            <p className="text-sm text-muted-foreground">
              Inspect this session, configure credentials, and approve or deny requested actions.
            </p>
          </div>
        </header>

        <nav className="mb-8 flex gap-1 border-b border-border">
          {tabs.map((tab) => (
            <NavLink
              key={tab.to}
              to={tab.to}
              className={({ isActive }) =>
                [
                  "px-4 py-2 text-sm font-medium transition-colors -mb-px border-b-2",
                  isActive
                    ? "border-primary text-foreground"
                    : "border-transparent text-muted-foreground hover:text-foreground hover:border-muted-foreground/40",
                ].join(" ")
              }
            >
              {tab.label}
            </NavLink>
          ))}
        </nav>

        <Outlet />
      </div>
    </div>
  );
}
