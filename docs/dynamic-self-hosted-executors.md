# Dynamic Self-Hosted Executors

## Summary

We want users to be able to create a self-hosted executor from the app, receive a bootstrap credential and startup snippet, run one or more executor instances, and have the backend assign work to those instances with heartbeat-based liveness.

The updated direction is:

- model executors as reusable fleets that can be assigned to multiple workspaces
- allow each workspace to reference exactly one logical executor
- separate a logical executor from its running instances
- replace the single global `TOKENSPACE_EXECUTOR_TOKEN` model with per-executor credentials stored in the database
- let instances register themselves and maintain liveness with periodic heartbeats
- move from "all executors subscribe to all jobs" to "backend assigns jobs to a specific instance"
- add session affinity so all jobs for the same session land on the same instance while that instance is healthy
- fail fast when a job targets a self-hosted executor and no healthy instance is available
- include both runtime jobs and compile jobs in scope
- explicitly research a JWT-based executor auth model before locking the final auth implementation

This document is intentionally high level. It identifies the architecture we should build, the main tradeoffs, and the research items to validate before implementation.

## Current State

Today the system assumes a single shared executor fleet:

- `services/backend/convex/executor.ts` and `services/backend/convex/compileJobs.ts` authorize executor calls with a single global `TOKENSPACE_EXECUTOR_TOKEN`
- the executor subscribes to `runnableJobs` and `runnableCompileJobs` and sees all work that is runnable for the environment
- jobs are leased with `claimJob` and kept alive with `heartbeatJob`
- multi-process concurrency exists inside a single executor process through the revision worker pool
- jobs already carry `sessionId`, and the executor already distinguishes compile jobs from runtime jobs

This is a good base for leases and crash recovery, but it does not support:

- user-created executor identities
- per-workspace routing
- multiple independent customer-operated fleets
- per-instance health reporting
- explicit backend-side assignment to a specific worker

## Goals

- Allow a workspace admin to create and manage self-hosted executors from the UI.
- Allow an executor process to register itself dynamically with the backend.
- Support multiple running instances of the same logical executor.
- Route jobs only to the intended executor fleet, not to every connected executor.
- Preserve session locality so a given session uses the same instance whenever possible.
- Make executor liveness visible in the app.
- Support credential rotation and executor revocation.

## Non-Goals

- Finalize every operational detail before starting implementation.
- Design a multi-region scheduler in phase 1.
- Design a generic cross-workspace shared compute marketplace in phase 1.
- Replace the existing lease model; we should extend it.

## Proposed Model

### 1. Introduce a logical executor resource

Add a persistent executor record that can be referenced by many workspaces.

Suggested phase-1 fields:

- `name`
- `kind`: `self_hosted`
- `status`: `active | disabled | registration_pending`
- `authMode`: `bootstrap_token`
- `tokenVersion` or equivalent rotation counter
- `createdBy`
- `createdAt`
- `updatedAt`
- `lastHeartbeatAt` as a derived summary or denormalized convenience field

This is the user-visible fleet object. It represents a reusable executor deployment, not a single running process.

### 1a. Add workspace-to-executor assignment

Each workspace can reference exactly one logical executor.

Suggested phase-1 fields:

- `workspaceId`
- `executorId`
- `createdAt`
- `updatedAt`

This should be implemented as an `executorId` field on `workspaces`.

The important product rule is:

- one workspace has at most one assigned executor
- one executor may be assigned to many workspaces

### 2. Introduce executor instances

Add a second table for running processes that self-register against the logical executor.

Suggested phase-1 fields:

- `executorId`
- `instanceId`
- `status`: `online | offline | draining | unhealthy`
- `registeredAt`
- `lastHeartbeatAt`
- `expiresAt`
- `hostname`
- `version`
- `labels` or `metadata`
- `maxConcurrentRuntimeJobs`
- `maxConcurrentCompileJobs`
- `runningRuntimeJobs`
- `runningCompileJobs`

Instances are ephemeral. They appear when a process starts, refresh themselves via heartbeats, and age out automatically if heartbeats stop.

### 3. Keep jobs scoped to a workspace and target an executor

For phase 1, keep jobs workspace-owned but route them through the workspace's assigned executor.

Suggested job fields:

- `workspaceId` on runtime jobs if it is not already directly available
- `targetExecutorId`
- `assignedInstanceId`
- `assignmentUpdatedAt`

Compile jobs already have `workspaceId`, and compile work is in scope for self-hosted routing in phase 1.

### 4. Add session affinity as a first-class scheduling concern

We should treat session stickiness as a backend concern, not only a local executor concern.

Recommended approach:

