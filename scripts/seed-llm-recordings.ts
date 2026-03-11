import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { getAdminKey, getConvexUrl, runInternalFunction } from "./lib/seed";

type ReplayFixture = {
  recordingId: string;
  displayName: string;
  showInReplayModelPicker: boolean;
  playbackSettings?: {
    initialDelayMs?: number;
    chunkDelayMs?: number;
  };
  toolOutcomes?: Array<{
    toolCallId: string;
    toolName: string;
    args?: unknown;
    status: "result" | "error";
    result?: unknown;
    error?: string;
  }>;
  recording: unknown;
};

const DEFAULT_FIXTURES_DIR = path.join(import.meta.dir, "../packages/test-integration/fixtures/replay-recordings");

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

function toDisplayNameFromFixtureFile(fileName: string): string {
  const baseName = path.basename(fileName, path.extname(fileName));
  const normalized = baseName.replace(/[_-]+/g, " ").trim();
  if (!normalized) {
    return baseName;
  }
  return normalized.replace(/\b\w/g, (char) => char.toUpperCase());
}

function normalizePlaybackSettings(input: unknown): ReplayFixture["playbackSettings"] {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return undefined;
  }
  const record = input as Record<string, unknown>;
  const initialDelayMs =
    typeof record.initialDelayMs === "number" && Number.isFinite(record.initialDelayMs) && record.initialDelayMs >= 0
      ? Math.floor(record.initialDelayMs)
      : undefined;
  const chunkDelayMs =
    typeof record.chunkDelayMs === "number" && Number.isFinite(record.chunkDelayMs) && record.chunkDelayMs >= 0
      ? Math.floor(record.chunkDelayMs)
      : undefined;
  if (initialDelayMs === undefined && chunkDelayMs === undefined) {
    return undefined;
  }
  return {
    ...(initialDelayMs !== undefined ? { initialDelayMs } : {}),
    ...(chunkDelayMs !== undefined ? { chunkDelayMs } : {}),
  };
}

function normalizeToolOutcomes(input: unknown): ReplayFixture["toolOutcomes"] {
  if (!Array.isArray(input)) {
    return undefined;
  }
  const outcomes = input
    .map((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        return null;
      }
      const record = value as Record<string, unknown>;
      if (typeof record.toolCallId !== "string" || typeof record.toolName !== "string") {
        return null;
      }
      const status: "result" | "error" | null =
        record.status === "result" ? "result" : record.status === "error" ? "error" : null;
      if (status === null) {
        return null;
      }
      return {
        toolCallId: record.toolCallId,
        toolName: record.toolName,
        args: record.args,
        status,
        result: record.result,
        error: typeof record.error === "string" ? record.error : undefined,
      };
    })
    .filter((value): value is NonNullable<typeof value> => value !== null);
  return outcomes;
}

function readFixtureFile(filePath: string, fileName: string): ReplayFixture[] {
  const raw = readFileSync(filePath, "utf-8");
  const parsed = JSON.parse(raw) as unknown;
  const defaultDisplayName = toDisplayNameFromFixtureFile(fileName);

  if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
    const wrapper = parsed as {
      recordingId?: unknown;
      displayName?: unknown;
      showInReplayModelPicker?: unknown;
      playbackSettings?: unknown;
      toolOutcomes?: unknown;
      recording?: unknown;
    };
    if (typeof wrapper.recordingId === "string" && wrapper.recording !== undefined) {
      return [
        {
          recordingId: wrapper.recordingId,
          displayName: typeof wrapper.displayName === "string" ? wrapper.displayName : defaultDisplayName,
          showInReplayModelPicker:
            typeof wrapper.showInReplayModelPicker === "boolean" ? wrapper.showInReplayModelPicker : true,
          playbackSettings: normalizePlaybackSettings(wrapper.playbackSettings),
          toolOutcomes: normalizeToolOutcomes(wrapper.toolOutcomes),
          recording: wrapper.recording,
        },
      ];
    }

    const entries = Object.entries(parsed);
    if (entries.length > 0) {
      return entries.map(([recordingId, recording]) => ({
        recordingId,
        displayName: defaultDisplayName,
        showInReplayModelPicker: true,
        playbackSettings: undefined,
        toolOutcomes: undefined,
        recording,
      }));
    }
  }

  throw new Error(`Invalid replay fixture format: ${filePath}`);
}

async function main(): Promise<void> {
  const fixturesDir = getArgValue("--fixtures") ?? DEFAULT_FIXTURES_DIR;
  if (!existsSync(fixturesDir)) {
    throw new Error(`Fixtures directory does not exist: ${fixturesDir}`);
  }

  const convexUrl = getConvexUrl();
  const adminKey = getAdminKey();

  const files = readdirSync(fixturesDir)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));
  if (files.length === 0) {
    console.log("No fixture files found.");
    return;
  }

  console.log(`Seeding replay recordings from ${fixturesDir}`);

  let count = 0;
  for (const fileName of files) {
    const filePath = path.join(fixturesDir, fileName);
    const fixtures = readFixtureFile(filePath, fileName);
    for (const fixture of fixtures) {
      await runInternalFunction(convexUrl, adminKey, "ai/replay:upsertReplayRecordingFixture", {
        recordingId: fixture.recordingId,
        displayName: fixture.displayName,
        showInReplayModelPicker: fixture.showInReplayModelPicker,
        playbackSettings: fixture.playbackSettings,
        toolOutcomes: fixture.toolOutcomes,
        recording: fixture.recording,
      });
      count += 1;
      console.log(`  seeded ${fixture.recordingId} (${fileName})`);
    }
  }

  console.log(`Done. Seeded ${count} recording(s).`);
}

main().catch((error) => {
  console.error("Seed failed:", error);
  process.exit(1);
});
