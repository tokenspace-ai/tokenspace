import { createFileRoute } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import { useAction } from "convex/react";
import { useEffect, useRef, useState } from "react";

export const Route = createFileRoute("/oauth/callback")({
  component: OAuthCallbackRoute,
  ssr: false,
});

type CallbackPhase = "processing" | "success" | "failed";

function OAuthCallbackRoute() {
  const completeOAuthConnect = useAction(api.credentials.completeOAuthConnect);
  const hasStartedRef = useRef(false);
  const [phase, setPhase] = useState<CallbackPhase>("processing");
  const [message, setMessage] = useState("Finalizing OAuth connection...");

  useEffect(() => {
    if (hasStartedRef.current) {
      return;
    }
    hasStartedRef.current = true;

    const run = async () => {
      const query = new URLSearchParams(window.location.search);
      const hash = new URLSearchParams(window.location.hash.startsWith("#") ? window.location.hash.slice(1) : "");
      const state = query.get("state") ?? hash.get("state");

      if (!state) {
        setPhase("failed");
        setMessage("OAuth callback is missing state. Please retry connecting the credential.");
        return;
      }

      const hashParams = {
        accessToken: hash.get("access_token") ?? undefined,
        tokenType: hash.get("token_type") ?? undefined,
        expiresIn: hash.get("expires_in") ?? undefined,
        expiresAt: hash.get("expires_at") ?? undefined,
        scope: hash.get("scope") ?? undefined,
        refreshToken: hash.get("refresh_token") ?? undefined,
        error: hash.get("error") ?? undefined,
        errorDescription: hash.get("error_description") ?? undefined,
      };
      const hasHashParams = Object.values(hashParams).some((value) => value !== undefined);

      try {
        const result = await completeOAuthConnect({
          state,
          code: query.get("code") ?? undefined,
          error: query.get("error") ?? undefined,
          errorDescription: query.get("error_description") ?? undefined,
          hashParams: hasHashParams ? hashParams : undefined,
        });

        setPhase(result.success ? "success" : "failed");
        setMessage(result.success ? "Credential connected. Redirecting..." : result.message || "OAuth connect failed.");
        const delay = result.success ? 400 : 1200;
        window.setTimeout(() => {
          window.location.replace(result.redirectPath);
        }, delay);
      } catch (error) {
        setPhase("failed");
        setMessage(error instanceof Error ? error.message : "OAuth connect failed.");
      }
    };

    void run();
  }, [completeOAuthConnect]);

  return (
    <main className="flex min-h-screen items-center justify-center px-4">
      <div className="w-full max-w-md rounded-lg border bg-card p-6">
        <h1 className="text-base font-semibold">OAuth Callback</h1>
        <p className="mt-2 text-sm text-muted-foreground">{message}</p>
        <p className="mt-4 text-xs text-muted-foreground">
          Status:{" "}
          <span className="font-mono text-foreground">
            {phase === "processing" ? "processing" : phase === "success" ? "success" : "failed"}
          </span>
        </p>
      </div>
    </main>
  );
}
