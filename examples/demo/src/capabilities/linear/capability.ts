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
import { linearApiKey } from "../../credentials";

const log = new Logger("linear");
const LINEAR_GRAPHQL_URL = "https://api.linear.app/graphql";

// Keep capability scope explicit and fail-closed to these team keys.
const ALLOWED_TEAM_KEYS = new Set(["DEMO"]);

const TEAM_KEY_RE = /^[A-Za-z][A-Za-z0-9]{1,9}$/;
const ISSUE_IDENTIFIER_RE = /^([A-Za-z][A-Za-z0-9]{1,9})-(\d{1,7})$/;

class LinearScopeError extends TokenspaceError {
  constructor(message: string, details?: string) {
    super(message, undefined, details);
    this.name = "LinearScopeError";
  }
}

class LinearApiError extends TokenspaceError {
  constructor(
    message: string,
    public readonly response?: Response,
    details?: string,
  ) {
    super(message, undefined, details, { status: response?.status });
    this.name = "LinearApiError";
  }
}

const linearTeamSchema = z.object({
  id: z.string(),
  key: z.string(),
  name: z.string(),
});

const linearIssueRelationSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  team: linearTeamSchema,
});

const linearIssueSchema = z.object({
  id: z.string(),
  identifier: z.string(),
  title: z.string(),
  description: z.string().nullable().optional(),
  priority: z.number().nullable().optional(),
  url: z.string().optional(),
  createdAt: z.string().optional(),
  updatedAt: z.string().optional(),
  team: linearTeamSchema,
  state: z
    .object({
      id: z.string(),
      name: z.string(),
      type: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  project: z
    .object({
      id: z.string(),
      name: z.string(),
    })
    .nullable()
    .optional(),
  assignee: z
    .object({
      id: z.string(),
      name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .nullable()
    .optional(),
  parent: linearIssueRelationSchema.nullable().optional(),
  children: z
    .object({
      nodes: z.array(linearIssueRelationSchema).default([]),
    })
    .optional(),
});

const issuesConnectionSchema = z.object({
  nodes: z.array(linearIssueSchema).default([]),
});

const workflowStateSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
});

const graphQlEnvelopeSchema = z.object({
  data: z.unknown().optional(),
  errors: z
    .array(
      z.object({
        message: z.string(),
      }),
    )
    .optional(),
});

const teamKeySchema = z
  .string()
  .min(2)
  .max(10)
  .regex(TEAM_KEY_RE, "Team keys must be alphanumeric and start with a letter");

const issueIdentifierSchema = z.string().trim().regex(ISSUE_IDENTIFIER_RE, "Issue identifier must look like TOK-123");

type NormalizedIssueIdentifier = {
  identifier: string;
  teamKey: string;
  issueNumber: number;
};

function normalizeTeamKey(teamKey: string): string {
  const normalized = teamKey.trim().toUpperCase();
  if (!TEAM_KEY_RE.test(normalized)) {
    throw new LinearScopeError(`Invalid team key: ${teamKey}`);
  }
  if (!ALLOWED_TEAM_KEYS.has(normalized)) {
    throw new LinearScopeError(
      `Team ${normalized} is out of scope. Allowed teams: ${Array.from(ALLOWED_TEAM_KEYS).join(", ")}`,
    );
  }
  return normalized;
}

function normalizeIssueIdentifier(identifier: string): NormalizedIssueIdentifier {
  const trimmed = identifier.trim().toUpperCase();
  const match = ISSUE_IDENTIFIER_RE.exec(trimmed);
  if (!match) {
    throw new LinearScopeError(
      `Invalid issue identifier: ${identifier}`,
      "Expected format: <TEAM>-<NUMBER>, for example TOK-123",
    );
  }
  const teamKey = normalizeTeamKey(match[1]);
  const issueNumber = Number.parseInt(match[2], 10);
  return {
    identifier: `${teamKey}-${issueNumber}`,
    teamKey,
    issueNumber,
  };
}

function toIssueSummary(issue: z.infer<typeof linearIssueSchema>) {
  const parentTeamKey = issue.parent ? normalizeTeamKey(issue.parent.team.key) : undefined;
  const subIssues = (issue.children?.nodes ?? []).map((subIssue) => ({
    id: subIssue.id,
    identifier: subIssue.identifier,
    title: subIssue.title,
    team: {
      id: subIssue.team.id,
      key: normalizeTeamKey(subIssue.team.key),
      name: subIssue.team.name,
    },
  }));

  return {
    id: issue.id,
    identifier: issue.identifier,
    title: issue.title,
    description: issue.description ?? undefined,
    priority: issue.priority ?? undefined,
    url: issue.url,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
    team: {
      id: issue.team.id,
      key: issue.team.key,
      name: issue.team.name,
    },
    state: issue.state
      ? {
          id: issue.state.id,
          name: issue.state.name,
          type: issue.state.type ?? undefined,
        }
      : undefined,
    project: issue.project
      ? {
          id: issue.project.id,
          name: issue.project.name,
        }
      : undefined,
    assignee: issue.assignee
      ? {
          id: issue.assignee.id,
          name: issue.assignee.name ?? undefined,
          email: issue.assignee.email ?? undefined,
        }
      : undefined,
    parent: issue.parent
      ? {
          id: issue.parent.id,
          identifier: issue.parent.identifier,
          title: issue.parent.title,
          team: {
            id: issue.parent.team.id,
            key: parentTeamKey,
            name: issue.parent.team.name,
          },
        }
      : undefined,
    subIssues,
  };
}

function getGraphQlErrorMessage(errors: Array<{ message: string }>): string {
  return errors.map((err) => err.message).join("; ");
}

async function linearGraphqlRequest<T>(query: string, variables?: Record<string, unknown>): Promise<T> {
  const { accessToken } = await getCredential(linearApiKey);
  // const apiKey = (await getCredential(linearApiKey)).trim();
  if (accessToken.length === 0) {
    throw new LinearApiError("Linear API key is empty");
  }

  const response = await request({
    url: LINEAR_GRAPHQL_URL,
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${accessToken}`,
    },
    body: JSON.stringify({
      query,
      variables,
    }),
    checkResponseStatus: false,
  });

  if (!response.ok) {
    const body = await parseResponseBody(response).catch(() => null);
    log.error(`Linear API request failed: ${response.statusText}`, body);
    throw new LinearApiError(
      `Linear API request failed: ${response.statusText}`,
      response,
      typeof body === "string" ? body : JSON.stringify(body),
    );
  }

  const raw = await response.json();
  const envelope = graphQlEnvelopeSchema.safeParse(raw);
  if (!envelope.success) {
    throw new LinearApiError(
      "Unexpected GraphQL response envelope from Linear",
      response,
      prettifyError(envelope.error),
    );
  }

  if (envelope.data.errors && envelope.data.errors.length > 0) {
    throw new LinearApiError("Linear GraphQL returned errors", response, getGraphQlErrorMessage(envelope.data.errors));
  }

  if (envelope.data.data === undefined) {
    throw new LinearApiError("Linear GraphQL returned no data", response);
  }

  return envelope.data.data as T;
}

async function getTeamByKey(teamKey: string): Promise<z.infer<typeof linearTeamSchema>> {
  const data = await linearGraphqlRequest<unknown>(
    `
      query TeamByKey($teamKey: String!) {
        teams(first: 1, filter: { key: { eq: $teamKey } }) {
          nodes {
            id
            key
            name
          }
        }
      }
    `,
    { teamKey },
  );

  const parsed = z
    .object({
      teams: z.object({
        nodes: z.array(linearTeamSchema).default([]),
      }),
    })
    .safeParse(data);

  if (!parsed.success) {
    throw new LinearApiError(
      "Unexpected response while looking up Linear team",
      undefined,
      prettifyError(parsed.error),
    );
  }

  const team = parsed.data.teams.nodes[0];
  if (!team) {
    throw new LinearScopeError(`Team ${teamKey} was not found in Linear`);
  }
  const normalizedTeamKey = normalizeTeamKey(team.key);
  if (normalizedTeamKey !== teamKey) {
    throw new LinearScopeError(`Requested team ${teamKey} resolved to out-of-scope team ${team.key}`);
  }

  return {
    ...team,
    key: normalizedTeamKey,
  };
}

async function resolveIssueByIdentifier(identifier: string): Promise<z.infer<typeof linearIssueSchema>> {
  const normalized = normalizeIssueIdentifier(identifier);

  const data = await linearGraphqlRequest<unknown>(
    `
      query FindIssue($teamKey: String!, $issueNumber: Float!) {
        issues(
          first: 1
          filter: {
            team: { key: { eq: $teamKey } }
            number: { eq: $issueNumber }
          }
        ) {
          nodes {
            id
            identifier
            title
            description
            priority
            url
            createdAt
            updatedAt
            team {
              id
              key
              name
            }
            state {
              id
              name
              type
            }
            project {
              id
              name
            }
            assignee {
              id
              name
              email
            }
            parent {
              id
              identifier
              title
              team {
                id
                key
                name
              }
            }
            children(first: 50) {
              nodes {
                id
                identifier
                title
                team {
                  id
                  key
                  name
                }
              }
            }
          }
        }
      }
    `,
    {
      teamKey: normalized.teamKey,
      issueNumber: normalized.issueNumber,
    },
  );

  const parsed = z
    .object({
      issues: issuesConnectionSchema,
    })
    .safeParse(data);

  if (!parsed.success) {
    throw new LinearApiError(
      "Unexpected response while resolving Linear issue",
      undefined,
      prettifyError(parsed.error),
    );
  }

  const issue = parsed.data.issues.nodes[0];
  if (!issue) {
    throw new LinearScopeError(`Issue ${normalized.identifier} was not found`);
  }
  const issueTeamKey = normalizeTeamKey(issue.team.key);
  if (issueTeamKey !== normalized.teamKey) {
    throw new LinearScopeError(
      `Issue ${normalized.identifier} belongs to out-of-scope team ${issue.team.key}`,
      "Issue operations are limited to allowed team keys",
    );
  }

  return {
    ...issue,
    team: {
      ...issue.team,
      key: issueTeamKey,
    },
  };
}

export const listTeams = action(z.object({}), async () => {
  const data = await linearGraphqlRequest<unknown>(
    `
      query ListTeams {
        teams(first: 100) {
          nodes {
            id
            key
            name
          }
        }
      }
    `,
  );

  const parsed = z
    .object({
      teams: z.object({
        nodes: z.array(linearTeamSchema).default([]),
      }),
    })
    .safeParse(data);

  if (!parsed.success) {
    throw new LinearApiError("Unexpected response while listing Linear teams", undefined, prettifyError(parsed.error));
  }

  const teams = parsed.data.teams.nodes
    .map((team) => ({
      ...team,
      key: team.key.toUpperCase(),
    }))
    .filter((team) => ALLOWED_TEAM_KEYS.has(team.key));

  return { teams };
});

export const listTeamIssues = action(
  z.object({
    teamKey: teamKeySchema,
    limit: z.number().int().min(1).max(100).optional().default(25),
    status: z.string().trim().min(1).max(120).optional(),
  }),
  async ({ teamKey, limit, status }) => {
    const normalizedTeamKey = normalizeTeamKey(teamKey);
    const normalizedStatus = status?.trim();
    const statusVariableDefinition = normalizedStatus ? ", $status: String!" : "";
    const statusFilter = normalizedStatus
      ? `
              state: { name: { eq: $status } }
      `
      : "";

    const data = await linearGraphqlRequest<unknown>(
      `
        query ListTeamIssues($teamKey: String!, $first: Int!${statusVariableDefinition}) {
          issues(
            first: $first
            orderBy: updatedAt
            filter: {
              team: { key: { eq: $teamKey } }
              ${statusFilter}
            }
          ) {
            nodes {
              id
              identifier
              title
              description
              priority
              url
              createdAt
              updatedAt
              team {
                id
                key
                name
              }
              state {
                id
                name
                type
              }
              project {
                id
                name
              }
              assignee {
                id
                name
                email
              }
              parent {
                id
                identifier
                title
                team {
                  id
                  key
                  name
                }
              }
              children(first: 50) {
                nodes {
                  id
                  identifier
                  title
                  team {
                    id
                    key
                    name
                  }
                }
              }
            }
          }
        }
      `,
      {
        teamKey: normalizedTeamKey,
        first: limit,
        ...(normalizedStatus ? { status: normalizedStatus } : {}),
      },
    );

    const parsed = z
      .object({
        issues: issuesConnectionSchema,
      })
      .safeParse(data);

    if (!parsed.success) {
      throw new LinearApiError("Unexpected response while listing team issues", undefined, prettifyError(parsed.error));
    }

    const issues = parsed.data.issues.nodes.map((issue) => {
      const issueTeamKey = normalizeTeamKey(issue.team.key);
      if (issueTeamKey !== normalizedTeamKey) {
        throw new LinearScopeError(
          `Issue ${issue.identifier} does not belong to requested team ${normalizedTeamKey}`,
          "Cross-team issue results are rejected",
        );
      }
      return toIssueSummary({
        ...issue,
        team: { ...issue.team, key: issueTeamKey },
      });
    });

    return { issues };
  },
);

export const getIssue = action(
  z.object({
    identifier: issueIdentifierSchema,
  }),
  async ({ identifier }) => {
    const issue = await resolveIssueByIdentifier(identifier);
    return { issue: toIssueSummary(issue) };
  },
);

export const listTeamWorkflowStates = action(
  z.object({
    teamKey: teamKeySchema,
  }),
  async ({ teamKey }) => {
    const normalizedTeamKey = normalizeTeamKey(teamKey);

    const data = await linearGraphqlRequest<unknown>(
      `
        query ListWorkflowStates($teamKey: String!) {
          workflowStates(
            filter: {
              team: { key: { eq: $teamKey } }
            }
          ) {
            nodes {
              id
              name
              type
              description
            }
          }
        }
      `,
      { teamKey: normalizedTeamKey },
    );

    const parsed = z
      .object({
        workflowStates: z.object({
          nodes: z.array(workflowStateSchema).default([]),
        }),
      })
      .safeParse(data);

    if (!parsed.success) {
      throw new LinearApiError(
        "Unexpected response while listing workflow states",
        undefined,
        prettifyError(parsed.error),
      );
    }

    return {
      states: parsed.data.workflowStates.nodes,
    };
  },
);

export const createIssue = action(
  z.object({
    teamKey: teamKeySchema,
    title: z.string().trim().min(1).max(500),
    description: z.string().trim().max(10000).optional(),
    priority: z.number().int().min(0).max(4).optional(),
    parentIdentifier: issueIdentifierSchema.optional(),
  }),
  async ({ teamKey, title, description, priority, parentIdentifier }) => {
    const normalizedTeamKey = normalizeTeamKey(teamKey);
    const team = await getTeamByKey(normalizedTeamKey);
    const parentIssue = parentIdentifier ? await resolveIssueByIdentifier(parentIdentifier) : undefined;
    if (parentIssue && parentIssue.team.key !== normalizedTeamKey) {
      throw new LinearScopeError(
        `Parent issue ${parentIssue.identifier} belongs to ${parentIssue.team.key}, expected ${normalizedTeamKey}`,
      );
    }

    const data = await linearGraphqlRequest<unknown>(
      `
        mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue {
              id
              identifier
              title
              description
              priority
              url
              createdAt
              updatedAt
              team {
                id
                key
                name
              }
              state {
                id
                name
                type
              }
              project {
                id
                name
              }
              assignee {
                id
                name
                email
              }
              parent {
                id
                identifier
                title
                team {
                  id
                  key
                  name
                }
              }
              children(first: 50) {
                nodes {
                  id
                  identifier
                  title
                  team {
                    id
                    key
                    name
                  }
                }
              }
            }
          }
        }
      `,
      {
        input: {
          teamId: team.id,
          title,
          description,
          priority,
          parentId: parentIssue?.id,
        },
      },
    );

    const parsed = z
      .object({
        issueCreate: z.object({
          success: z.boolean(),
          issue: linearIssueSchema.nullable().optional(),
        }),
      })
      .safeParse(data);

    if (!parsed.success) {
      throw new LinearApiError("Unexpected response while creating issue", undefined, prettifyError(parsed.error));
    }

    if (!parsed.data.issueCreate.success || !parsed.data.issueCreate.issue) {
      throw new LinearApiError("Linear issue creation failed", undefined, `Team: ${team.key}`);
    }

    return {
      issue: toIssueSummary({
        ...parsed.data.issueCreate.issue,
        team: {
          ...parsed.data.issueCreate.issue.team,
          key: normalizeTeamKey(parsed.data.issueCreate.issue.team.key),
        },
      }),
    };
  },
);

export const updateIssue = action(
  z
    .object({
      identifier: issueIdentifierSchema,
      title: z.string().trim().min(1).max(500).optional(),
      description: z.string().trim().max(10000).optional(),
      priority: z.number().int().min(0).max(4).optional(),
      stateId: z.string().trim().min(1).max(128).optional(),
      parentIdentifier: issueIdentifierSchema.optional(),
      clearParent: z.boolean().optional(),
    })
    .refine(
      (data) =>
        data.title !== undefined ||
        data.description !== undefined ||
        data.priority !== undefined ||
        data.stateId !== undefined ||
        data.parentIdentifier !== undefined ||
        data.clearParent === true,
      {
        message: "At least one mutable field must be provided",
      },
    ),
  async ({ identifier, title, description, priority, stateId, parentIdentifier, clearParent }) => {
    const issue = await resolveIssueByIdentifier(identifier);
    if (parentIdentifier && clearParent === true) {
      throw new LinearScopeError("Provide either parentIdentifier or clearParent=true, not both");
    }
    const parentIssue = parentIdentifier ? await resolveIssueByIdentifier(parentIdentifier) : undefined;
    if (parentIssue && parentIssue.team.key !== issue.team.key) {
      throw new LinearScopeError(
        `Parent issue ${parentIssue.identifier} belongs to ${parentIssue.team.key}, expected ${issue.team.key}`,
      );
    }

    const input = {
      ...(title !== undefined ? { title } : {}),
      ...(description !== undefined ? { description } : {}),
      ...(priority !== undefined ? { priority } : {}),
      ...(stateId !== undefined ? { stateId } : {}),
      ...(parentIssue ? { parentId: parentIssue.id } : {}),
      ...(clearParent === true ? { parentId: null } : {}),
    };

    const data = await linearGraphqlRequest<unknown>(
      `
        mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue {
              id
              identifier
              title
              description
              priority
              url
              createdAt
              updatedAt
              team {
                id
                key
                name
              }
              state {
                id
                name
                type
              }
              project {
                id
                name
              }
              assignee {
                id
                name
                email
              }
              parent {
                id
                identifier
                title
                team {
                  id
                  key
                  name
                }
              }
              children(first: 50) {
                nodes {
                  id
                  identifier
                  title
                  team {
                    id
                    key
                    name
                  }
                }
              }
            }
          }
        }
      `,
      {
        id: issue.id,
        input,
      },
    );

    const parsed = z
      .object({
        issueUpdate: z.object({
          success: z.boolean(),
          issue: linearIssueSchema.nullable().optional(),
        }),
      })
      .safeParse(data);

    if (!parsed.success) {
      throw new LinearApiError("Unexpected response while updating issue", undefined, prettifyError(parsed.error));
    }

    if (!parsed.data.issueUpdate.success || !parsed.data.issueUpdate.issue) {
      throw new LinearApiError("Linear issue update failed", undefined, `Issue: ${issue.identifier}`);
    }

    const updatedTeamKey = normalizeTeamKey(parsed.data.issueUpdate.issue.team.key);
    return {
      issue: toIssueSummary({
        ...parsed.data.issueUpdate.issue,
        team: { ...parsed.data.issueUpdate.issue.team, key: updatedTeamKey },
      }),
    };
  },
);

export const deleteIssue = action(
  z.object({
    identifier: issueIdentifierSchema,
  }),
  async ({ identifier }) => {
    const issue = await resolveIssueByIdentifier(identifier);

    await requireApproval({
      action: "linear:deleteIssue",
      data: {
        identifier: issue.identifier,
        issueId: issue.id,
        teamKey: issue.team.key,
      },
      description: `Delete Linear issue ${issue.identifier}`,
    });

    const data = await linearGraphqlRequest<unknown>(
      `
        mutation DeleteIssue($id: String!) {
          issueDelete(id: $id) {
            success
          }
        }
      `,
      { id: issue.id },
    );

    const parsed = z
      .object({
        issueDelete: z.object({
          success: z.boolean(),
        }),
      })
      .safeParse(data);

    if (!parsed.success) {
      throw new LinearApiError("Unexpected response while deleting issue", undefined, prettifyError(parsed.error));
    }

    if (!parsed.data.issueDelete.success) {
      throw new LinearApiError("Linear issue deletion failed", undefined, `Issue: ${issue.identifier}`);
    }

    return {
      deleted: true,
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        teamKey: issue.team.key,
      },
    };
  },
);

export const createComment = action(
  z.object({
    identifier: issueIdentifierSchema,
    body: z.string().trim().min(1).max(10000),
  }),
  async ({ identifier, body }) => {
    const issue = await resolveIssueByIdentifier(identifier);

    const data = await linearGraphqlRequest<unknown>(
      `
        mutation CreateComment($input: CommentCreateInput!) {
          commentCreate(input: $input) {
            success
            comment {
              id
              body
              url
              createdAt
            }
          }
        }
      `,
      {
        input: {
          issueId: issue.id,
          body,
        },
      },
    );

    const parsed = z
      .object({
        commentCreate: z.object({
          success: z.boolean(),
          comment: z
            .object({
              id: z.string(),
              body: z.string(),
              url: z.string().optional(),
              createdAt: z.string().optional(),
            })
            .nullable()
            .optional(),
        }),
      })
      .safeParse(data);

    if (!parsed.success) {
      throw new LinearApiError("Unexpected response while creating comment", undefined, prettifyError(parsed.error));
    }

    if (!parsed.data.commentCreate.success || !parsed.data.commentCreate.comment) {
      throw new LinearApiError("Linear comment creation failed", undefined, `Issue: ${issue.identifier}`);
    }

    return {
      comment: {
        id: parsed.data.commentCreate.comment.id,
        body: parsed.data.commentCreate.comment.body,
        url: parsed.data.commentCreate.comment.url,
        createdAt: parsed.data.commentCreate.comment.createdAt,
      },
      issue: {
        id: issue.id,
        identifier: issue.identifier,
        teamKey: issue.team.key,
      },
    };
  },
);
