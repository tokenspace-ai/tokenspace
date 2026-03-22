# Git-Backed Revision Source Plan

## Summary

The next milestone should make the revision source contract real by adding a Git-backed source kind and a source-resolution layer that can compile from either:

- a Git commit
- a branch-state snapshot

This is the first slice where Tokenspace starts becoming Git-first instead of "Convex VCS with cleaner wrappers."

## Current Baseline

The workspace architecture has already moved substantially toward the target model:

- member-facing runtime publishes and resolves `workspace.activeRevisionId`
- admin authoring uses shared `branchStates`
- `workingStateHash` is no longer part of the web or CLI contract
- branch-state compile dedupe uses `sourceSnapshotHash`
- revision-build APIs now accept an explicit source object

Current source resolution is still compatibility-based:

- `branchState` resolves to a backing Convex `branch`
- compile input is still materialized from Convex `branches` / `commits` / `trees` / `blobs`
- mutable drafts still live in `workingFiles`

There is not yet a real Git-backed source resolver in the backend. The existing admin Git Sync page is still a placeholder.

## Goal Of This Slice

Add a Git-backed revision source kind so a revision can be compiled from a Git commit without first copying repository history into Convex VCS tables.

After this slice:

- compile and revision-build can resolve source from either `gitCommit` or `branchState`
- Git-connected workspaces can treat Git commit identity as the canonical source provenance
- branch states remain the mutable authoring abstraction for ad hoc changes
- Convex VCS tables become compatibility scaffolding instead of the canonical history model

## Source Contract

The target contract should look conceptually like:

```ts
type RevisionBuildSource =
  | {
      kind: "gitCommit";
      workspaceId: Id<"workspaces">;
      commitSha: string;
      repoRef: string;
      branch?: string;
      subdir?: string;
    }
  | {
      kind: "branchState";
      branchStateId: Id<"branchStates">;
      sourceSnapshotHash?: string;
    };
```

Notes:

- `branchState` stays as the mutable admin source.
- `gitCommit` becomes the immutable Git-backed source.
- The current legacy `branch` source kind can remain internally for transition support, but new product-facing flows should not depend on it.

## Source Resolver Layer

Introduce a source resolver boundary whose job is:

1. validate that the source belongs to the target workspace
2. resolve the source to a normalized source snapshot
3. compute stable source provenance and dedupe identity
4. hand the resulting snapshot to the existing compile pipeline

That resolver should have at least two implementations.

### Branch-state resolver

Responsibilities:

- load the branch state's backing baseline
- overlay shared branch-state draft files
- normalize the resulting file set
- compute `sourceSnapshotHash`
- return source provenance derived from branch-state snapshot identity

### Git-commit resolver

Responsibilities:

- resolve workspace Git configuration
- materialize repository files for a specific commit SHA
- apply workspace subdirectory rules if needed
- normalize the resulting file set
- compute stable snapshot identity for that commit's file set
- return Git provenance based on commit identity

The compile layer should not need to know which resolver produced the snapshot.

## Data Model And Provenance

Revisions should carry explicit source provenance for both source kinds.

Conceptually:

```ts
type RevisionSourceProvenance =
  | {
      kind: "gitCommit";
      commitSha: string;
      repoRef: string;
      branch?: string;
      subdir?: string;
    }
  | {
      kind: "branchState";
      branchStateId: Id<"branchStates">;
      commitId: Id<"commits">;
      sourceSnapshotHash?: string;
    };
```

Important rules:

- identical Git commit sources should dedupe regardless of who triggered the build
- identical branch-state snapshots should dedupe regardless of editor session
- Git provenance should not depend on Convex branch ids
- branch-state provenance may still temporarily reference backing Convex commit ids during migration

## Backend Work

1. Add `gitCommit` to the revision source schema and generated API surface.
2. Implement a Git source materializer that can fetch or reconstruct the file tree for a specific commit SHA.
3. Introduce a shared normalized-snapshot representation used by both Git and branch-state resolvers.
4. Route compile and revision-build through the resolver boundary instead of directly through Convex branch helpers.
5. Store Git source provenance on compile jobs and revisions.
6. Add dedupe lookup paths for Git-backed revisions keyed by Git source identity plus artifact fingerprint.

## CLI And Admin Implications

CLI:

- `tokenspace push` should eventually build from the actual local worktree or Git commit and submit that as a revision source
- CLI revision preparation should stop assuming Convex-side branch identity is the canonical source model

Admin:

- branch states remain the editable abstraction
- the "main" branch state for a Git-connected workspace should eventually point at a Git-backed baseline instead of a Convex branch baseline
- Git sync UX is not part of this slice, but the backend source model should be designed so the future UI can attach to it cleanly

## Non-Goals

- replacing the admin Git Sync placeholder UI
- redesigning Git credential or repository connection UX
- removing `branches`, `commits`, `trees`, `blobs`, or `workingFiles` in the same slice
- rewriting merge semantics for branch states
- changing session overlay behavior

## Test Plan

Backend:

- identical `gitCommit` sources dedupe to the same revision
- different commit SHAs produce different revision identities
- `gitCommit` source resolution rejects commits or repositories not associated with the workspace
- `branchState` source resolution still works unchanged
- compile jobs store the correct source provenance for both source kinds

Integration:

- revision-build can prepare and commit a build from `gitCommit`
- revision-build can prepare and commit a build from `branchState`
- explicit revision preview remains unchanged
- published runtime resolution from `activeRevisionId` remains unchanged

CLI:

- public package builds succeed with the new source contract
- revision commands can prepare builds without depending on legacy branch identity for Git-backed flows

## Exit Criteria

This slice is complete when:

- `gitCommit` is a first-class revision source
- compile/revision-build materialize source through resolver implementations rather than directly from Convex VCS assumptions
- Git-backed revision provenance is stored and used for dedupe
- branch-state authoring still works
- member-facing runtime behavior remains entirely revision-based
