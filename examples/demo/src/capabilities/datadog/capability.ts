import {
  action,
  getCredential,
  Logger,
  parseResponseBody,
  request,
  requireApproval,
  TokenspaceError,
} from "@tokenspace/sdk";
import z, { prettifyError } from "zod";
import { datadogApiKey, datadogAppKey } from "../../credentials";

const log = new Logger("datadog");

const CONNECTION = {
  baseUrl: "https://api.us5.datadoghq.com",
  apiKey: datadogApiKey,
  appKey: datadogAppKey,
} as const;

class DatadogError extends TokenspaceError {
  constructor(
    message: string,
    public readonly response?: Response,
    details?: string,
  ) {
    super(message, undefined, details, { status: response?.status });
    this.name = "DatadogError";
  }
}

// ============================================================================
// Generic API Request
// ============================================================================

type DatadogApiRequestArgs = {
  method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH";
  path: string;
  body?: Record<string, any>;
  queryParams?: Record<string, string>;
};

type DatadogApiRequestResult = {
  status: number;
  body: any;
};

/**
 * Make an arbitrary request to the Datadog API
 * @APPROVAL_REQUIRED Requests other than GET require approval
 */
async function datadogApiRequestInternal(args: DatadogApiRequestArgs): Promise<DatadogApiRequestResult> {
  const conn = CONNECTION;

  if (args.method !== "GET") {
    await requireApproval({
      action: "datadog:apiRequest",
      data: {
        method: args.method,
        path: args.path,
      },
      info: {
        body: args.body,
        queryParams: args.queryParams,
      },
      description: `Execute ${args.method} request to Datadog API: ${args.path}`,
    });
  }

  const url = new URL(conn.baseUrl);
  url.pathname = args.path;
  if (args.queryParams) {
    for (const [key, value] of Object.entries(args.queryParams)) {
      url.searchParams.set(key, value);
    }
  }

  const response = await request({
    url: url.toString(),
    method: args.method,
    headers: {
      "Content-Type": "application/json",
      "DD-API-KEY": await getCredential(conn.apiKey),
      "DD-APPLICATION-KEY": await getCredential(conn.appKey),
    },
    body: args.body ? JSON.stringify(args.body) : undefined,
    checkResponseStatus: false,
  });

  if (!response.ok) {
    const body = await parseResponseBody(response).catch(() => null);
    log.error(`Datadog API request failed: ${response.statusText}`, body);
    throw new DatadogError(
      `Datadog API request failed: ${response.statusText}`,
      response,
      typeof body === "string" ? body : JSON.stringify(body),
    );
  }

  const body = await parseResponseBody(response);
  return { status: response.status, body };
}

// ============================================================================
// Metrics Query
// ============================================================================

type QueryMetricsArgs = {
  /** Metrics query string (e.g., "avg:kubernetes.cpu.usage{*}") */
  query: string;
  /** Start time as Unix epoch seconds */
  from: number;
  /** End time as Unix epoch seconds */
  to: number;
};

const metricsQueryResponseSchema = z.object({
  status: z.string().nullable().optional(),
  res_type: z.string().nullable().optional(),
  from_date: z.number().nullable().optional(),
  to_date: z.number().nullable().optional(),
  query: z.string().nullable().optional(),
  series: z
    .array(
      z.object({
        metric: z.string(),
        display_name: z.string().nullable().optional(),
        unit: z.array(z.any()).nullable().optional(),
        pointlist: z.array(z.array(z.number().nullable())),
        scope: z.string().nullable().optional(),
        expression: z.string().nullable().optional(),
        tag_set: z.array(z.string()).nullable().optional(),
      }),
    )
    .nullable()
    .optional(),
  group_by: z.array(z.string()).nullable().optional(),
  message: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
});

type QueryMetricsResult = {
  series: Array<{
    metric: string;
    displayName?: string;
    unit?: string;
    points: Array<{ timestamp: number; value: number }>;
    scope?: string;
    tags?: string[];
  }>;
};

