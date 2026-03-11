# Integration Tests

## Chat Recording How-to

1. Enable recording on your dev backend:
   - `TOKENSPACE_RECORD_LLM=true`

2. (Optional, to replay in the UI) enable replay model listing:
   - `TOKENSPACE_REPLAY_LLM=true`

3. Run a chat normally (UI or API). Recordings are written automatically to the `llmRecordings` Convex table.

4. Export recordings into integration-test fixtures:
   - `bun run llm:recordings:export`

5. Replay a recording by selecting model `mock:replay:<recordingId>`.
   - In the UI, replay models are injected into the model picker when `TOKENSPACE_REPLAY_LLM=true`.

## Integration Test Fixtures

- Replay fixtures live in `packages/test-integration/fixtures/replay-recordings/*.json`.
- Integration test setup seeds these fixtures into the `llmRecordings` table automatically.
- To seed fixtures into a running dev backend manually:
  - `bun run llm:recordings:seed`
