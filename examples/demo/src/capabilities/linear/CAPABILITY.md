---
name: Linear
description: Read and update Linear issues
---

# Linear

Linear is used for Demo engineering planning and issue tracking.

## Scope and Guardrails

- Allowed teams: `DEMO`
  - `DEMO` engineering and product planning and infrastructure/operations
- Team keys are normalized to uppercase.
- Issue identifiers must use `<TEAM>-<NUMBER>` format (for example `DEMO-41`).

## Available Actions

### Read Actions (autonomous)

- `listTeams` - List teams visible to the Linear API key.
- `listTeamIssues` - List issues for a specific team. Supports optional `status` filter (status name, e.g. `In Progress`).
- `getIssue` - Get issue details by identifier (`DEMO-123`).
- `listTeamWorkflowStates` - List workflow states for a team.

### Write Actions (autonomous)

- `createIssue` - Create a new issue in a team.
- `updateIssue` - Update an existing issue.
- `createComment` - Add a comment to an issue.

### Write Actions (approval required)

- `deleteIssue` - Delete an issue.

## Sub-Issue Support

- `createIssue` supports `parentIdentifier` to create sub-issues.
- `updateIssue` supports `parentIdentifier` and `clearParent` to manage sub-issue relationships.
- `getIssue` and `listTeamIssues` include `parent` and `subIssues` in returned issue objects.

## Examples

List available teams:

```typescript
const { teams } = await linear.listTeams({});
console.log(teams);
```

List recent issues for a team:

```typescript
const { issues } = await linear.listTeamIssues({
  teamKey: "DEMO",
  limit: 20,
});
console.log(issues.map((issue) => issue.identifier));
```

List only issues in a specific status:

```typescript
const { issues } = await linear.listTeamIssues({
  teamKey: "DEMO",
  status: "In Progress",
  limit: 20,
});
console.log(issues.map((issue) => `${issue.identifier} (${issue.state?.name})`));
```

Get an issue:

```typescript
const { issue } = await linear.getIssue({
  identifier: "DEMO-41",
});
console.log(issue.title);
```

Create an issue:

```typescript
const { issue } = await linear.createIssue({
  teamKey: "DEMO",
  title: "Document credential requirements in capability docs",
  description: "Capture setup and examples for all workspace credentials.",
  priority: 2,
});
console.log(issue.identifier);
```

Create a sub-issue:

```typescript
const { issue } = await linear.createIssue({
  teamKey: "DEMO",
  title: "Add deleteIssue action",
  parentIdentifier: "DEMO-41",
});
console.log(issue.identifier, issue.parent?.identifier);
```

Update an issue:

```typescript
const { issue } = await linear.updateIssue({
  identifier: "DEMO-41",
  title: "Credential requirements spec (revised)",
  priority: 1,
});
console.log(issue.identifier, issue.priority);
```

Re-parent a sub-issue:

```typescript
const { issue } = await linear.updateIssue({
  identifier: "DEMO-99",
  parentIdentifier: "DEMO-41",
});
console.log(issue.parent?.identifier);
```

Clear parent from a sub-issue:

```typescript
const { issue } = await linear.updateIssue({
  identifier: "DEMO-99",
  clearParent: true,
});
console.log(issue.parent); // undefined
```

Add a comment:

```typescript
const result = await linear.createComment({
  identifier: "DEMO-41",
  body: "Implemented in examples/tokenspace with strict team scope gating.",
});
console.log(result.comment.id);
```

Delete an issue (approval required):

```typescript
const result = await linear.deleteIssue({
  identifier: "DEMO-999",
});
console.log(result.deleted);
```

Out-of-scope example (rejected):

```typescript
await linear.listTeamIssues({
  teamKey: "ENG",
  limit: 10,
});
// Throws: Team ENG is out of scope. Allowed teams: DEMO
```