/** Query Datadog metrics data */
async function queryMetricsInternal(args: QueryMetricsArgs): Promise<QueryMetricsResult> {
  const result = await datadogApiRequestInternal({
    method: "GET",
    path: "/api/v1/query",
    queryParams: {
      query: args.query,
      from: args.from.toString(),
      to: args.to.toString(),
    },
  });

  const parsed = metricsQueryResponseSchema.safeParse(result.body);
  if (!parsed.success) {
    throw new DatadogError("Unexpected response from Datadog metrics query", undefined, prettifyError(parsed.error));
  }

  if (parsed.data.error) {
    throw new DatadogError(`Datadog query error: ${parsed.data.error}`);
  }

  return {
    series: (parsed.data.series ?? []).map((s) => ({
      metric: s.metric,
      displayName: s.display_name ?? undefined,
      unit: s.unit?.[0]?.short_name ?? s.unit?.[0]?.name,
      points: s.pointlist
        .filter((p): p is [number, number] => p.length === 2 && p[0] !== null && p[1] !== null)
        .map(([ts, val]) => ({ timestamp: ts, value: val })),
      scope: s.scope ?? undefined,
      tags: s.tag_set ?? undefined,
    })),
  };
}

// ============================================================================
// List Metrics
// ============================================================================

type ListMetricsArgs = {
  /** Filter metrics by name prefix (optional) */
  query?: string;
};

type ListMetricsResult = {
  metrics: string[];
};

/** List available metrics in Datadog */
async function listMetricsInternal(args?: ListMetricsArgs): Promise<ListMetricsResult> {
  const queryParams: Record<string, string> = {};
  if (args?.query) {
    queryParams.q = args.query;
  }

  const result = await datadogApiRequestInternal({
    method: "GET",
    path: "/api/v1/metrics",
    queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
  });

  return { metrics: result.body.metrics ?? [] };
}

// ============================================================================
// Get Metric Metadata
// ============================================================================

type GetMetricMetadataArgs = {
  /** The metric name */
  metricName: string;
};

type MetricMetadata = {
  description?: string;
  shortName?: string;
  unit?: string;
  perUnit?: string;
  statsdInterval?: number;
  type?: string;
};

/** Get metadata for a specific metric */
async function getMetricMetadataInternal(args: GetMetricMetadataArgs): Promise<MetricMetadata> {
  const result = await datadogApiRequestInternal({
    method: "GET",
    path: `/api/v1/metrics/${encodeURIComponent(args.metricName)}`,
  });

  return {
    description: result.body.description,
    shortName: result.body.short_name,
    unit: result.body.unit,
    perUnit: result.body.per_unit,
    statsdInterval: result.body.statsd_interval,
    type: result.body.type,
  };
}

// ============================================================================
// List Hosts
// ============================================================================

type ListHostsArgs = {
  /** Filter hosts by name, alias, or tag */
  filter?: string;
  /** Sort by field (e.g., "apps", "cpu", "iowait", "load") */
  sortField?: string;
  /** Sort direction */
  sortDir?: "asc" | "desc";
  /** Number of hosts to return (max 1000) */
  count?: number;
  /** Starting offset for pagination */
  start?: number;
};

type Host = {
  name: string;
  aliases?: string[];
  apps?: string[];
  awsName?: string;
  hostName: string;
  isMuted?: boolean;
  lastReportedTime?: number;
  meta?: {
    platform?: string;
    cpuCores?: number;
  };
  sources?: string[];
  tagsBySource?: Record<string, string[]>;
  up?: boolean;
};

type ListHostsResult = {
  hosts: Host[];
  totalReturned: number;
  totalMatching: number;
};

/** List hosts reporting to Datadog */
async function listHostsInternal(args?: ListHostsArgs): Promise<ListHostsResult> {
  const queryParams: Record<string, string> = {};
  if (args?.filter) queryParams.filter = args.filter;
  if (args?.sortField) queryParams.sort_field = args.sortField;
  if (args?.sortDir) queryParams.sort_dir = args.sortDir;
  if (args?.count) queryParams.count = args.count.toString();
  if (args?.start) queryParams.start = args.start.toString();

  const result = await datadogApiRequestInternal({
    method: "GET",
    path: "/api/v1/hosts",
    queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
  });

  return {
    hosts: (result.body.host_list ?? []).map((h: any) => ({
      name: h.name,
      aliases: h.aliases,
      apps: h.apps,
      awsName: h.aws_name,
      hostName: h.host_name,
      isMuted: h.is_muted,
      lastReportedTime: h.last_reported_time,
      meta: h.meta
        ? {
            platform: h.meta.platform,
            cpuCores: h.meta.cpuCores,
          }
        : undefined,
      sources: h.sources,
      tagsBySource: h.tags_by_source,
      up: h.up,
    })),
    totalReturned: result.body.total_returned ?? 0,
    totalMatching: result.body.total_matching ?? 0,
  };
}

// ============================================================================
// List Monitors
// ============================================================================

type ListMonitorsArgs = {
  /** Filter by monitor name */
  name?: string;
  /** Filter by tags (comma-separated) */
  tags?: string;
  /** Filter by monitor type */
  monitorType?: string;
};

type Monitor = {
  id: number;
  name: string;
  type: string;
  query: string;
  message?: string;
  tags?: string[];
  overallState?: string;
  created?: string;
  modified?: string;
};

type ListMonitorsResult = {
  monitors: Monitor[];
};

/** List Datadog monitors */
async function listMonitorsInternal(args?: ListMonitorsArgs): Promise<ListMonitorsResult> {
  const queryParams: Record<string, string> = {};
  if (args?.name) queryParams.name = args.name;
  if (args?.tags) queryParams.tags = args.tags;
  if (args?.monitorType) queryParams.type = args.monitorType;

  const result = await datadogApiRequestInternal({
    method: "GET",
    path: "/api/v1/monitor",
    queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
  });

  const monitors = Array.isArray(result.body) ? result.body : [];
  return {
    monitors: monitors.map((m: any) => ({
      id: m.id,
      name: m.name,
      type: m.type,
      query: m.query,
      message: m.message,
      tags: m.tags,
      overallState: m.overall_state,
      created: m.created,
      modified: m.modified,
    })),
  };
}

// ============================================================================
// Get Monitor
// ============================================================================

type GetMonitorArgs = {
  monitorId: number;
};

/** Get details of a specific monitor */
async function getMonitorInternal(args: GetMonitorArgs): Promise<Monitor> {
  const result = await datadogApiRequestInternal({
    method: "GET",
    path: `/api/v1/monitor/${args.monitorId}`,
  });

  return {
    id: result.body.id,
    name: result.body.name,
    type: result.body.type,
    query: result.body.query,
    message: result.body.message,
    tags: result.body.tags,
    overallState: result.body.overall_state,
    created: result.body.created,
    modified: result.body.modified,
  };
}

// ============================================================================
// Create Monitor (requires approval)
// ============================================================================

type CreateMonitorArgs = {
  /** Monitor name */
  name: string;
  /** Monitor type (e.g., "metric alert", "query alert", "service check", "event alert") */
  type: string;
  /** Monitor query string */
  query: string;
  /** Message to include with notifications (supports @mentions, markdown) */
  message?: string;
  /** Tags to associate with the monitor */
  tags?: string[];
  /** Priority of the monitor (1-5, with 1 being highest) */
  priority?: number;
  /** Options for the monitor */
  options?: {
    /** Thresholds for alerting */
    thresholds?: {
      critical?: number;
      warning?: number;
      ok?: number;
      criticalRecovery?: number;
      warningRecovery?: number;
    };
    /** Time in minutes before the monitor notifies after data stops reporting */
    notifyNoData?: boolean;
    /** Minutes to wait before evaluating new hosts */
    newHostDelay?: number;
    /** Number of minutes before a triggered monitor re-notifies on the current status */
    renotifyInterval?: number;
    /** Whether to require a full window of data before evaluating */
    requireFullWindow?: boolean;
    /** Time (in seconds) to delay evaluation */
    evaluationDelay?: number;
  };
};

type CreateMonitorResult = {
  id: number;
  name: string;
  type: string;
  query: string;
  message?: string;
  tags?: string[];
  overallState?: string;
  created?: string;
};

/**
 * Create a new monitor in Datadog
 * @APPROVAL_REQUIRED
 */
