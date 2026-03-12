---
name: Splunk
description: Splunk contains logs of our kubernetes cluster and the applications running on it
---

# Splunk

Demo Kubernetes cluster logs and telemetry.

## Data Overview

- Kubernetes cluster logs: `index=otel_demo_k8s`

## Examples

Recently restarted containers:

```typescript
const results = await splunk.searchSplunk({
  query: `index=otel_demo_k8s | stats max(k8s.container.restart_count) as restart_count by k8s.container.name | where restart_count>0`,
  timeRange: { earliest: "-24h", latest: "now" },
  limit: 50,
});
console.log(results);
```

## Guidelines

- When generating queries, always look for docs or examples first. Don't make up queries from scratch.
