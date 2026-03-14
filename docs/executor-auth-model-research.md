# Executor Auth Model Research

Status: proposed decision note for TOK-72 and TOK-70

Date: 2026-03-13

## Decision Summary

Phase 1 should use database-backed opaque credentials, not JWTs:

- Use a long-lived opaque bootstrap secret per logical executor.
- Mint a short-lived opaque instance session token when an instance registers.
- Validate executor credentials in executor-specific Convex helpers, not through a Convex auth provider.
- Keep the data model and helper interface compatible with a later switch to JWT-backed instance identity.

This is the best fit for the current Tokenspace architecture because executor APIs already use explicit credentials, workspace authorization remains database-backed, and JWT/provider adoption would add issuer, JWKS, refresh, and audience-management work without removing the need for executor-specific authorization checks.

## Current Tokenspace State

The codebase still uses one shared global executor secret for job access:

- [`services/backend/convex/executor.ts`](../services/backend/convex/executor.ts) checks `TOKENSPACE_EXECUTOR_TOKEN` directly for runtime job access.
- [`services/backend/convex/compileJobs.ts`](../services/backend/convex/compileJobs.ts) does the same for compile jobs.

The schema and helper layer already point toward a per-executor model:

- [`services/backend/convex/schema.ts`](../services/backend/convex/schema.ts) already has `executors`, `executorInstances`, `authMode`, and `tokenVersion`.
- [`services/backend/convex/executors.ts`](../services/backend/convex/executors.ts) already enforces that a workspace is assigned to the executor touching it.
- [`docs/dynamic-self-hosted-executors.md`](./dynamic-self-hosted-executors.md) already assumes bootstrap credentials, instance registration, and later auth evolution.

That means the missing work is not just "pick JWT or opaque". It is really:

1. Define the executor identity surface.
2. Separate bootstrap credentials from instance credentials.
3. Keep workspace authorization and revocation live in the database.

## Recommendation

### 1. Keep bootstrap credentials opaque

Bootstrap credentials should be opaque secrets stored only as hashes.

Reasons:

- Bootstrap is only used to prove possession during registration or re-registration.
- Bootstrap needs immediate revocation.
- Registration already requires a database lookup to load executor status and metadata.
- JWT adds no meaningful benefit here because the backend must still check executor state before issuing an instance identity.

Recommendation:

- Show the bootstrap secret once when the executor is created or rotated.
- Store only a hash plus metadata such as `createdAt`, `rotatedAt`, and `lastUsedAt`.
- Do not use the bootstrap secret for regular heartbeat or job APIs.

### 2. Use short-lived opaque instance session tokens in phase 1

After `registerExecutorInstance`, return an opaque instance token that identifies exactly one executor instance.

Recommended behavior:

- TTL: 10 to 15 minutes.
- Refresh window: refresh on heartbeat when less than 2 to 5 minutes remain.
- Scope: heartbeat, assigned-job queries, claims, and job result APIs for that instance only.
- Storage: hash the token, ideally with a stable selector prefix so lookup is indexed instead of scan-based.

This keeps the regular executor path revocable and narrow without forcing Tokenspace to operate a JWT issuer on day one.

### 3. Keep verification inside executor-specific Convex code

If Tokenspace later adopts JWTs, verification should still sit behind a shared `requireExecutorIdentity` helper used only by executor-specific functions, not a general Convex auth provider.

Reasons:

- Executor auth is service-to-service, not end-user auth.
- Convex custom JWT is an advanced path built around JWT issuer, JWKS, `iss`, and optionally `aud` configuration.
- Even with provider-backed JWT verification, Tokenspace still has to check executor status, token version, instance liveness, and workspace assignment in the database.
- Keeping auth local preserves one narrow control plane for opaque and JWT credentials behind the same function interface.

Revisit Convex auth-provider integration only if executors later need broad authenticated access across generic Convex APIs rather than a dedicated executor API surface.

## Opaque Tokens vs JWTs

| Topic | Opaque tokens | JWTs |
| --- | --- | --- |
| Validation model | Database lookup each time | Signature validation plus claims checks; still needs DB checks for revocation and authz |
| Revocation | Immediate once hash/version is revoked | Not immediate unless every request still checks DB state or introspection |
| Operational overhead | Low | Higher: issuer, signing keys, JWKS, audience, refresh lifecycle |
| Blast radius control | Good when bootstrap and instance tokens are separate | Good only with short TTLs and live version checks |
| Convex fit today | Matches existing explicit-arg executor APIs | Better only if Tokenspace wants executor identity to behave like a general JWT principal |
| Interop with non-TS executors | Fine | Better if external runtimes already expect JWTs |

The core tradeoff is revocation versus portability:

- Opaque tokens are simpler because revocation is native to the storage model.
- JWTs are more portable and self-contained, but executor auth in this design is not truly stateless because workspace assignment, executor disablement, and instance health are live database facts.

For Tokenspace, that removes most of the practical upside of JWTs in phase 1.

## Why Not Convex Auth Providers For Executors