async function createMonitorInternal(args: CreateMonitorArgs): Promise<CreateMonitorResult> {
  await requireApproval({
    action: "datadog:createMonitor",
    data: {
      name: args.name,
      type: args.type,
      query: args.query,
    },
    info: {
      message: args.message,
      tags: args.tags,
      priority: args.priority,
      options: args.options,
    },
    description: `Create monitor "${args.name}" in Datadog`,
  });

  const body: Record<string, any> = {
    name: args.name,
    type: args.type,
    query: args.query,
  };
  if (args.message) body.message = args.message;
  if (args.tags) body.tags = args.tags;
  if (args.priority) body.priority = args.priority;
  if (args.options) {
    body.options = {};
    if (args.options.thresholds) {
      body.options.thresholds = {
        critical: args.options.thresholds.critical,
        warning: args.options.thresholds.warning,
        ok: args.options.thresholds.ok,
        critical_recovery: args.options.thresholds.criticalRecovery,
        warning_recovery: args.options.thresholds.warningRecovery,
      };
    }
    if (args.options.notifyNoData !== undefined) body.options.notify_no_data = args.options.notifyNoData;
    if (args.options.newHostDelay !== undefined) body.options.new_host_delay = args.options.newHostDelay;
    if (args.options.renotifyInterval !== undefined) body.options.renotify_interval = args.options.renotifyInterval;
    if (args.options.requireFullWindow !== undefined) body.options.require_full_window = args.options.requireFullWindow;
    if (args.options.evaluationDelay !== undefined) body.options.evaluation_delay = args.options.evaluationDelay;
  }

  const result = await datadogApiRequestInternal({
    method: "POST",
    path: "/api/v1/monitor",
    body,
  });

  return {
    id: result.body.id,
    name: result.body.name,
    type: result.body.type,
    query: result.body.query,
    message: result.body.message,
    tags: result.body.tags,
    overallState: result.body.overall_state,
    created: result.body.created,
  };
}

// ============================================================================
// List Dashboards
// ============================================================================

type ListDashboardsArgs = {
  /** Filter by dashboard name */
  filterShared?: boolean;
  /** Filter deleted dashboards */
  filterDeleted?: boolean;
};

type DashboardSummary = {
  id: string;
  title: string;
  description?: string;
  layoutType: string;
  url: string;
  authorHandle?: string;
  createdAt?: string;
  modifiedAt?: string;
};

type ListDashboardsResult = {
  dashboards: DashboardSummary[];
};

/** List Datadog dashboards */
async function listDashboardsInternal(args?: ListDashboardsArgs): Promise<ListDashboardsResult> {
  const queryParams: Record<string, string> = {};
  if (args?.filterShared !== undefined) queryParams.filter_shared = args.filterShared.toString();
  if (args?.filterDeleted !== undefined) queryParams.filter_deleted = args.filterDeleted.toString();

  const result = await datadogApiRequestInternal({
    method: "GET",
    path: "/api/v1/dashboard",
    queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
  });

  return {
    dashboards: (result.body.dashboards ?? []).map((d: any) => ({
      id: d.id,
      title: d.title,
      description: d.description,
      layoutType: d.layout_type,
      url: d.url,
      authorHandle: d.author_handle,
      createdAt: d.created_at,
      modifiedAt: d.modified_at,
    })),
  };
}

// ============================================================================
// Get Dashboard
// ============================================================================

type GetDashboardArgs = {
  dashboardId: string;
};

type Dashboard = DashboardSummary & {
  widgets: any[];
  templateVariables?: any[];
};

/** Get details of a specific dashboard */
async function getDashboardInternal(args: GetDashboardArgs): Promise<Dashboard> {
  const result = await datadogApiRequestInternal({
    method: "GET",
    path: `/api/v1/dashboard/${encodeURIComponent(args.dashboardId)}`,
  });

  return {
    id: result.body.id,
    title: result.body.title,
    description: result.body.description,
    layoutType: result.body.layout_type,
    url: result.body.url,
    authorHandle: result.body.author_handle,
    createdAt: result.body.created_at,
    modifiedAt: result.body.modified_at,
    widgets: result.body.widgets ?? [],
    templateVariables: result.body.template_variables,
  };
}

// ============================================================================
// Query Events
// ============================================================================

type QueryEventsArgs = {
  /** Start time as Unix epoch seconds */
  start: number;
  /** End time as Unix epoch seconds */
  end: number;
  /** Event priority (low or normal) */
  priority?: "low" | "normal";
  /** Comma-separated list of sources */
  sources?: string;
  /** Comma-separated list of tags */
  tags?: string;
  /** Whether to exclude aggregate events */
  unaggregated?: boolean;
};

