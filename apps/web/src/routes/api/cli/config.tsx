import { createFileRoute } from "@tanstack/react-router";
import { buildPublicCliConfig } from "../../../lib/cli-config";

export const Route = createFileRoute("/api/cli/config")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        try {
          return Response.json(buildPublicCliConfig(request), {
            headers: {
              "Cache-Control": "no-store",
            },
          });
        } catch (error) {
          return Response.json(
            { error: error instanceof Error ? error.message : "Failed to build CLI config" },
            {
              status: 500,
            },
          );
        }
      },
    },
  },
});
