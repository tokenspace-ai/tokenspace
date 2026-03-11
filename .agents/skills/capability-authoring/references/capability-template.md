# Capability Starter Template

Use this as a starting point for new capabilities.

## File Layout

```text
src/
  capabilities/
    <capability-name>/
      CAPABILITY.md
      capability.ts
```

## capability.ts Skeleton

```ts
import { action, getCredential, requireApproval, TokenspaceError } from "@tokenspace/sdk";
import z from "zod";
import { someCredential } from "../../credentials";

const inputSchema = z.object({
  orgId: z.string(),
  project: z.string(),
  resourceId: z.string(),
});

function assertInDomain(args: z.infer<typeof inputSchema>): void {
  const allowedProjects = new Set(["example-project"]);
  if (!allowedProjects.has(args.project)) {
    throw new TokenspaceError(`Out-of-domain project: ${args.project}`);
  }
}

export const getResource = action(inputSchema, async (args) => {
  assertInDomain(args);
  const token = await getCredential(someCredential);
  void token;
  return { ok: true as const, resourceId: args.resourceId };
});

export const updateResource = action(inputSchema, async (args) => {
  assertInDomain(args);
  await requireApproval({
    action: "example:updateResource",
    data: { orgId: args.orgId, project: args.project, resourceId: args.resourceId },
    description: `Update resource ${args.resourceId} in ${args.project}`,
  });
  const token = await getCredential(someCredential);
  void token;
  return { ok: true as const };
});
```

## CAPABILITY.md Skeleton

````md
---
name: <Capability Name>
description: <One-line summary of what this capability does and its scope. Important to include domain specific inclusion criteria.>
---

## When to Use This Capability

- <Primary use case — the kind of request that should trigger this capability.>
- <Secondary use case or refinement.>
- Do not use for <explicit out-of-scope concern>.

## Scope and Guardrails

- <Domain constraint, e.g. allowed resources, projects, or identifiers.>
- <Input normalization rule, if any.>
- <Identifier format or validation pattern.>

## Available Operations

### Read Actions (autonomous)

- `<actionName>` - <What it does.> (approval: not required)

### Write Actions (autonomous)

- `<actionName>` - <What it does.> (approval: not required)

### Write Actions (approval required)

- `<actionName>` - <What it does — typically destructive or irreversible.> (approval: required)

## Guidelines

- Validate inputs before making API requests.
- Keep operations constrained to the declared scope.
- Use approval gating for destructive or irreversible operations.

## Data and Workflow Context

- <Domain-specific context that helps the agent make better decisions.>
- <Relationship or ordering hints, e.g. "read before write".>

## Examples

```typescript
const result = await <capability>.<readAction>({
  <param>: "<value>",
});

await <capability>.<writeAction>({ <param>: "<value>" });
// Requires approval
```

Out-of-domain example (rejected):

```typescript
await <capability>.<readAction>({ <param>: "<out-of-scope value>" });
// Throws: <param value> is out of scope. Allowed: <allowed values>
```
````