- maintain a `sessionExecutorAssignments` or `sessionInstanceLeases` table keyed by `sessionId`
- when a new job with `sessionId` is enqueued, prefer the same healthy `assignedInstanceId`
- if the instance is offline or its lease has expired, reassign the session to another healthy instance
- keep local executor-side locking too, because backend affinity reduces collisions but should not be the only safety layer

This gives us both:

- stable routing for session-local filesystem or process state
- a recovery path when an instance dies

### 5. Move to backend-driven assignment

Instead of each executor subscribing to all runnable work, the backend should assign a job to one instance and that instance should only observe its assigned queue.

Recommended phase-1 flow:

1. A job is created with `targetExecutorId`.
2. The backend scheduler picks a healthy instance for that executor.
3. The backend sets `assignedInstanceId` on the job.
4. The instance subscribes only to `jobsAssignedToInstance(instanceId)`.
5. The instance claims and heartbeats the job as it does today.

This keeps the current claim and lease logic useful, but narrows visibility and prevents unrelated executors from competing for the same work.

## Scoping Decision

### Adopt a shared executor model

Phase 1 should support one executor fleet serving multiple workspaces.

Product rule:

- each workspace may be assigned exactly one logical executor
- one logical executor may be assigned to many workspaces

Reasons:

- this matches the intended operator model more closely
- it lets a customer run one shared deployment and reuse it across related workspaces
- it avoids forcing duplicate fleet setup when the infrastructure is really shared

Tradeoffs:

- authz is more complex because executor identity and workspace access are no longer the same boundary
- scheduling must always validate that a job's workspace is assigned to the executor receiving the job
- environment credentials become more sensitive because the same fleet may serve multiple workspaces
- future quota and billing attribution need to remain workspace-aware even when compute is shared

Required guardrail:

- every job assignment and every executor API that touches a job must verify that the job's workspace is currently mapped to that executor

Recommended framing:

- treat the executor as an organization-level fleet object
- treat workspace assignment as a separate mapping with a one-workspace-to-one-executor rule

## Recommended Authentication Direction

### Recommendation: database-backed executor credentials first, while explicitly researching JWTs

There are two broad choices:

- use Convex auth with a new custom JWT issuer for executors
- keep executor auth at the application layer, where executor calls pass a credential that backend functions validate against stored executor records

For initial implementation planning, the second option is still the simpler baseline and better aligned with the existing code.

Reasons:

- current executor APIs already accept an explicit `executorToken` argument rather than relying on Convex identity
- database-backed credentials are easy to rotate and revoke per executor
- we avoid turning the application into a JWT issuer with its own signing and JWKS lifecycle on day one
- executor identity is service-to-service auth, not end-user auth, so we do not gain much by forcing it into the Convex auth provider model immediately

### Recommended token model

Use two credential types:

- a long-lived bootstrap token shown when the executor is created or rotated
- a short-lived instance session token returned after successful registration

Suggested flow:

1. Workspace admin creates an executor.
2. Backend creates the executor record and a bootstrap secret, storing only a hash.
3. UI shows the secret once, plus a Docker and CLI startup snippet.
4. The executor process starts with the bootstrap token.
5. It calls `registerExecutorInstance`.
6. Backend verifies the bootstrap token, creates an instance row, and returns:
   - `instanceId`
   - heartbeat interval
   - optional short-lived instance token
7. The instance uses the instance token for heartbeats and assigned-job queries until it expires, then refreshes it.

This gives us:

- revocation per logical executor
- clean instance lifecycle
- a smaller blast radius than one permanent secret reused everywhere

### JWT research track

We should explicitly research a signed-token approach before implementation starts.

Questions to answer in that spike:

- should bootstrap credentials be opaque secrets while instance credentials are JWTs?
- should both bootstrap and instance credentials be JWTs?
- do we want Convex auth-provider integration for executors, or only JWT verification inside executor-specific functions?
- how would signing keys, rotation, and revocation work operationally?
- what claims are required: `executorId`, `instanceId`, allowed workspace set, expiration, token version?

A signed token may be useful if we want:

- executor auth outside the explicit function-arg pattern
- stronger separation between bootstrap credentials and runtime session credentials
- easier interoperability with non-TypeScript executor implementations

The design should stay compatible with either outcome:

- opaque secrets for phase 1
- or JWT-backed instance identity if the research spike looks worthwhile

## Scheduling and Assignment

### Core scheduling rules

- only healthy instances of the job's `targetExecutorId` are eligible
- session-bound jobs prefer the existing session assignment if healthy
- otherwise choose the least-loaded healthy instance
- compile jobs may use a separate capacity counter from runtime jobs
- when no healthy instance exists, fail fast instead of waiting in queue

### Failure handling

- if an instance misses heartbeats, mark it offline after a TTL
- running jobs on that instance become reclaimable after their lease expires
- session affinity leases pointing at that instance become eligible for reassignment
- assignment is advisory until claim succeeds; the existing claim mutation remains the last write that establishes ownership
- new jobs for workspaces mapped to that executor should fail immediately while no healthy instance exists

