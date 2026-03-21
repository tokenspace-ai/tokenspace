# Revision-Centric Workspace Architecture

## Summary

Tokenspace should treat `revisionId` as the only runtime contract.

Workspace source content should stop being the primary persisted backend model for runtime behavior. Instead:

- Git becomes the canonical source of workspace content and history when a workspace is Git-connected.
- Revisions are compiled from Git commits or from an explicit snapshot source.
- The mutable workspace file system becomes optional and exists only as an authoring convenience.
- Admin editing works through mutable branch states, not through per-user working file overlays plus `workingStateHash`.
- Chatting, execution, playground, credentials, and capability/runtime behavior all resolve from a selected revision.

This is a substantial simplification for the runtime path, but it does not eliminate the need for a mutable authoring state. The editor cannot point at an active revision directly, because revisions are immutable. The right replacement is a branch-state model.

## What Exists Today

Today the system has three different source-of-truth layers:

1. Workspace source history in Convex:
- `commits`
- `branches`
- `trees`
- `blobs`

2. Per-user mutable authoring state:
- `workingFiles`
- `workingStateHash`

3. Runtime/build artifacts:
- `revisions`
- `revisionFiles`
- `sessions`
- `sessionOverlayFiles`

The current flow is:

1. Admin edits committed tree content through `workingFiles`.
2. A compile request reads `branch.commitId`, overlays `workingFiles`, computes `workingStateHash`, and stores a compile snapshot.
3. The executor compiles from that snapshot into a revision.
4. Chats and code execution run against `revisionId`, not against the workspace tree.

That last point is important: the runtime is already largely revision-centric.

## Key Observation

The compile executor is already closer to the target model than the authoring APIs are.

Compile jobs already ship a self-contained source snapshot to the executor:

- `compile.ts` builds a snapshot and stores it in `compileJobs.snapshotStorageId`
- `compileJobs.getCompileJobSnapshot` exposes `snapshotUrl`
- `services/executor/src/compile-job-runner.ts` fetches that snapshot and compiles it in a temp workspace

That means the compiler/runtime do not fundamentally need the persisted Convex workspace filesystem tables. The main coupling is in:

- how compile snapshots are produced
- how revisions are deduplicated
- how the UI resolves editable state
- how publish/default behavior is modeled

## Current Areas That Depend On Workspace Filesystem State

### Already revision-centric or close to it

These flows already use `revisionId` as the real input and can move to an active-revision model with little conceptual change:

- Chats and sessions
- Tool execution
- Playground runs
- Session overlay filesystem
- Revision file serving via `/api/fs/file`
- Capability/type exploration from revision files
- Credential requirements and runtime credential resolution
- Runtime model selection from `revision.models`

In other words: runtime behavior is already driven by revisions.

### Still coupled to branch head plus working state

These flows currently rely on stored workspace source state and cannot simply point to `activeRevisionId`:

- Admin editor
- Working changes sidebar/diff UI
- Branch creation/merge/delete
- Commit history UI
- Model editing in `src/models.yaml`
- Workspace icon resolution from committed tree files
- Compile enqueue and compile dedupe
- URL/context resolution based on `workspace:branch:workingStateHash`
- CLI `push`, which syncs local Git files into Convex working files before compiling
- `setActiveCommit`, which publishes a commit rather than a revision

These are authoring concerns, not runtime concerns.

## Problems With The Current Model

### Runtime state and source state are different objects

The system publishes `activeCommitId`, but users actually run against revisions. That means the published thing and the executed thing are not the same object.

### `workingStateHash` is a leaky implementation detail

It appears in URLs and revision lookup, but it is not a first-class authoring concept. It exists mostly to dedupe builds for a per-user overlay.

### Workspace content is duplicated

For Git-backed workspaces, source content exists:

- in Git
- in Convex trees/blobs/commits
- in `workingFiles`
- again in compile snapshots
- again in revisions

This is too much duplication for the value it provides.

### The runtime depends on compiled revisions anyway

Because execution already depends on revisions, persisting full workspace history inside Tokenspace is mostly serving the editor/VCS layer, not the runtime layer.

## Design Goals

- Make revisions the single runtime unit.
- Publish revisions, not commits.
- Remove `workingStateHash`.
- Make mutable workspace source optional.
- Let Git own source history for Git-backed workspaces.
- Keep a good admin editing experience for ad hoc changes.
- Preserve session overlays on top of immutable revisions.
- Allow non-Git workspaces to continue working through snapshot-based source states.

## Non-Goals

- Replacing the session overlay filesystem.
- Eliminating `revisionFiles` immediately.
- Solving full Git sync UX in this document.
- Designing a perfect merge engine for ad hoc branch states.

## Proposed Model

### 1. Revisions become the only runtime input

Every runtime path should take a `revisionId` or resolve one from a stable workspace-level pointer.

The workspace should publish:

- `activeRevisionId`

