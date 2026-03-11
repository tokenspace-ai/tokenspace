import type { ConvexQueryClient } from "@convex-dev/react-query";
import { ConvexProviderWithAuthKit } from "@convex-dev/workos";
import type { QueryClient } from "@tanstack/react-query";
import { createRootRouteWithContext, HeadContent, Outlet, Scripts } from "@tanstack/react-router";
import type { AuthResult } from "@workos/authkit-tanstack-react-start";
import { AuthKitProvider, useAccessToken, useAuth } from "@workos/authkit-tanstack-react-start/client";
import { ConvexProvider, ConvexReactClient } from "convex/react";
import { type ReactNode, useCallback, useEffect, useState } from "react";
import { Toaster } from "@/components/ui/sonner";
import { ThemeProvider } from "@/lib/theme";
import appCss from "../index.css?url";

export interface RouterAppContext {
  queryClient: QueryClient;
  convexClient: ConvexReactClient;
  convexQueryClient: ConvexQueryClient;
  auth: () => AuthResult;
}

export const Route = createRootRouteWithContext<RouterAppContext>()({
  head: () => ({
    meta: [
      {
        charSet: "utf-8",
      },
      {
        name: "viewport",
        content: "width=device-width, initial-scale=1",
      },
      {
        title: "TokenSpace",
      },
    ],
    links: [
      {
        rel: "icon",
        type: "image/svg+xml",
        href: "/icon.svg",
      },
      {
        rel: "stylesheet",
        href: appCss,
      },
    ],
  }),

  component: RootComponent,
});

function RootComponent() {
  return (
    <RootDocument>
      <ConvexClientProvider>
        <Outlet />
      </ConvexClientProvider>
    </RootDocument>
  );
}

function RootDocument({ children }: { children: ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <HeadContent />
        <ThemeInitScript />
        {import.meta.env.DEV && <DevConsoleForwardScript />}
      </head>
      <body>
        <ThemeProvider defaultTheme="dark">
          <div className="h-svh">{children}</div>
          <Toaster richColors />
        </ThemeProvider>
        <Scripts />
      </body>
    </html>
  );
}

function ThemeInitScript() {
  return (
    <script
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Required to prevent flash of wrong theme
      dangerouslySetInnerHTML={{
        __html: `(function(){try{var t=localStorage.getItem("theme");if(t==="light"||(!t&&window.matchMedia("(prefers-color-scheme:light)").matches)){document.documentElement.classList.remove("dark")}else{document.documentElement.classList.add("dark")}}catch(e){}})()`,
      }}
    />
  );
}

/**
 * Dev-only script that forwards browser console logs to the Vite dev server.
 * This allows seeing browser console output in the terminal alongside server logs.
 */
function DevConsoleForwardScript() {
  return (
    <script
      type="module"
      // biome-ignore lint/security/noDangerouslySetInnerHtml: Required to inject inline script for dev tooling
      dangerouslySetInnerHTML={{
        __html: `
if (typeof window !== "undefined" && !window.__consoleForwardInstalled) {
  window.__consoleForwardInstalled = true;
  const originalMethods = {
    log: console.log.bind(console),
    warn: console.warn.bind(console),
    error: console.error.bind(console),
    info: console.info.bind(console),
    debug: console.debug.bind(console),
  };
  const logBuffer = [];
  let flushTimeout = null;
  function createLogEntry(level, args) {
    const stacks = [];
    const extra = [];
    const message = args.map((arg) => {
      if (arg === undefined) return "undefined";
      if (typeof arg === "string") return arg;
      if (arg instanceof Error || typeof arg?.stack === "string") {
        let stringifiedError = arg.toString();
        if (arg.stack) {
          let stack = arg.stack.toString();
          if (stack.startsWith(stringifiedError)) {
            stack = stack.slice(stringifiedError.length).trimStart();
          }
          if (stack) stacks.push(stack);
        }
        return stringifiedError;
      }
      if (typeof arg === "object" && arg !== null) {
        try { extra.push(JSON.parse(JSON.stringify(arg))); } catch { extra.push(String(arg)); }
        return "[extra#" + extra.length + "]";
      }
      return String(arg);
    }).join(" ");
    return { level, message, timestamp: new Date(), url: window.location.href, userAgent: navigator.userAgent, stacks, extra };
  }
  async function sendLogs(logs) {
    try { await fetch("/__debug/client-logs", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ logs }) }); } catch {}
  }
  function flushLogs() {
    if (logBuffer.length === 0) return;
    const logsToSend = [...logBuffer];
    logBuffer.length = 0;
    sendLogs(logsToSend);
    if (flushTimeout) { clearTimeout(flushTimeout); flushTimeout = null; }
  }
  function addToBuffer(entry) {
    logBuffer.push(entry);
    if (logBuffer.length >= 50) { flushLogs(); return; }
    if (!flushTimeout) flushTimeout = setTimeout(flushLogs, 100);
  }
  ["log", "warn", "error", "info", "debug"].forEach(level => {
    console[level] = function(...args) {
      originalMethods[level](...args);
      addToBuffer(createLogEntry(level, args));
    };
  });
  window.addEventListener("beforeunload", flushLogs);
  setInterval(flushLogs, 3000);
}
        `,
      }}
    />
  );
}
const convex = new ConvexReactClient(import.meta.env.VITE_CONVEX_URL!);

function ConvexClientProvider({ children }: { children: ReactNode }) {
  const [isClient, setIsClient] = useState(false);

  useEffect(() => {
    setIsClient(true);
  }, []);

  if (!isClient) {
    return <ConvexProvider client={convex}>{children}</ConvexProvider>;
  }

  return (
    <AuthKitProvider>
      <ConvexProviderWithAuthKit client={convex} useAuth={useAuthFromAuthKit}>
        {children}
      </ConvexProviderWithAuthKit>
    </AuthKitProvider>
  );
}

function useAuthFromAuthKit() {
  const { user, loading: isLoading } = useAuth();
  const { getAccessToken: gat, refresh } = useAccessToken();

  const isAuthenticated = !!user;

  const getAccessToken = useCallback(
    async ({ forceRefreshToken }: { forceRefreshToken?: boolean } = {}): Promise<string | null> => {
      if (!user) {
        return null;
      }

      try {
        if (forceRefreshToken) {
          return (await refresh()) ?? null;
        }

        return (await gat()) ?? null;
      } catch (error) {
        console.error("Failed to get access token:", error);
        return null;
      }
    },
    [user, refresh, gat],
  );

  return {
    isLoading,
    isAuthenticated,
    getAccessToken,
    user,
  };
}