type Event = {
  id: number;
  title: string;
  text?: string;
  dateHappened?: number;
  priority?: string;
  host?: string;
  tags?: string[];
  alertType?: string;
  source?: string;
};

type QueryEventsResult = {
  events: Event[];
};

/** Query Datadog events */
async function queryEventsInternal(args: QueryEventsArgs): Promise<QueryEventsResult> {
  const queryParams: Record<string, string> = {
    start: args.start.toString(),
    end: args.end.toString(),
  };
  if (args.priority) queryParams.priority = args.priority;
  if (args.sources) queryParams.sources = args.sources;
  if (args.tags) queryParams.tags = args.tags;
  if (args.unaggregated !== undefined) queryParams.unaggregated = args.unaggregated.toString();

  const result = await datadogApiRequestInternal({
    method: "GET",
    path: "/api/v1/events",
    queryParams,
  });

  return {
    events: (result.body.events ?? []).map((e: any) => ({
      id: e.id,
      title: e.title,
      text: e.text,
      dateHappened: e.date_happened,
      priority: e.priority,
      host: e.host,
      tags: e.tags,
      alertType: e.alert_type,
      source: e.source,
    })),
  };
}

// ============================================================================
// List Containers
// ============================================================================

type ListContainersArgs = {
  /** Filter by container name, image, or other attributes */
  filter?: string;
  /** Group by field (e.g., "container_name", "image_name", "host") */
  groupBy?: string;
  /** Number of results to return */
  limit?: number;
};

type Container = {
  id: string;
  name: string;
  image: string;
  imageTag?: string;
  host?: string;
  state?: string;
  started?: number;
  created?: number;
  cpuLimit?: number;
  memoryLimit?: number;
  tags?: string[];
};

type ListContainersResult = {
  containers: Container[];
};

/** List containers reporting to Datadog */
async function listContainersInternal(args?: ListContainersArgs): Promise<ListContainersResult> {
  const queryParams: Record<string, string> = {};
  if (args?.filter) queryParams.filter = args.filter;
  if (args?.groupBy) queryParams.group_by = args.groupBy;
  if (args?.limit) queryParams.limit = args.limit.toString();

  const result = await datadogApiRequestInternal({
    method: "GET",
    path: "/api/v2/containers",
    queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
  });

  const containers = result.body.data ?? [];
  return {
    containers: containers.map((c: any) => ({
      id: c.id,
      name: c.attributes?.name,
      image: c.attributes?.image_name,
      imageTag: c.attributes?.image_tag,
      host: c.attributes?.host,
      state: c.attributes?.state,
      started: c.attributes?.started,
      created: c.attributes?.created,
      cpuLimit: c.attributes?.cpu_limit,
      memoryLimit: c.attributes?.memory_limit,
      tags: c.attributes?.tags,
    })),
  };
}

// ============================================================================
// List Services
// ============================================================================

type ListServicesArgs = {
  /** Page size for pagination */
  pageSize?: number;
  /** Page number for pagination */
  pageNumber?: number;
  /** Filter by schema version */
  schemaVersion?: string;
};

type Service = {
  name: string;
  schema?: {
    version?: string;
  };
  meta?: {
    lastModifiedTime?: string;
  };
  contacts?: Array<{
    name?: string;
    type?: string;
    contact?: string;
  }>;
  links?: Array<{
    name?: string;
    type?: string;
    url?: string;
  }>;
  tags?: string[];
  team?: string;
  application?: string;
  description?: string;
};

type ListServicesResult = {
  services: Service[];
};

/** List services from the Datadog Service Catalog */
async function listServicesInternal(args?: ListServicesArgs): Promise<ListServicesResult> {
  const queryParams: Record<string, string> = {};
  if (args?.pageSize) queryParams["page[size]"] = args.pageSize.toString();
  if (args?.pageNumber) queryParams["page[number]"] = args.pageNumber.toString();
  if (args?.schemaVersion) queryParams.schema_version = args.schemaVersion;

  const result = await datadogApiRequestInternal({
    method: "GET",
    path: "/api/v2/services/definitions",
    queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
  });

  const services = result.body.data ?? [];
  return {
    services: services.map((s: any) => ({
      name: s.attributes?.schema?.["dd-service"] ?? s.attributes?.schema?.info?.["dd-service"],
      schema: {
        version: s.attributes?.schema?.["schema-version"],
      },
      meta: {
        lastModifiedTime: s.attributes?.meta?.["last-modified-time"],
      },
      contacts: s.attributes?.schema?.contacts,
      links: s.attributes?.schema?.links,
      tags: s.attributes?.schema?.tags,
      team: s.attributes?.schema?.team,
      application: s.attributes?.schema?.application,
      description: s.attributes?.schema?.description ?? s.attributes?.schema?.info?.description,
    })),
  };
}

