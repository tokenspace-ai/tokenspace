# Approval Policy Matrix

Use this matrix to maximize safe autonomy while keeping required human review.

## Policy Inputs

- User requirement for approval involvement:
- Required reviewers/parties:
- Risk tolerance:
- Cost sensitivity:

## Action Classification

| Action | In-domain read | In-domain write (reversible) | In-domain write (destructive/high-impact) | Out-of-domain |
|---|---|---|---|---|
| Policy | Autonomous | User-policy dependent (default autonomous) | Approval required | Reject |

## Decision Rules

- Keep in-domain read actions autonomous.
- Keep reversible in-domain writes autonomous unless user policy requires review.
- Require approval for destructive/high-impact/costly actions.
- Reject all out-of-domain operations regardless of approval.

## Approval Requirement Template

Use namespaced actions and narrowly scoped matching data.

```ts
await requireApproval({
  action: "capabilityName:operationName",
  data: {
    orgId: args.orgId,
    project: args.project,
    resourceId: args.resourceId,
  },
  description: `Perform operationName on ${args.resourceId} in ${args.project}`,
});
```
