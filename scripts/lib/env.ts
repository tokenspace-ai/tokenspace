const ENV_FILE = ".env";

export async function envFileExists(): Promise<boolean> {
  const envFile = Bun.file(ENV_FILE);
  return envFile.exists();
}

export async function readEnvFile(): Promise<string> {
  const envFile = Bun.file(ENV_FILE);
  if (!(await envFile.exists())) {
    throw new Error(`.env file not found at ${ENV_FILE}`);
  }
  return envFile.text();
}

export async function writeEnvFile(content: string): Promise<void> {
  await Bun.write(ENV_FILE, content);
}

export function parseEnvFile(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const eqIndex = trimmed.indexOf("=");
    if (eqIndex > 0) {
      const key = trimmed.slice(0, eqIndex);
      const value = trimmed.slice(eqIndex + 1);
      env[key] = value;
    }
  }
  return env;
}

export function updateEnvValue(content: string, key: string, newValue: string): string {
  const regex = new RegExp(`^${key}=.*$`, "m");
  if (regex.test(content)) {
    return content.replace(regex, `${key}=${newValue}`);
  }
  // If key doesn't exist, append it
  return `${content.trimEnd()}\n${key}=${newValue}\n`;
}

export function getEnvValue(env: Record<string, string>, key: string): string | undefined {
  return env[key];
}

/**
 * Extract port from a URL string
 */
export function extractPortFromUrl(url: string): number | null {
  try {
    const parsed = new URL(url);
    const port = parsed.port;
    if (port) {
      return Number.parseInt(port, 10);
    }
    // Default ports
    if (parsed.protocol === "https:") return 443;
    if (parsed.protocol === "http:") return 80;
    return null;
  } catch {
    return null;
  }
}
