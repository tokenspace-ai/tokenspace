# Domain Gating Checklist

Use this checklist before implementing capability actions.

## Domain Contract

- Allowed organizations/tenants:
- Allowed repositories/projects/workspaces:
- Allowed environments:
- Allowed resource types:
- Explicitly blocked resources/scopes:

## Identifier Constraints

- Allowed ID formats/regex:
- Allowed name/prefix rules:
- Case normalization rules:
- Alias mapping rules:

## Input Validation Rules

- Required fields:
- Allowed enum values:
- Maximum sizes/limits:
- Rejection behavior for unknown inputs:

## Runtime Enforcement Points

- Checks at action entry:
- Checks before read calls:
- Checks before write calls:
- Checks before batch/transaction operations:

## Test Cases

- Valid in-domain request:
- Out-of-domain repo/project:
- Out-of-domain org/tenant:
- Invalid ID format:
- Ambiguous scope input:
