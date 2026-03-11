import { createFileRoute } from "@tanstack/react-router";
import { getAuth } from "@workos/authkit-tanstack-react-start";
import { buildAuthenticatedCliConfig, hasValidCliBearerToken } from "../../../../lib/cli-config";

export const Route = createFileRoute("/api/cli/auth/config")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          const auth = await getAuth();
          const isAuthorized = !!auth.user || (await hasValidCliBearerToken(request));

          if (!isAuthorized) {
            return Response.json(
              { error: "Unauthorized" },
              {
                status: 401,
              },
            );
          }

          return Response.json(buildAuthenticatedCliConfig(), {
            headers: {
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to build authenticated CLI config" },
            {
              status: 500,
            },
          );
        }
      },
    },
  },
});
