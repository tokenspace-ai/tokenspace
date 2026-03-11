import { createServer } from "node:net";

// Port range for random selection (avoiding well-known ports)
export const MIN_PORT = 10000;
export const MAX_PORT = 60000;

export function getRandomPort(): number {
  return Math.floor(Math.random() * (MAX_PORT - MIN_PORT + 1)) + MIN_PORT;
}

export async function isPortAvailable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once("error", () => {
      resolve(false);
    });
    server.once("listening", () => {
      server.close();
      resolve(true);
    });
    server.listen(port, "127.0.0.1");
  });
}

export async function getAvailablePort(excludePorts: number[] = []): Promise<number> {
  const maxAttempts = 100;
  for (let i = 0; i < maxAttempts; i++) {
    const port = getRandomPort();
    if (excludePorts.includes(port)) {
      continue;
    }
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`Could not find an available port after ${maxAttempts} attempts`);
}

// Convex uses port, port+1 (site proxy), and port+2 (dashboard)
export async function getAvailableConvexPort(): Promise<number> {
  const maxAttempts = 100;
  for (let i = 0; i < maxAttempts; i++) {
    const port = getRandomPort();
    // Check all three ports that Convex needs
    const [p0, p1, p2] = await Promise.all([
      isPortAvailable(port),
      isPortAvailable(port + 1),
      isPortAvailable(port + 2),
    ]);
    if (p0 && p1 && p2) {
      return port;
    }
  }
  throw new Error(`Could not find 3 consecutive available ports after ${maxAttempts} attempts`);
}

/**
 * Check if specific ports are available
 * @returns Array of ports that are NOT available (in use)
 */
export async function checkPortsAvailable(ports: number[]): Promise<number[]> {
  const results = await Promise.all(
    ports.map(async (port) => ({
      port,
      available: await isPortAvailable(port),
    })),
  );
  return results.filter((r) => !r.available).map((r) => r.port);
}
