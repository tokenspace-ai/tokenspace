import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { getAdminKey, getConvexUrl, runInternalFunction } from "./lib/seed";

type ReplayRecordingExport = {
  recordingId: string;
  displayName?: string;
  showInReplayModelPicker: boolean;
  playbackSettings?: {
    initialDelayMs?: number;
    chunkDelayMs?: number;
  };
  toolOutcomes: Array<{
    toolCallId: string;
    toolName: string;
    args?: unknown;
    status: "result" | "error";
    result?: unknown;
    error?: string;
  }>;
  recording: unknown;
};

const DEFAULT_OUTPUT_DIR = path.join(import.meta.dir, "../packages/test-integration/fixtures/replay-recordings");

function getArgValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  if (index < 0) return undefined;
  return process.argv[index + 1];
}

async function main(): Promise<void> {
  const convexUrl = getConvexUrl();
  const adminKey = getAdminKey();
  const outputDir = getArgValue("--out") ?? DEFAULT_OUTPUT_DIR;
  const recordingIdFilter = getArgValue("--recording");

  console.log(`Exporting LLM recordings from ${convexUrl}`);
  console.log(`Output directory: ${outputDir}`);
  if (recordingIdFilter) {
    console.log(`Recording filter: ${recordingIdFilter}`);
  }

  const recordings = await runInternalFunction<ReplayRecordingExport[]>(
    convexUrl,
    adminKey,
    "ai/replay:listReplayRecordingsForExport",
    {},
  );

  const filtered = recordingIdFilter
    ? recordings.filter((recording) => recording.recordingId === recordingIdFilter)
    : recordings;

  if (filtered.length === 0) {
    console.log("No recordings matched.");
    return;
  }

  mkdirSync(outputDir, { recursive: true });

  for (const recording of filtered) {
    const fileName = `${encodeURIComponent(recording.recordingId)}.json`;
    const filePath = path.join(outputDir, fileName);
    const fileContent = `${JSON.stringify(
      {
        recordingId: recording.recordingId,
        displayName: recording.displayName,
        showInReplayModelPicker: recording.showInReplayModelPicker,
        playbackSettings: recording.playbackSettings,
        toolOutcomes: recording.toolOutcomes,
        recording: recording.recording,
      },
      null,
      2,
    )}\n`;
    writeFileSync(filePath, fileContent, "utf-8");
    console.log(`  wrote ${fileName}`);
  }

  console.log(`Done. Exported ${filtered.length} recording(s).`);
}

main().catch((error) => {
  console.error("Export failed:", error);
  process.exit(1);
});
