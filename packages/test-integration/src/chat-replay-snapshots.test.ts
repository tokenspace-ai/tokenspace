import { beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { getSharedContext, getSharedHarness, waitForSetup } from "./setup";
import { getFunctionName, internal, REPLAY_FIXTURES_DIR, type TestContext } from "./test-utils";

type ReplayFixture = {
  recordingId: string;
  displayName?: string;
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

type TestChat = {
  chatId: string;
  threadId: string;
  sessionId: string;
};

type TestChatStatus = {
  status?: "streaming" | "awaiting_tool_results" | "completed" | "failed" | "stopped" | "waiting_for_approval";
};

type MessageDoc = {
  role: string;
  parts: Array<Record<string, unknown>>;
};

type ReplayPlaybackSettings = {
  initialDelayMs?: number;
  chunkDelayMs?: number;
};

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function loadReplayFixtures(): ReplayFixture[] {
  if (!fs.existsSync(REPLAY_FIXTURES_DIR)) {
    return [];
  }

  const fixtures: ReplayFixture[] = [];
  const files = fs
    .readdirSync(REPLAY_FIXTURES_DIR)
    .filter((name) => name.endsWith(".json"))
    .sort((a, b) => a.localeCompare(b));

  for (const fileName of files) {
    const fullPath = path.join(REPLAY_FIXTURES_DIR, fileName);
    const parsed = JSON.parse(fs.readFileSync(fullPath, "utf-8")) as {
      recordingId?: unknown;
      displayName?: unknown;
      playbackSettings?: unknown;
      toolOutcomes?: unknown;
      recording?: unknown;
    };
    if (typeof parsed.recordingId !== "string" || parsed.recording === undefined) {
      throw new Error(`Invalid replay fixture: ${fullPath}`);
    }
    fixtures.push({
      recordingId: parsed.recordingId,
      displayName: typeof parsed.displayName === "string" ? parsed.displayName : undefined,
      playbackSettings:
        parsed.playbackSettings &&
        typeof parsed.playbackSettings === "object" &&
        !Array.isArray(parsed.playbackSettings)
          ? (parsed.playbackSettings as ReplayFixture["playbackSettings"])
          : undefined,
      toolOutcomes: Array.isArray(parsed.toolOutcomes)
        ? (parsed.toolOutcomes as ReplayFixture["toolOutcomes"])
        : undefined,
      recording: parsed.recording,
    });
  }

  return fixtures;
}

function getFixtureTurnCount(recording: unknown): number {
  if (!recording || typeof recording !== "object" || Array.isArray(recording)) {
    return 1;
  }
  const turns = (recording as { turns?: unknown }).turns;
  return Array.isArray(turns) && turns.length > 0 ? turns.length : 1;
}

async function getChatStatus(chatId: string): Promise<TestChatStatus | null> {
  const backend = getSharedHarness().getBackend();
  return (await backend.runFunction(getFunctionName(internal.ai.chat.getTestChatStatus), {
    chatId,
  })) as TestChatStatus | null;
}

async function waitForChatCompletion(chatId: string, timeoutMs = 120000): Promise<void> {
  const startTime = Date.now();
  while (Date.now() - startTime < timeoutMs) {
    const status = await getChatStatus(chatId);
    if (status?.status === "completed") {
      return;
    }
    if (status?.status === "failed" || status?.status === "stopped") {
      throw new Error(`Chat ${chatId} ended with status ${status.status}`);
    }
    await sleep(100);
  }
  const finalStatus = await getChatStatus(chatId);
  throw new Error(
    `Chat ${chatId} did not complete within ${timeoutMs}ms. Last status: ${finalStatus?.status ?? "unknown"}`,
  );
}

async function getMessages(threadId: string): Promise<MessageDoc[]> {
  const backend = getSharedHarness().getBackend();
  return (await backend.runFunction(getFunctionName(internal.ai.thread.listMessages), {
    threadId,
  })) as MessageDoc[];
}

async function replayFixtureOnce(
  fixture: ReplayFixture,
  args: { revisionId: string; playbackSettings: ReplayPlaybackSettings },
) {
  const backend = getSharedHarness().getBackend();
  const turnCount = getFixtureTurnCount(fixture.recording);

  await backend.runFunction(getFunctionName(internal.ai.replay.upsertReplayRecordingFixture), {
    recordingId: fixture.recordingId,
    displayName: fixture.displayName ?? fixture.recordingId,
    showInReplayModelPicker: true,
    playbackSettings: args.playbackSettings,
    toolOutcomes: fixture.toolOutcomes,
    recording: fixture.recording,
  });

  const chat = (await backend.runFunction(getFunctionName(internal.ai.chat.createTestChat), {
    revisionId: args.revisionId,
    modelId: `mock:replay:${fixture.recordingId}`,
  })) as TestChat;

  for (let turn = 0; turn < turnCount; turn++) {
    await backend.runFunction(getFunctionName(internal.ai.chat.sendTestMessage), {
      threadId: chat.threadId,
      prompt: `snapshot turn ${turn + 1}`,
    });
    await waitForChatCompletion(chat.chatId);
  }

  const messages = await getMessages(chat.threadId);
  for (const message of messages) {
    (message as any)._id = "<_id>";
    if ("id" in message) message.id = "<id>";
    if ("_creationTime" in message) message._creationTime = 0;
    if ("threadId" in message) message.threadId = "<threadId>";
  }
  return {
    turnCount,
    assistantTranscript: messages,
  };
}

const replayFixtures = loadReplayFixtures();

describe("Replay Fixture Snapshots", () => {
  let context: TestContext;

  beforeAll(async () => {
    await waitForSetup();
    context = getSharedContext();
  });

  for (const fixture of replayFixtures) {
    it(`replays ${fixture.recordingId} and matches snapshot`, async () => {
      const fastReplay = await replayFixtureOnce(fixture, {
        revisionId: context.revisionId,
        playbackSettings: { initialDelayMs: 0, chunkDelayMs: 0 },
      });
      const delayedReplay = await replayFixtureOnce(fixture, {
        revisionId: context.revisionId,
        playbackSettings: {
          initialDelayMs: Math.min(50, Math.max(1, Math.floor(fixture.playbackSettings?.initialDelayMs ?? 40))),
          chunkDelayMs: 50,
        },
      });

      expect({
        recordingId: fixture.recordingId,
        turns: delayedReplay.turnCount,
        assistantTranscript: delayedReplay.assistantTranscript,
      }).toMatchSnapshot();

      expect(delayedReplay.assistantTranscript).toEqual(fastReplay.assistantTranscript);
    }, 120000);
  }
});