instead of:

- `activeCommitId`

All member-facing functionality should default to `activeRevisionId`.

### 2. Introduce branch states as the mutable authoring abstraction

A branch state is a mutable admin-facing source context used for editing and compiling. It replaces the combination of:

- branch head commit
- per-user `workingFiles`
- `workingStateHash`

A branch state should represent one of two things:

- a Git-backed source branch
- an ad hoc snapshot branch with no history

Suggested conceptual shape:

```ts
type BranchState =
  | {
      id: string;
      workspaceId: string;
      name: string;
      kind: "git";
      isMain: boolean;
      gitConnectionId: string;
      gitBranch: string;
      headCommitSha?: string;
      draftSnapshotId?: string;
      lastCompiledRevisionId?: string;
      publishedRevisionId?: string;
      createdAt: number;
      updatedAt: number;
    }
  | {
      id: string;
      workspaceId: string;
      name: string;
      kind: "snapshot";
      isMain: boolean;
      baseRevisionId?: string;
      snapshotId: string;
      lastCompiledRevisionId?: string;
      publishedRevisionId?: string;
      createdAt: number;
      updatedAt: number;
    };
```

Important properties:

- Branch states are mutable.
- Revisions are immutable.
- Runtime resolves revisions.
- Admin tooling resolves branch states.

### 3. Git becomes canonical when connected

For Git-backed workspaces:

- Tokenspace no longer stores full source history as `commits`/`trees`/`blobs`.
- A branch state points at a Git branch and optionally caches the last observed head commit SHA.
- Compiling a clean Git branch state means compiling a specific Git commit.
- Publishing means promoting the resulting revision, not promoting a commit record inside Tokenspace.

### 4. Snapshot source remains available for non-Git or ad hoc editing

For non-Git workspaces, or for admin-only draft editing:

- the source can live as a snapshot blob
- it does not need full history
- it can be created from:
  - the current Git commit checkout
  - the current active revision's source snapshot
  - the current main branch state's snapshot

This satisfies the "branch that does not have history" requirement.

### 5. Revisions carry source provenance

Revisions should stop keying identity off `(branchId, commitId, workingStateHash)`.

Instead, they should record something like:

```ts
type RevisionSource =
  | {
      kind: "git_commit";
      gitConnectionId: string;
      repo: string;
      branch: string;
      commitSha: string;
      subdir?: string;
    }
  | {
      kind: "snapshot";
      snapshotId: string;
      snapshotHash: string;
      baseRevisionId?: string;
    };
```

Revision dedupe should be based on:

- source identity
- artifact fingerprint

not on `workingStateHash`.

## Compile Flow In The Proposed Model

### Git-backed branch state

1. Resolve branch state's Git branch.
2. Resolve or fetch a concrete head commit SHA.
3. Materialize a source snapshot from that commit.
4. If the branch state has draft edits, overlay them onto the source snapshot.
5. Enqueue compile from that snapshot.
6. Create or reuse a revision keyed by source provenance plus artifact fingerprint.
7. Store the resulting revision on the branch state as `lastCompiledRevisionId`.

### Snapshot-backed branch state

1. Load the branch state's snapshot.
2. Enqueue compile from that snapshot.
3. Create or reuse a revision keyed by snapshot hash plus artifact fingerprint.
4. Store the resulting revision on the branch state.

### Important consequence

The existing executor-side compiler path can mostly stay the same.

The main change is upstream:

- replace "build snapshot from tree + working files" with "resolve branch state into snapshot"

## Can Everything Just Point To An Active Revision?

No.

### Yes for runtime

These should point to active revision or to an explicitly selected revision:

- chat
- session creation
- code execution
- playground
- credentials UI for runtime behavior
- capability explorer
- revision file browser
- member-facing app routes

### No for authoring

These need a mutable source context, so they cannot point only to active revision:

- editor
- diff against pending changes
- branch management
- model editing before compile
- draft icon/settings edits
- compile input selection

The correct split is:

- runtime resolves `revisionId`
- authoring resolves `branchStateId`

## Proposed URL And Context Model

Current URLs encode:

- workspace
- branch
- `workingStateHash`
- or explicit revision

Proposed URLs should encode:

- workspace
- optional branch state name
- optional explicit revision

Examples:

- `workspace`
  - member default, resolves to `activeRevisionId`
- `workspace:main`
  - admin editing the main branch state
- `workspace:experiment`
  - admin editing an ad hoc branch state
- `workspace@revisionId`
  - explicit immutable revision view

`workingStateHash` should disappear from URLs entirely.

## Data Model Changes

### Workspace

Replace:

- `activeCommitId`

With:

- `activeRevisionId`
- optionally `mainBranchStateId`

### Revision

Keep:

- compiled artifacts
- cached prompt metadata
- cached models
- cached credential requirements

Change:

- source identity should no longer depend on `branchId`, `commitId`, `workingStateHash`
- add explicit source provenance

### Branch state

Add a new table for mutable authoring state.

### Remove or retire

Eventually remove for Git-backed workspaces:

- `workingFiles`
- `workingStateHash`
- `commits`
- `branches`
- `trees`
- `blobs`

During transition, some of these may remain for legacy workspaces or migration support.

## Impact By Area

### Backend/runtime

Can move cleanly to active revision:

- `ai/chat.ts`
- `ai/tools.ts`
- `playground.ts`
- `fs/operations.ts`
- `http.ts`
- credential resolution against revision metadata

These are already fundamentally revision-based.

### Backend/authoring

Need rework around branch states:

- `workspace.getRevision`
- `workspace.ensureRevision`
- `workspace.getCurrentWorkingStateHash`
- `vcs.ts`
- `compile.ts`
- `revisions.findRevision`
- `revisionBuild.ts`
- model-editing helpers in `workspace.ts`
- icon/settings reads from commit trees

### Web app

Can become revision-first:

- member app shell
- chat routes
- playground
- capabilities
- credentials pages that already consume `revisionId`

Need branch-state refactor:

- admin editor
- branch selector
- diff dialog
- commit panel
- compile sidebar
- model editor
- any UI currently showing working changes or commit publish state

### CLI

Needs a major simplification:

Current `tokenspace push` flow:

- sync local files into Convex working files
- compute `workingStateHash`
- compile that state

Target flow:

- build locally from the actual local Git worktree
- push revision artifacts directly
- attach source provenance
- optionally update a branch state or publish the resulting revision

That removes the server-side "workspace source sync" step entirely for Git-backed workspaces.

## Migration Strategy

### Phase 1: Make runtime explicitly revision-published

- Add `workspace.activeRevisionId`
- Update member-facing resolution to prefer active revision
- Rename publish semantics from commit-based to revision-based
- Keep existing source tables for now

### Phase 2: Introduce branch states

- Add branch-state table
- Create one main branch state per workspace
- Resolve admin/editor routes through branch state instead of `workingStateHash`
- Replace per-user working overlays with branch-state draft snapshots

### Phase 3: Change compile input resolution

- Compile from branch-state source snapshots
- Add revision source provenance
- Deduplicate revisions using source provenance instead of `workingStateHash`

### Phase 4: Simplify Git-backed workspaces

- Stop writing Git-backed source content into `commits`/`trees`/`blobs`
- Remove `workingFiles` from Git-backed flows
- Rewrite CLI push

### Phase 5: Remove legacy filesystem/VCS tables where possible

- Drop `workingStateHash`
- Retire old branch/commit/tree/blob usage
- Keep only what is still needed for non-Git snapshot-backed workspaces, if any

## Migration Notes For Existing Data

- `activeCommitId` must be mapped to an `activeRevisionId`
- if a revision does not yet exist for the currently active commit, compile one during migration
- each existing branch can become a branch state
- existing working files can be collapsed into a draft snapshot attached to that branch state

## Open Questions

### What is the merge story for branch states?

If branch states are just mutable snapshots, merges can be much simpler than Git, but the UX has to be explicit:

- snapshot replace
- three-way merge
- "promote this draft to main"

This should probably be intentionally simpler than pretending Tokenspace is a full Git host.

### Should ad hoc branch states be per-admin or shared?

Branch states should be shared collaboration objects, not per-user overlays.

The right default is:

- when an admin starts making changes from the main state, Tokenspace auto-creates a new unique branch state for them
- changes only overlap when multiple admins explicitly choose to work in the same branch state

That keeps accidental collisions low without making draft state private or introducing another per-user working layer.

### How should admin previews work before compile?

Some things, like models or icons, can be previewed from the branch-state snapshot directly. Runtime behavior still requires a compiled revision.

### Should `revisionFiles` remain materialized?

Probably yes initially. They are not the same problem as the workspace source filesystem. They are a read-optimized materialization of compiled revision content and still fit the revision-centric model.

## Recommendation

The clean target is:

- Git or snapshot branch states are the mutable source layer
- revisions are the immutable runtime layer
- workspaces publish an active revision
- sessions overlay on top of revisions

The main thing to avoid is replacing the current workspace filesystem with "active revision only." That would remove the mutable authoring surface entirely.

Instead, the right move is:

- make runtime fully revision-based
- make source storage optional
- replace `workingStateHash` with explicit branch states
- let Git own history whenever Git exists

## Concrete Next Steps

1. Introduce `workspace.activeRevisionId` and switch publish semantics to revisions.
2. Add a `branchStates` table and move admin context resolution to it.
3. Redesign compile dedupe around source provenance instead of `workingStateHash`.
4. Rewrite CLI `push` to publish revisions from local Git/worktree state without syncing source files into Convex.
5. Remove `workingStateHash` from URLs and replace it with branch-state addressing.