// ============================================================================
// Get Service
// ============================================================================

type GetServiceArgs = {
  /** Service name */
  serviceName: string;
  /** Schema version to retrieve */
  schemaVersion?: string;
};

/** Get details of a specific service from the Service Catalog */
async function getServiceInternal(args: GetServiceArgs): Promise<Service> {
  const queryParams: Record<string, string> = {};
  if (args.schemaVersion) queryParams.schema_version = args.schemaVersion;

  const result = await datadogApiRequestInternal({
    method: "GET",
    path: `/api/v2/services/definitions/${encodeURIComponent(args.serviceName)}`,
    queryParams: Object.keys(queryParams).length > 0 ? queryParams : undefined,
  });

  const s = result.body.data;
  return {
    name: s?.attributes?.schema?.["dd-service"] ?? s?.attributes?.schema?.info?.["dd-service"],
    schema: {
      version: s?.attributes?.schema?.["schema-version"],
    },
    meta: {
      lastModifiedTime: s?.attributes?.meta?.["last-modified-time"],
    },
    contacts: s?.attributes?.schema?.contacts,
    links: s?.attributes?.schema?.links,
    tags: s?.attributes?.schema?.tags,
    team: s?.attributes?.schema?.team,
    application: s?.attributes?.schema?.application,
    description: s?.attributes?.schema?.description ?? s?.attributes?.schema?.info?.description,
  };
}

// ============================================================================
// Mute/Unmute Host (requires approval)
// ============================================================================

type MuteHostArgs = {
  hostName: string;
  /** Optional end timestamp for the mute (Unix epoch seconds) */
  end?: number;
  /** Optional message explaining why the host is muted */
  message?: string;
};

/**
 * Mute a host in Datadog
 * @APPROVAL_REQUIRED
 */
async function muteHostInternal(args: MuteHostArgs): Promise<{ hostname: string; action: string; message?: string }> {
  await requireApproval({
    action: "datadog:muteHost",
    data: {
      hostName: args.hostName,
    },
    info: {
      end: args.end,
      message: args.message,
    },
    description: `Mute host ${args.hostName} in Datadog`,
  });

  const body: Record<string, any> = {};
  if (args.end) body.end = args.end;
  if (args.message) body.message = args.message;

  const result = await datadogApiRequestInternal({
    method: "POST",
    path: `/api/v1/host/${encodeURIComponent(args.hostName)}/mute`,
    body: Object.keys(body).length > 0 ? body : undefined,
  });

  return {
    hostname: result.body.hostname,
    action: result.body.action,
    message: result.body.message,
  };
}

type UnmuteHostArgs = {
  hostName: string;
};

/**
 * Unmute a host in Datadog
 * @APPROVAL_REQUIRED
 */
async function unmuteHostInternal(args: UnmuteHostArgs): Promise<{ hostname: string; action: string }> {
  await requireApproval({
    action: "datadog:unmuteHost",
    data: {
      hostName: args.hostName,
    },
    description: `Unmute host ${args.hostName} in Datadog`,
  });

  const result = await datadogApiRequestInternal({
    method: "POST",
    path: `/api/v1/host/${encodeURIComponent(args.hostName)}/unmute`,
  });

  return {
    hostname: result.body.hostname,
    action: result.body.action,
  };
}

export const datadogApiRequest = action(
  z.object({
    method: z.enum(["GET", "POST", "PUT", "DELETE", "PATCH"]),
    path: z.string(),
    body: z.optional(z.record(z.string(), z.any())),
    queryParams: z.optional(z.record(z.string(), z.string())),
  }),
  async (args): Promise<DatadogApiRequestResult> => datadogApiRequestInternal(args),
);