Convex's custom JWT support is real, but it is not a free win for this use case.

Relevant implications from the current Convex model:

- Custom JWT providers require a configured `issuer`, `jwks`, signing algorithm, and usually an `applicationID` audience check.
- Convex exposes JWT claims through `ctx.auth.getUserIdentity()`, which is useful only after Tokenspace has already decided to run executor identity as a JWT-authenticated principal.
- Omitting audience checks is often insecure when one issuer serves multiple relying parties.

For executor identity, that buys less than it first appears to:

- Jobs still need workspace-to-executor authorization checks.
- Instance APIs still need live instance status checks.
- Executor-wide revocation still needs a database-backed version or denylist.
- Bootstrap and registration flows still need application-specific behavior.

So provider-backed JWT verification would add infrastructure, but not remove the important database checks.

## JWT Claim Set If We Add It Later

If Tokenspace later adds JWT-backed instance identity, use a minimal claim set and keep workspace authorization out of the token.

Required standard claims:

- `iss`: dedicated Tokenspace executor issuer.
- `aud`: exact executor API audience or Convex application ID.
- `sub`: stable principal identifier, for example `executor-instance:{instanceId}`.
- `exp`: short expiration.
- `iat`: issued-at time.
- `jti`: unique token identifier for audit and optional denylisting.

Required custom claims:

- `executorId`
- `instanceId`
- `scope`: `instance`
- `tokenVersion`

Recommended token typing:

- Header `typ`: a dedicated value such as `tokenspace-executor-instance+jwt`

Deliberately do not include:

- assigned workspace IDs
- workspace capability sets
- mutable liveness state

Those values change too often and are security-sensitive enough that they should stay database-backed. Embedding them in JWTs would force token re-issuance on every assignment change and create stale-authorization risk.

## Rotation, Expiration, and Revocation

### Bootstrap secret

- Long-lived until rotated or executor is disabled.
- Rotation replaces the stored hash and increments `tokenVersion`.
- Old bootstrap secrets fail immediately after rotation.

### Instance token

- Short-lived, rotated continuously.
- Revoked if the executor is disabled, the instance is deleted/offline/draining, or the executor `tokenVersion` changes.
- Replaced during heartbeat before expiry to avoid executor restarts.

### Executor-wide kill switch

Every executor-authenticated request should reject if any of the following are true:

- executor status is not `active`
- token version does not match
- instance status is not valid for the operation
- workspace is no longer assigned to that executor

This is the real reason a fully stateless model does not buy much here.

## Phase-1 API Shape

Recommended flow:

1. Admin creates executor.
2. Backend creates executor row plus hashed bootstrap secret.
3. Executor starts with `TOKENSPACE_EXECUTOR_BOOTSTRAP_TOKEN`.
4. Executor calls `registerExecutorInstance`.
5. Backend validates bootstrap secret, executor status, and token version.
6. Backend inserts or updates the `executorInstances` row.
7. Backend returns `instanceId`, heartbeat interval, and a short-lived opaque instance token.
8. Instance uses only the instance token for steady-state APIs.
9. Heartbeat refreshes the instance token before expiry.

One helper should sit in front of every executor API:

- input: bootstrap or instance credential
- output: `{ executorId, instanceId, tokenVersion }`

That helper can keep the external API stable even if the backing format changes from opaque tokens to JWT later.

## Compatibility Guardrails For A Later JWT Upgrade

If we want the option to switch later, phase 1 should preserve these invariants now:

- Keep `authMode` and `tokenVersion` on the executor record.
- Treat bootstrap and instance credentials as separate credential classes.
- Keep workspace authorization database-backed instead of token-backed.
- Centralize credential validation behind one helper instead of scattering it through functions.
- Avoid exposing token format assumptions at call sites.

If those guardrails hold, Tokenspace can later move from:

- opaque bootstrap + opaque instance token

to:

- opaque bootstrap + JWT instance token

without changing the scheduler, workspace-assignment rules, or executor lifecycle model.

## Final Recommendation

Use opaque secrets for both bootstrap and instance identity in phase 1.

That is the smallest design that:

- matches the current Convex executor API shape
- supports immediate revocation
- cleanly separates registration from steady-state executor traffic
- stays compatible with a later JWT instance-token upgrade if real interoperability needs appear

If Tokenspace later introduces JWTs, keep workspace authorization and executor status checks in the application layer and do not encode mutable workspace access in token claims.

## Sources

- Convex custom JWT provider docs: <https://docs.convex.dev/auth/advanced/custom-jwt>
- Convex auth in functions: <https://docs.convex.dev/auth/functions-auth>
- RFC 7519 (JWT): <https://datatracker.ietf.org/doc/html/rfc7519>
- RFC 8725 (JWT Best Current Practices): <https://datatracker.ietf.org/doc/html/rfc8725>
- RFC 7662 (OAuth 2.0 Token Introspection): <https://datatracker.ietf.org/doc/html/rfc7662>
- RFC 7009 (OAuth 2.0 Token Revocation): <https://datatracker.ietf.org/doc/html/rfc7009>