### Fail-fast behavior

Fail-fast should be visible at the job layer, not only in scheduler logs.

Recommended behavior:

- runtime jobs should transition to `failed` with a structured `EXECUTOR_UNAVAILABLE` error
- compile jobs should transition to `failed` with the same executor-unavailable error type
- the UI should surface that the workspace's assigned executor has no healthy instances

### Why keep claims if the backend already assigns jobs

Because assignment and ownership solve different problems:

- assignment decides who should try the job
- claim and heartbeat protect against duplicate execution and recover from crashes

The current lease model is still the right primitive for runtime safety.

## UI and User Experience

Workspace admin settings should support:

- view the executor assigned to the workspace
- assign or change the workspace's executor
- create executor
- rename, disable, rotate token, and delete executor
- show recent instance heartbeats and instance count
- show setup instructions with copyable snippets

Suggested setup experience:

- create executor
- show bootstrap token once
- show Docker snippet
- show raw CLI snippet
- show expected environment variables
- show status changing from `registration_pending` to `online`

Example startup shape:

```bash
docker run \
  -e CONVEX_URL="..." \
  -e TOKENSPACE_EXECUTOR_BOOTSTRAP_TOKEN="..." \
  ghcr.io/tokenspace/executor:latest
```

The exact packaging can be decided later. The important part for this plan is that startup is generated from a single bootstrap secret and executor metadata.

## Data Model Sketch

This is not a final schema, just the direction.

### New tables

- `executors`
- `executorInstances`
- `sessionInstanceAssignments`

### Job changes

Add to `jobs`:

- `workspaceId`
- `targetExecutorId`
- `assignedInstanceId`
- `assignmentUpdatedAt`

Potentially add the same pattern to `compileJobs` if compile work should also be self-hostable in phase 1.
Add to `compileJobs`:

- `targetExecutorId`
- `assignedInstanceId`
- `assignmentUpdatedAt`

### Denormalized summaries

For UI efficiency we may also keep a summary on `executors`:

- `onlineInstanceCount`
- `lastHeartbeatAt`
- `lastRegistrationAt`

## Phased Rollout

### Phase 0: design and spikes

- confirm workspace scoping decision
- confirm fail-fast behavior and user-visible error model
- confirm compile plus runtime routing requirements
- spike the registration and heartbeat API shape
- spike JWT vs opaque-token executor auth

### Phase 1: backend identity and registration

- add executor and executor-instance tables
- create executor management APIs for workspace admins
- add bootstrap token issuance and rotation
- add instance registration and heartbeat APIs

### Phase 2: routing and scheduling

- add `targetExecutorId` and `assignedInstanceId` to jobs
- add the same routing fields to compile jobs
- schedule jobs to a specific instance
- replace global runnable subscriptions with instance-scoped subscriptions
- preserve claim and lease semantics

### Phase 3: session affinity

- add session-instance assignment records
- prefer the same instance for a session while healthy
- define reassignment rules for instance failure

### Phase 4: UI and observability

- workspace settings UI for executor lifecycle
- setup snippets
- status indicators and heartbeat timestamps
- basic metrics and logs for offline or overloaded executors

## Research Tasks

- Decide whether bootstrap and instance credentials should be opaque secrets, JWTs, or a hybrid.
- Decide whether JWT verification should use Convex auth providers or stay inside executor-specific functions.
- Validate whether session affinity needs a dedicated table or can be encoded directly on sessions.
- Decide how much capacity metadata an instance should report in phase 1.
- Decide whether executors need labels or capabilities for future specialized routing.
- Define the offline timeout and reclaim timing so reassignment is fast without causing duplicate work.
- Define fail-fast error semantics for runtime and compile jobs when no healthy executor instance is available.
- Define how workspace assignment changes affect in-flight and queued jobs.
- Validate how shared executors interact with environment credentials across multiple workspaces.

## Product Decisions Captured

The following decisions are now assumed by this document:

1. One logical executor may be reused across multiple workspaces.
2. Each workspace is assigned at most one logical executor.
3. Jobs fail fast when no healthy assigned executor instance is available.
4. Both runtime jobs and compile jobs are in scope.
5. JWT-based executor auth should be researched before implementation is locked.

## Recommendation Snapshot

If we want the smallest coherent first implementation, we should proceed with:

- shared logical executors plus one-to-many workspace assignments
- multiple instances per logical executor
- bootstrap secret plus a JWT/opaque-token auth spike before finalizing instance credentials
- backend-side job assignment to a specific instance
- session affinity for runtime jobs
- compile jobs and runtime jobs both routed through the same executor model
- fail-fast behavior when no healthy assigned executor instance exists
