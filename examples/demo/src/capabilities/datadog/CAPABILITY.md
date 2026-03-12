---
name: Datadog
description: Datadog contains metrics and monitoring data from our Kubernetes infrastructure
---

# Datadog

Production Datadog environment containing metrics and monitoring data from our Kubernetes clusters.
We have a production kubernetes cluster using GKE autopilot.  The data from this cluster will have env:prod set as a tag.
Additionally, we have a staging cluster that is GKE manual/classic that has our staging resources, but also otel demo services.  
These will show up tagged as env:none. 

Logs are sent to Splunk, not Datadog. Traces are not currently collected.

## Data Overview

- Kubernetes cluster metrics (CPU, memory, network, disk)
- Container and pod metrics
- Node-level infrastructure metrics
- Monitors and alerts for infrastructure health

## Common Kubernetes Metrics

| Metric | Description |
|--------|-------------|
| `kubernetes.cpu.usage.total` | Total CPU usage by container |
| `kubernetes.cpu.requests` | CPU requests by container |
| `kubernetes.cpu.limits` | CPU limits by container |
| `kubernetes.memory.usage` | Memory usage by container |
| `kubernetes.memory.requests` | Memory requests by container |
| `kubernetes.memory.limits` | Memory limits by container |
| `kubernetes.pods.running` | Number of running pods |
| `kubernetes.containers.running` | Number of running containers |
| `kubernetes.network.rx_bytes` | Network bytes received |
| `kubernetes.network.tx_bytes` | Network bytes transmitted |

## Examples

Query CPU usage across all pods:

```typescript
const now = Math.floor(Date.now() / 1000);
const oneHourAgo = now - 3600;

const cpuUsage = await datadog.queryMetrics({
  query: "avg:kubernetes.cpu.usage.total{*} by {kube_namespace,pod_name}",
  from: oneHourAgo,
  to: now,
});

cpuUsage.series.forEach((series) => {
  console.log(`${series.metric} (${series.tags?.join(", ")})`);
  series.points.forEach((point) => {
    console.log(`  ${new Date(point.timestamp).toISOString()}: ${point.value}`);
  });
});
```

Query memory usage for a specific namespace:

```typescript
const now = Math.floor(Date.now() / 1000);
const sixHoursAgo = now - 6 * 3600;

const memoryUsage = await datadog.queryMetrics({
  query: "avg:kubernetes.memory.usage{kube_namespace:production} by {pod_name}",
  from: sixHoursAgo,
  to: now,
});
console.log(memoryUsage.series);
```

List all monitors:

```typescript
const monitors = await datadog.listMonitors({
  tags: "env:production",
});
monitors.monitors.forEach((monitor) => {
  console.log(`[${monitor.overallState}] ${monitor.name}`);
});
```

List all hosts in the Kubernetes cluster:

```typescript
const hosts = await datadog.listHosts({
  filter: "kube",
  count: 100,
});
console.log(`Found ${hosts.totalMatching} Kubernetes hosts`);
hosts.hosts.forEach((host) => {
  console.log(`- ${host.name}: ${host.up ? "up" : "down"}`);
});
```

Get available Kubernetes metrics:

```typescript
const metrics = await datadog.listMetrics({
  query: "kubernetes.",
});
console.log("Kubernetes metrics:", metrics.metrics.slice(0, 20));
```

Check recent events:

```typescript
const now = Math.floor(Date.now() / 1000);
const oneDayAgo = now - 86400;

const events = await datadog.queryEvents({
  start: oneDayAgo,
  end: now,
  tags: "env:production",
});
events.events.forEach((event) => {
  console.log(`[${event.alertType}] ${event.title}`);
});
```

List running containers:

```typescript
const containers = await datadog.listContainers({
  limit: 50,
});
containers.containers.forEach((container) => {
  console.log(`${container.name} (${container.image}:${container.imageTag}) - ${container.state}`);
});
```

List services from the Service Catalog:

```typescript
const services = await datadog.listServices({});
services.services.forEach((service) => {
  console.log(`${service.name} - ${service.description ?? "No description"}`);
});
```

Create a monitor for high CPU usage (requires approval):

```typescript
const monitor = await datadog.createMonitor({
  name: "High CPU Usage Alert",
  type: "metric alert",
  query: "avg(last_5m):avg:kubernetes.cpu.usage.total{kube_namespace:production} by {pod_name} > 80",
  message: "CPU usage is above 80% on {{pod_name.name}}. @slack-alerts",
  tags: ["env:production", "team:platform"],
  options: {
    thresholds: {
      critical: 80,
      warning: 60,
    },
    notifyNoData: false,
    renotifyInterval: 60,
  },
});
console.log(`Created monitor: ${monitor.id}`);
```

Make an arbitrary Datadog API request:

```typescript
const response = await datadog.datadogApiRequest({
  method: "GET",
  path: "/api/v1/dashboard",
  queryParams: {
    filter_shared: "false",
  },
});
console.log(response.status, response.body);
```

## Available Actions

### Read Actions (no approval required)

- `queryMetrics` - Query time series metrics data
- `listMetrics` - List available metrics
- `getMetricMetadata` - Get metadata for a specific metric
- `listHosts` - List hosts reporting to Datadog
- `listContainers` - List containers reporting to Datadog
- `listServices` - List services from the Service Catalog
- `getService` - Get details of a specific service
- `listMonitors` - List configured monitors
- `getMonitor` - Get details of a specific monitor
- `listDashboards` - List dashboards
- `getDashboard` - Get dashboard details
- `queryEvents` - Query events
- `datadogApiRequest` (`GET`) - Make arbitrary read requests to the Datadog API

### Write Actions (require approval)

- `createMonitor` - Create a new monitor
- `muteHost` - Mute a host
- `unmuteHost` - Unmute a host
- `datadogApiRequest` (`POST`/`PUT`/`DELETE`/`PATCH`) - Make mutating Datadog API requests

## Guidelines

- Use `queryMetrics` for time series data analysis
- Filter by `kube_namespace`, `pod_name`, and `kube_deployment` tags for Kubernetes-specific queries
- Use `listMetrics` if unsure what metrics are available
- For logs, use the Splunk capability instead
- Traces are not currently collected