export const queryMetrics = action(
  z.object({
    query: z.string().describe("Metrics query string, e.g. avg:kubernetes.cpu.usage.total{*}"),
    from: z.number().describe("Start time as Unix epoch seconds"),
    to: z.number().describe("End time as Unix epoch seconds"),
  }),
  async (args): Promise<QueryMetricsResult> => queryMetricsInternal(args),
);

export const listMetrics = action(
  z.object({
    query: z.optional(z.string().describe("Optional metric name prefix filter")),
  }),
  async (args): Promise<ListMetricsResult> => listMetricsInternal(args),
);

export const getMetricMetadata = action(
  z.object({
    metricName: z.string(),
  }),
  async (args): Promise<MetricMetadata> => getMetricMetadataInternal(args),
);

export const listHosts = action(
  z.object({
    filter: z.optional(z.string()),
    sortField: z.optional(z.string()),
    sortDir: z.enum(["asc", "desc"]).optional(),
    count: z.optional(z.number()),
    start: z.optional(z.number()),
  }),
  async (args): Promise<ListHostsResult> => listHostsInternal(args),
);

export const listMonitors = action(
  z.object({
    name: z.optional(z.string()),
    tags: z.optional(z.string()),
    monitorType: z.optional(z.string()),
  }),
  async (args): Promise<ListMonitorsResult> => listMonitorsInternal(args),
);

export const getMonitor = action(
  z.object({
    monitorId: z.number(),
  }),
  async (args): Promise<Monitor> => getMonitorInternal(args),
);

export const createMonitor = action(
  z.object({
    name: z.string(),
    type: z.string(),
    query: z.string(),
    message: z.optional(z.string()),
    tags: z.optional(z.array(z.string())),
    priority: z.optional(z.number()),
    options: z.optional(
      z.object({
        thresholds: z
          .object({
            critical: z.optional(z.number()),
            warning: z.optional(z.number()),
            ok: z.optional(z.number()),
            criticalRecovery: z.optional(z.number()),
            warningRecovery: z.optional(z.number()),
          })
          .optional(),
        notifyNoData: z.optional(z.boolean()),
        newHostDelay: z.optional(z.number()),
        renotifyInterval: z.optional(z.number()),
        requireFullWindow: z.optional(z.boolean()),
        evaluationDelay: z.optional(z.number()),
      }),
    ),
  }),
  async (args): Promise<CreateMonitorResult> => createMonitorInternal(args),
);

export const listDashboards = action(
  z.object({
    filterShared: z.optional(z.boolean()),
    filterDeleted: z.optional(z.boolean()),
  }),
  async (args): Promise<ListDashboardsResult> => listDashboardsInternal(args),
);

export const getDashboard = action(
  z.object({
    dashboardId: z.string(),
  }),
  async (args): Promise<Dashboard> => getDashboardInternal(args),
);

export const queryEvents = action(
  z.object({
    start: z.number(),
    end: z.number(),
    priority: z.enum(["low", "normal"]).optional(),
    sources: z.optional(z.string()),
    tags: z.optional(z.string()),
    unaggregated: z.optional(z.boolean()),
  }),
  async (args): Promise<QueryEventsResult> => queryEventsInternal(args),
);

export const listContainers = action(
  z.object({
    filter: z.optional(z.string()),
    groupBy: z.optional(z.string()),
    limit: z.optional(z.number()),
  }),
  async (args): Promise<ListContainersResult> => listContainersInternal(args),
);

export const listServices = action(
  z.object({
    pageSize: z.optional(z.number()),
    pageNumber: z.optional(z.number()),
    schemaVersion: z.optional(z.string()),
  }),
  async (args): Promise<ListServicesResult> => listServicesInternal(args),
);

export const getService = action(
  z.object({
    serviceName: z.string(),
    schemaVersion: z.optional(z.string()),
  }),
  async (args): Promise<Service> => getServiceInternal(args),
);

export const muteHost = action(
  z.object({
    hostName: z.string(),
    end: z.optional(z.number()),
    message: z.optional(z.string()),
  }),
  async (args): Promise<{ hostname: string; action: string; message?: string }> => muteHostInternal(args),
);

export const unmuteHost = action(
  z.object({
    hostName: z.string(),
  }),
  async (args): Promise<{ hostname: string; action: string }> => unmuteHostInternal(args),
);
