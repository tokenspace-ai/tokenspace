import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import { tanstackStart } from "@tanstack/react-start/plugin/vite";
import viteReact from "@vitejs/plugin-react";
import { nitro } from "nitro/vite";
import { defineConfig } from "vite";
import { consoleForwardPlugin } from "./vite-console-forward";

const IS_VERCEL_BUILD = ["production", "preview"].includes(process.env.VERCEL_ENV ?? "");

function loadPortFromEnvironment() {
  if (IS_VERCEL_BUILD) return;
  const port = Number.parseInt(process.env.WEB_PORT ?? "----", 10);
  if (Number.isNaN(port)) {
    throw new Error("WEB_PORT is not defined");
  }
  return port;
}

export default defineConfig({
  resolve: {
    tsconfigPaths: true,
  },
  server: {
    port: loadPortFromEnvironment(),
  },
  plugins: [
    tailwindcss(),
    tanstackStart(),
    nitro(),
    viteReact(),
    consoleForwardPlugin({
      enabled: !IS_VERCEL_BUILD,
      endpoint: "/__debug/client-logs",
      logFilePath: path.join(__dirname, "..", "..", "logs", "browser.log"),
      ignorePatterns: [/^\[vite\]/, /Download the React DevTools for a better development experience/],
    }),
  ],
  optimizeDeps: {
    include: ["cookie"],
  },
});
