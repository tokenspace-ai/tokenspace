import {
  action,
  getCredential,
  Logger,
  parseResponseBody,
  request,
  requireApproval,
  TokenspaceError,
} from "@tokenspace/sdk";
import z from "zod";
import { githubToken } from "../../credentials";

const log = new Logger("github");

const baseUrl = "https://api.github.com";

function serializeHeaders(headers?: Headers): Record<string, string> | undefined {
  if (!headers) {
    return undefined;
  }
  return Object.fromEntries(headers.entries());
}

// =============================================================================
// Error class
// =============================================================================

class GitHubApiError extends TokenspaceError {
  constructor(
    message: string,
    public readonly response?: Response,
    details?: string,
  ) {
    super(message, undefined, details, { status: response?.status, headers: serializeHeaders(response?.headers) });
    this.name = "GitHubApiError";
  }
}

// =============================================================================
// Helper functions
// =============================================================================

async function githubRequest<T>(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${baseUrl}${path}`;

  log.debug(`GitHub API request: ${method} ${path}`);

  const bearerToken = await getCredential(githubToken);

  const response = await request({
    url,
    method,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
    auth: {
      type: "bearer",
      token: bearerToken,
    },
    checkResponseStatus: false,
  });

  if (!response.ok) {
    const errorBody = await parseResponseBody(response).catch(() => null);
    log.error(`GitHub API request failed: ${response.statusText}`, errorBody);
    throw new GitHubApiError(
      `GitHub API request failed: ${response.statusText}`,
      response,
      typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody),
    );
  }

  // Handle 204 No Content
  if (response.status === 204) {
    return {} as T;
  }

  return (await response.json()) as T;
}

async function githubRequestRaw(
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE",
  path: string,
  accept?: string,
): Promise<string> {
  const url = `${baseUrl}${path}`;

  log.debug(`GitHub API raw request: ${method} ${path}`);

  const bearerToken = await getCredential(githubToken);

  const response = await request({
    url,
    method,
    headers: {
      Accept: accept || "application/vnd.github.raw+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    auth: {
      type: "bearer",
      token: bearerToken,
    },
    checkResponseStatus: false,
  });

  if (!response.ok) {
    const errorBody = await parseResponseBody(response).catch(() => null);
    log.error(`GitHub API request failed: ${response.statusText}`, errorBody);
    throw new GitHubApiError(
      `GitHub API request failed: ${response.statusText}`,
      response,
      typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody),
    );
  }

  return await response.text();
}

// =============================================================================
// Common Schemas
// =============================================================================

const userSchema = z.object({
  login: z.string(),
  id: z.number(),
  avatar_url: z.string(),
  html_url: z.string(),
});

const labelSchema = z.object({
  id: z.number(),
  name: z.string(),
  color: z.string(),
  description: z.optional(z.string().nullable()),
});

type Label = z.infer<typeof labelSchema>;

// =============================================================================
// Repository
// =============================================================================

const repositorySchema = z.object({
  id: z.number(),
  name: z.string(),
  full_name: z.string(),
  private: z.boolean(),
  description: z.string().nullable(),
  fork: z.boolean(),
  html_url: z.string(),
  clone_url: z.string(),
  ssh_url: z.optional(z.string()),
  default_branch: z.string(),
  language: z.string().nullable(),
  stargazers_count: z.number(),
  watchers_count: z.number(),
  forks_count: z.number(),
  open_issues_count: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
  pushed_at: z.string().nullable(),
  archived: z.optional(z.boolean()),
  disabled: z.optional(z.boolean()),
  visibility: z.optional(z.string()),
  topics: z.optional(z.array(z.string())),
});

type Repository = z.infer<typeof repositorySchema>;

type ListRepositoriesResult = {
  repositories: Repository[];
};

// =============================================================================
// Branches

// =============================================================================

const branchSchema = z.object({
  name: z.string(),
  commit: z.object({
    sha: z.string(),
    url: z.string(),
  }),
  protected: z.boolean(),
});

type Branch = z.infer<typeof branchSchema>;

const branchDetailSchema = branchSchema.extend({
  protection: z.optional(
    z.object({
      enabled: z.boolean(),
      required_status_checks: z.optional(
        z
          .object({
            enforcement_level: z.string(),
            contexts: z.array(z.string()),
          })
          .nullable(),
      ),
    }),
  ),
  protection_url: z.optional(z.string()),
});

type BranchDetail = z.infer<typeof branchDetailSchema>;

type ListBranchesResult = {
  branches: Branch[];
};

// =============================================================================
// Commits
// =============================================================================

const commitAuthorSchema = z.object({
  name: z.optional(z.string()),
  email: z.optional(z.string()),
  date: z.optional(z.string()),
});

const commitSchema = z.object({
  sha: z.string(),
  node_id: z.optional(z.string()),
  commit: z.object({
    author: commitAuthorSchema.nullable(),
    committer: commitAuthorSchema.nullable(),
    message: z.string(),
    tree: z.object({ sha: z.string(), url: z.string() }),
    url: z.string(),
    comment_count: z.optional(z.number()),
  }),
  url: z.string(),
  html_url: z.string(),
  author: userSchema.nullable(),
  committer: userSchema.nullable(),
  parents: z.array(z.object({ sha: z.string(), url: z.string(), html_url: z.optional(z.string()) })),
});

type Commit = z.infer<typeof commitSchema>;

type ListCommitsResult = {
  commits: Commit[];
};

const compareCommitsResultSchema = z.object({
  url: z.string(),
  html_url: z.string(),
  permalink_url: z.string(),
  diff_url: z.string(),
  patch_url: z.string(),
  status: z.enum(["diverged", "ahead", "behind", "identical"]),
  ahead_by: z.number(),
  behind_by: z.number(),
  total_commits: z.number(),
  commits: z.array(commitSchema),
  files: z.optional(
    z.array(
      z.object({
        sha: z.string(),
        filename: z.string(),
        status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
        additions: z.number(),
        deletions: z.number(),
        changes: z.number(),
        patch: z.optional(z.string()),
        previous_filename: z.optional(z.string()),
      }),
    ),
  ),
});

type CompareCommitsResult = z.infer<typeof compareCommitsResultSchema>;

// =============================================================================
// File Contents
// =============================================================================

const contentFileSchema = z.object({
  type: z.literal("file"),
  encoding: z.optional(z.string()),
  size: z.number(),
  name: z.string(),
  path: z.string(),
  content: z.optional(z.string()),
  sha: z.string(),
  url: z.string(),
  git_url: z.string().nullable(),
  html_url: z.string().nullable(),
  download_url: z.string().nullable(),
});

const contentDirEntrySchema = z.object({
  type: z.enum(["file", "dir", "submodule", "symlink"]),
  size: z.number(),
  name: z.string(),
  path: z.string(),
  sha: z.string(),
  url: z.string(),
  git_url: z.string().nullable(),
  html_url: z.string().nullable(),
  download_url: z.string().nullable(),
});

type ContentFile = z.infer<typeof contentFileSchema>;
type ContentDirEntry = z.infer<typeof contentDirEntrySchema>;

type GetContentResult = {
  type: "file" | "directory";
  file?: ContentFile;
  entries?: ContentDirEntry[];
};

const fileCommitResultSchema = z.object({
  content: contentFileSchema.nullable(),
  commit: z.object({
    sha: z.string(),
    url: z.string(),
    html_url: z.string(),
    message: z.string(),
    author: commitAuthorSchema.nullable(),
    committer: commitAuthorSchema.nullable(),
  }),
});

type FileCommitResult = z.infer<typeof fileCommitResultSchema>;

// =============================================================================
// Tags
// =============================================================================

const tagSchema = z.object({
  name: z.string(),
  commit: z.object({
    sha: z.string(),
    url: z.string(),
  }),
  zipball_url: z.string(),
  tarball_url: z.string(),
  node_id: z.optional(z.string()),
});

type Tag = z.infer<typeof tagSchema>;

type ListTagsResult = {
  tags: Tag[];
};

const gitTagSchema = z.object({
  node_id: z.optional(z.string()),
  tag: z.string(),
  sha: z.string(),
  url: z.string(),
  message: z.string(),
  tagger: z.object({
    name: z.string(),
    email: z.string(),
    date: z.string(),
  }),
  object: z.object({
    type: z.string(),
    sha: z.string(),
    url: z.string(),
  }),
});

type GitTag = z.infer<typeof gitTagSchema>;

// =============================================================================
// Pull Requests
// =============================================================================

const pullRequestSchema = z.object({
  id: z.number(),
  number: z.number(),
  state: z.enum(["open", "closed"]),
  title: z.string(),
  body: z.string().nullable(),
  user: userSchema.nullable(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  merged_at: z.string().nullable(),
  draft: z.optional(z.boolean()),
  head: z.object({
    ref: z.string(),
    sha: z.string(),
  }),
  base: z.object({
    ref: z.string(),
    sha: z.string(),
  }),
});

type PullRequest = z.infer<typeof pullRequestSchema>;

type ListPullRequestsResult = {
  pullRequests: PullRequest[];
};

const mergeResultSchema = z.object({
  sha: z.string(),
  merged: z.boolean(),
  message: z.string(),
});

type MergeResult = z.infer<typeof mergeResultSchema>;

const pullRequestFileSchema = z.object({
  sha: z.string(),
  filename: z.string(),
  status: z.enum(["added", "removed", "modified", "renamed", "copied", "changed", "unchanged"]),
  additions: z.number(),
  deletions: z.number(),
  changes: z.number(),
  patch: z.optional(z.string()),
  previous_filename: z.optional(z.string()),
});

type PullRequestFile = z.infer<typeof pullRequestFileSchema>;

type ListPullRequestFilesResult = {
  files: PullRequestFile[];
};

type ListPullRequestCommitsResult = {
  commits: Commit[];
};

// =============================================================================
// Pull Request Reviews
// =============================================================================

const reviewSchema = z.object({
  id: z.number(),
  user: userSchema.nullable(),
  body: z.string().nullable(),
  state: z.enum(["APPROVED", "CHANGES_REQUESTED", "COMMENTED", "DISMISSED", "PENDING"]),
  html_url: z.string(),
  submitted_at: z.optional(z.string().nullable()),
  commit_id: z.optional(z.string().nullable()),
});

type Review = z.infer<typeof reviewSchema>;

type ListPullRequestReviewsResult = {
  reviews: Review[];
};

// =============================================================================
// Issues

// =============================================================================

const milestoneSchema = z.object({
  id: z.number(),
  number: z.number(),
  title: z.string(),
  description: z.string().nullable(),
  state: z.enum(["open", "closed"]),
  due_on: z.string().nullable(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  open_issues: z.number(),
  closed_issues: z.number(),
});

type Milestone = z.infer<typeof milestoneSchema>;

const issueSchema = z.object({
  id: z.number(),
  number: z.number(),
  state: z.enum(["open", "closed"]),
  title: z.string(),
  body: z.string().nullable(),
  user: userSchema.nullable(),
  labels: z.array(labelSchema),
  assignees: z.array(userSchema),
  milestone: z.optional(milestoneSchema.nullable()),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  closed_at: z.string().nullable(),
  pull_request: z.optional(z.object({ url: z.string() })),
});

type Issue = z.infer<typeof issueSchema>;

type ListIssuesResult = {
  issues: Issue[];
};

// =============================================================================
// Issue Comments
// =============================================================================

const issueCommentSchema = z.object({
  id: z.number(),
  body: z.string(),
  user: userSchema.nullable(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

type IssueComment = z.infer<typeof issueCommentSchema>;

type ListIssueCommentsResult = {
  comments: IssueComment[];
};

// =============================================================================
// Labels
// =============================================================================

type ListLabelsResult = {
  labels: Label[];
};

// =============================================================================
// Milestones
// =============================================================================

type ListMilestonesResult = {
  milestones: Milestone[];
};

// =============================================================================
// GitHub Actions - Workflows
// =============================================================================

const workflowSchema = z.object({
  id: z.number(),
  name: z.string(),
  path: z.string(),
  state: z.enum(["active", "deleted", "disabled_fork", "disabled_inactivity", "disabled_manually"]),
  created_at: z.string(),
  updated_at: z.string(),
  html_url: z.string(),
});

type Workflow = z.infer<typeof workflowSchema>;

type ListWorkflowsResult = {
  totalCount: number;
  workflows: Workflow[];
};

// =============================================================================
// GitHub Actions - Workflow Runs
// =============================================================================

const workflowRunSchema = z.object({
  id: z.number(),
  name: z.string().nullable(),
  head_branch: z.string().nullable(),
  head_sha: z.string(),
  run_number: z.number(),
  event: z.string(),
  status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]).nullable(),
  conclusion: z
    .enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"])
    .nullable(),
  workflow_id: z.number(),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  run_started_at: z.optional(z.string().nullable()),
  actor: userSchema.nullable(),
  triggering_actor: z.optional(userSchema.nullable()),
});

type WorkflowRun = z.infer<typeof workflowRunSchema>;

type ListWorkflowRunsResult = {
  totalCount: number;
  workflowRuns: WorkflowRun[];
};

// =============================================================================
// GitHub Actions - Workflow Run Jobs
// =============================================================================

const workflowStepSchema = z.object({
  name: z.string(),
  status: z.enum(["queued", "in_progress", "completed"]),
  conclusion: z.enum(["success", "failure", "cancelled", "skipped"]).nullable(),
  number: z.number(),
  started_at: z.optional(z.string().nullable()),
  completed_at: z.optional(z.string().nullable()),
});

const workflowJobSchema = z.object({
  id: z.number(),
  run_id: z.number(),
  name: z.string(),
  status: z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]),
  conclusion: z
    .enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required"])
    .nullable(),
  started_at: z.string().nullable(),
  completed_at: z.string().nullable(),
  html_url: z.string().nullable(),
  steps: z.optional(z.array(workflowStepSchema)),
  runner_name: z.optional(z.string().nullable()),
});

type WorkflowJob = z.infer<typeof workflowJobSchema>;

type ListWorkflowRunJobsResult = {
  totalCount: number;
  jobs: WorkflowJob[];
};

// =============================================================================
// GitHub Actions - Workflow Run Logs
// =============================================================================

type GetWorkflowRunLogsResult = {
  /** URL to download the logs archive (ZIP file) */
  downloadUrl: string;
};

type GetJobLogsResult = {
  /** Raw log content as plain text */
  logs: string;
};

// =============================================================================
// Releases
// =============================================================================

const releaseAssetSchema = z.object({
  id: z.number(),
  name: z.string(),
  label: z.string().nullable(),
  state: z.enum(["uploaded", "open"]),
  content_type: z.string(),
  size: z.number(),
  download_count: z.number(),
  browser_download_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
});

const releaseSchema = z.object({
  id: z.number(),
  tag_name: z.string(),
  target_commitish: z.string(),
  name: z.string().nullable(),
  body: z.string().nullable(),
  draft: z.boolean(),
  prerelease: z.boolean(),
  created_at: z.string(),
  published_at: z.string().nullable(),
  author: userSchema.nullable(),
  html_url: z.string(),
  assets: z.array(releaseAssetSchema),
});

type Release = z.infer<typeof releaseSchema>;

type ListReleasesResult = {
  releases: Release[];
};

// =============================================================================
// Search
// =============================================================================

const searchCodeResultSchema = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(
    z.object({
      name: z.string(),
      path: z.string(),
      sha: z.string(),
      url: z.string(),
      git_url: z.string(),
      html_url: z.string(),
      repository: z.object({
        id: z.number(),
        name: z.string(),
        full_name: z.string(),
        owner: userSchema,
        html_url: z.string(),
      }),
      score: z.number(),
    }),
  ),
});

type SearchCodeResult = z.infer<typeof searchCodeResultSchema>;

const searchIssuesResultSchema = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(
    z.object({
      id: z.number(),
      number: z.number(),
      title: z.string(),
      body: z.string().nullable(),
      state: z.enum(["open", "closed"]),
      user: userSchema.nullable(),
      labels: z.array(labelSchema),
      assignees: z.array(userSchema),
      html_url: z.string(),
      created_at: z.string(),
      updated_at: z.string(),
      closed_at: z.string().nullable(),
      pull_request: z.optional(z.object({ url: z.string() })),
      score: z.number(),
      repository_url: z.string(),
    }),
  ),
});

type SearchIssuesResult = z.infer<typeof searchIssuesResultSchema>;

const searchRepositoriesResultSchema = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(repositorySchema),
});

type SearchRepositoriesResult = z.infer<typeof searchRepositoriesResultSchema>;

const searchCommitsResultSchema = z.object({
  total_count: z.number(),
  incomplete_results: z.boolean(),
  items: z.array(
    z.object({
      sha: z.string(),
      commit: z.object({
        author: commitAuthorSchema.nullable(),
        committer: commitAuthorSchema.nullable(),
        message: z.string(),
        url: z.string(),
      }),
      url: z.string(),
      html_url: z.string(),
      author: userSchema.nullable(),
      committer: userSchema.nullable(),
      repository: z.object({
        id: z.number(),
        name: z.string(),
        full_name: z.string(),
        owner: userSchema,
        html_url: z.string(),
      }),
      score: z.number(),
    }),
  ),
});

type SearchCommitsResult = z.infer<typeof searchCommitsResultSchema>;

// =============================================================================
// Users
// =============================================================================

const userDetailSchema = userSchema.extend({
  name: z.string().nullable(),
  company: z.string().nullable(),
  blog: z.string().nullable(),
  location: z.string().nullable(),
  email: z.string().nullable(),
  bio: z.string().nullable(),
  public_repos: z.number(),
  public_gists: z.number(),
  followers: z.number(),
  following: z.number(),
  created_at: z.string(),
  updated_at: z.string(),
});

type UserDetail = z.infer<typeof userDetailSchema>;

// =============================================================================
// Gists
// =============================================================================

const gistFileSchema = z.object({
  filename: z.string(),
  type: z.string(),
  language: z.string().nullable(),
  raw_url: z.string(),
  size: z.number(),
  content: z.optional(z.string()),
});

const gistSchema = z.object({
  id: z.string(),
  description: z.string().nullable(),
  public: z.boolean(),
  owner: userSchema.nullable(),
  files: z.record(z.string(), gistFileSchema),
  html_url: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
  comments: z.number(),
});

type Gist = z.infer<typeof gistSchema>;

type ListGistsResult = {
  gists: Gist[];
};

export const getRepository = action(
  z.object({
    owner: z.string().describe("Repository owner (user or organization)"),
    repo: z.string().describe("Repository name"),
  }),
  async (args): Promise<Repository> => {
    const result = await githubRequest<unknown>("GET", `/repos/${args.owner}/${args.repo}`);
    const parsed = repositorySchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const listRepositories = action(
  z.object({
    org: z.optional(z.string()).describe("Organization name (if listing org repos)"),
    username: z.optional(z.string()).describe("User name (if listing user repos, defaults to authenticated user)"),
    type: z.optional(z.enum(["all", "owner", "public", "private", "member"])).describe("Type of repositories to list"),
    sort: z.optional(z.enum(["created", "updated", "pushed", "full_name"])).describe("Sort by"),
    direction: z.optional(z.enum(["asc", "desc"])).describe("Sort direction"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListRepositoriesResult> => {
    const params = new URLSearchParams();
    if (args.type) params.append("type", args.type);
    if (args.sort) params.append("sort", args.sort);
    if (args.direction) params.append("direction", args.direction);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    let basePath: string;
    if (args.org) {
      basePath = `/orgs/${args.org}/repos`;
    } else if (args.username) {
      basePath = `/users/${args.username}/repos`;
    } else {
      basePath = "/user/repos";
    }
    const path = `${basePath}${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(repositorySchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { repositories: parsed.data };
  },
);
export const createRepository = action(
  z.object({
    name: z.string().describe("Repository name"),
    description: z.optional(z.string()).describe("Repository description"),
    private: z.optional(z.boolean()).describe("Whether the repository is private"),
    org: z.optional(z.string()).describe("Organization name (if creating in an org)"),
    autoInit: z.optional(z.boolean()).describe("Initialize with README"),
    licenseTemplate: z.optional(z.string()).describe('License template (e.g., "mit", "apache-2.0")'),
    gitignoreTemplate: z.optional(z.string()).describe('Gitignore template (e.g., "Node", "Python")'),
  }),
  async (args): Promise<Repository> => {
    await requireApproval({
      action: "github:createRepository",
      data: { name: args.name, org: args.org },
      info: { description: args.description, private: args.private },
      description: `Create repository ${args.org ? `${args.org}/` : ""}${args.name}`,
    });

    const path = args.org ? `/orgs/${args.org}/repos` : "/user/repos";
    const result = await githubRequest<unknown>("POST", path, {
      name: args.name,
      description: args.description,
      private: args.private,
      auto_init: args.autoInit,
      license_template: args.licenseTemplate,
      gitignore_template: args.gitignoreTemplate,
    });

    const parsed = repositorySchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const updateRepository = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    name: z.optional(z.string()).describe("New name for the repository"),
    description: z.optional(z.string()).describe("New description"),
    private: z.optional(z.boolean()).describe("Whether the repository is private"),
    defaultBranch: z.optional(z.string()).describe("Default branch"),
    allowSquashMerge: z.optional(z.boolean()).describe("Whether to allow squash merging"),
    allowMergeCommit: z.optional(z.boolean()).describe("Whether to allow merge commits"),
    allowRebaseMerge: z.optional(z.boolean()).describe("Whether to allow rebase merging"),
    deleteBranchOnMerge: z.optional(z.boolean()).describe("Whether to delete head branches on merge"),
    archived: z.optional(z.boolean()).describe("Whether the repository is archived"),
  }),
  async (args): Promise<Repository> => {
    await requireApproval({
      action: "github:updateRepository",
      data: { repo: `${args.owner}/${args.repo}` },
      info: args,
      description: `Update repository ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>("PATCH", `/repos/${args.owner}/${args.repo}`, {
      name: args.name,
      description: args.description,
      private: args.private,
      default_branch: args.defaultBranch,
      allow_squash_merge: args.allowSquashMerge,
      allow_merge_commit: args.allowMergeCommit,
      allow_rebase_merge: args.allowRebaseMerge,
      delete_branch_on_merge: args.deleteBranchOnMerge,
      archived: args.archived,
    });

    const parsed = repositorySchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const deleteRepository = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:deleteRepository",
      data: { repo: `${args.owner}/${args.repo}` },
      info: {},
      description: `Delete repository ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>("DELETE", `/repos/${args.owner}/${args.repo}`);
    return null;
  },
);
export const forkRepository = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    organization: z.optional(z.string()).describe("Organization to fork to (optional, defaults to authenticated user)"),
    name: z.optional(z.string()).describe("Name for the forked repository"),
    defaultBranchOnly: z.optional(z.boolean()).describe("Whether to fork only the default branch"),
  }),
  async (args): Promise<Repository> => {
    await requireApproval({
      action: "github:forkRepository",
      data: { repo: `${args.owner}/${args.repo}`, organization: args.organization },
      info: { name: args.name },
      description: `Fork repository ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>("POST", `/repos/${args.owner}/${args.repo}/forks`, {
      organization: args.organization,
      name: args.name,
      default_branch_only: args.defaultBranchOnly,
    });

    const parsed = repositorySchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const listBranches = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    protected: z.optional(z.boolean()).describe("Filter by protected status"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListBranchesResult> => {
    const params = new URLSearchParams();
    if (args.protected !== undefined) params.append("protected", args.protected.toString());
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/branches${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(branchSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { branches: parsed.data };
  },
);
export const getBranch = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    branch: z.string().describe("Branch name"),
  }),
  async (args): Promise<BranchDetail> => {
    const result = await githubRequest<unknown>(
      "GET",
      `/repos/${args.owner}/${args.repo}/branches/${encodeURIComponent(args.branch)}`,
    );
    const parsed = branchDetailSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const createBranch = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    branch: z.string().describe("New branch name"),
    sha: z.string().describe("SHA of the commit to branch from"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:createBranch",
      data: { repo: `${args.owner}/${args.repo}`, branch: args.branch },
      info: { sha: args.sha },
      description: `Create branch ${args.branch} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>("POST", `/repos/${args.owner}/${args.repo}/git/refs`, {
      ref: `refs/heads/${args.branch}`,
      sha: args.sha,
    });
    return null;
  },
);
export const deleteBranch = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    branch: z.string().describe("Branch name"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:deleteBranch",
      data: { repo: `${args.owner}/${args.repo}`, branch: args.branch },
      info: {},
      description: `Delete branch ${args.branch} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>(
      "DELETE",
      `/repos/${args.owner}/${args.repo}/git/refs/heads/${encodeURIComponent(args.branch)}`,
    );
    return null;
  },
);
export const listCommits = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    sha: z.optional(z.string()).describe("SHA or branch to start listing commits from"),
    path: z.optional(z.string()).describe("Only commits containing this file path"),
    author: z.optional(z.string()).describe("Only commits by this author (GitHub username or email)"),
    committer: z.optional(z.string()).describe("Only commits by this committer"),
    since: z.optional(z.string()).describe("Only commits after this date (ISO 8601)"),
    until: z.optional(z.string()).describe("Only commits before this date (ISO 8601)"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListCommitsResult> => {
    const params = new URLSearchParams();
    if (args.sha) params.append("sha", args.sha);
    if (args.path) params.append("path", args.path);
    if (args.author) params.append("author", args.author);
    if (args.committer) params.append("committer", args.committer);
    if (args.since) params.append("since", args.since);
    if (args.until) params.append("until", args.until);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/commits${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(commitSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { commits: parsed.data };
  },
);
export const getCommit = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    ref: z.string().describe("Commit SHA"),
  }),
  async (args): Promise<Commit> => {
    const result = await githubRequest<unknown>("GET", `/repos/${args.owner}/${args.repo}/commits/${args.ref}`);
    const parsed = commitSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const compareCommits = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    base: z.string().describe("Base commit SHA or branch"),
    head: z.string().describe("Head commit SHA or branch"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<CompareCommitsResult> => {
    const params = new URLSearchParams();
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/compare/${encodeURIComponent(args.base)}...${encodeURIComponent(args.head)}${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown>("GET", path);
    const parsed = compareCommitsResultSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const getContent = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    path: z.string().describe("Path to file or directory"),
    ref: z.optional(z.string()).describe("Branch, tag, or commit SHA (defaults to default branch)"),
  }),
  async (args): Promise<GetContentResult> => {
    const params = new URLSearchParams();
    if (args.ref) params.append("ref", args.ref);

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/contents/${args.path}${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown>("GET", path);

    // Check if it's an array (directory) or object (file)
    if (Array.isArray(result)) {
      const parsed = z.array(contentDirEntrySchema).safeParse(result);
      if (parsed.success === false) {
        throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
      }
      return { type: "directory", entries: parsed.data };
    }
    const parsed = contentFileSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { type: "file", file: parsed.data };
  },
);
export const getFileContentRaw = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    path: z.string().describe("Path to file"),
    ref: z.optional(z.string()).describe("Branch, tag, or commit SHA (defaults to default branch)"),
  }),
  async (args): Promise<string> => {
    const params = new URLSearchParams();
    if (args.ref) params.append("ref", args.ref);

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/contents/${args.path}${queryString ? `?${queryString}` : ""}`;

    return await githubRequestRaw("GET", path);
  },
);
export const createOrUpdateFile = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    path: z.string().describe("Path to file"),
    message: z.string().describe("Commit message"),
    content: z.string().describe("File content (will be base64 encoded)"),
    sha: z.optional(z.string()).describe("SHA of the file being replaced (required for updates)"),
    branch: z.optional(z.string()).describe("Branch name (defaults to default branch)"),
    authorName: z.optional(z.string()).describe("Author name"),
    authorEmail: z.optional(z.string()).describe("Author email"),
  }),
  async (args): Promise<FileCommitResult> => {
    const isUpdate = !!args.sha;
    await requireApproval({
      action: isUpdate ? "github:updateFile" : "github:createFile",
      data: { repo: `${args.owner}/${args.repo}`, path: args.path },
      info: { message: args.message, branch: args.branch },
      description: `${isUpdate ? "Update" : "Create"} file ${args.path} in ${args.owner}/${args.repo}`,
    });

    const body: Record<string, unknown> = {
      message: args.message,
      content: Buffer.from(args.content).toString("base64"),
    };
    if (args.sha) body.sha = args.sha;
    if (args.branch) body.branch = args.branch;
    if (args.authorName || args.authorEmail) {
      body.author = { name: args.authorName, email: args.authorEmail };
    }

    const result = await githubRequest<unknown>("PUT", `/repos/${args.owner}/${args.repo}/contents/${args.path}`, body);

    const parsed = fileCommitResultSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const deleteFile = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    path: z.string().describe("Path to file"),
    message: z.string().describe("Commit message"),
    sha: z.string().describe("SHA of the file being deleted"),
    branch: z.optional(z.string()).describe("Branch name (defaults to default branch)"),
  }),
  async (args): Promise<FileCommitResult> => {
    await requireApproval({
      action: "github:deleteFile",
      data: { repo: `${args.owner}/${args.repo}`, path: args.path },
      info: { message: args.message, branch: args.branch },
      description: `Delete file ${args.path} in ${args.owner}/${args.repo}`,
    });

    const body: Record<string, unknown> = {
      message: args.message,
      sha: args.sha,
    };
    if (args.branch) body.branch = args.branch;

    const result = await githubRequest<unknown>(
      "DELETE",
      `/repos/${args.owner}/${args.repo}/contents/${args.path}`,
      body,
    );

    const parsed = fileCommitResultSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const listTags = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListTagsResult> => {
    const params = new URLSearchParams();
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/tags${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(tagSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { tags: parsed.data };
  },
);
export const createTag = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    tag: z.string().describe("Tag name"),
    message: z.string().describe("Tag message"),
    sha: z.string().describe("SHA of the commit to tag"),
    type: z.optional(z.enum(["commit", "tree", "blob"])).describe("Type of object being tagged"),
    taggerName: z.optional(z.string()).describe("Tagger name"),
    taggerEmail: z.optional(z.string()).describe("Tagger email"),
  }),
  async (args): Promise<GitTag> => {
    await requireApproval({
      action: "github:createTag",
      data: { repo: `${args.owner}/${args.repo}`, tag: args.tag },
      info: { message: args.message, sha: args.sha },
      description: `Create tag ${args.tag} in ${args.owner}/${args.repo}`,
    });

    // First create the tag object
    const tagResult = await githubRequest<unknown>("POST", `/repos/${args.owner}/${args.repo}/git/tags`, {
      tag: args.tag,
      message: args.message,
      object: args.sha,
      type: args.type || "commit",
      tagger: args.taggerName && args.taggerEmail ? { name: args.taggerName, email: args.taggerEmail } : undefined,
    });

    const parsed = gitTagSchema.safeParse(tagResult);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }

    // Then create the reference
    await githubRequest<unknown>("POST", `/repos/${args.owner}/${args.repo}/git/refs`, {
      ref: `refs/tags/${args.tag}`,
      sha: parsed.data.sha,
    });

    return parsed.data;
  },
);
export const deleteTag = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    tag: z.string().describe("Tag name"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:deleteTag",
      data: { repo: `${args.owner}/${args.repo}`, tag: args.tag },
      info: {},
      description: `Delete tag ${args.tag} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>(
      "DELETE",
      `/repos/${args.owner}/${args.repo}/git/refs/tags/${encodeURIComponent(args.tag)}`,
    );
    return null;
  },
);
export const listPullRequests = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    state: z.optional(z.enum(["open", "closed", "all"])).describe("Filter by state: open, closed, or all"),
    head: z.optional(z.string()).describe("Filter by head ref (branch name)"),
    base: z.optional(z.string()).describe("Filter by base ref (target branch)"),
    sort: z
      .optional(z.enum(["created", "updated", "popularity", "long-running"]))
      .describe("Sort by: created, updated, popularity, long-running"),
    direction: z.optional(z.enum(["asc", "desc"])).describe("Sort direction"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListPullRequestsResult> => {
    const params = new URLSearchParams();
    if (args.state) params.append("state", args.state);
    if (args.head) params.append("head", args.head);
    if (args.base) params.append("base", args.base);
    if (args.sort) params.append("sort", args.sort);
    if (args.direction) params.append("direction", args.direction);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/pulls${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(pullRequestSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { pullRequests: parsed.data };
  },
);
export const getPullRequest = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
  }),
  async (args): Promise<PullRequest> => {
    const result = await githubRequest<unknown>("GET", `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}`);
    const parsed = pullRequestSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const createPullRequest = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    title: z.string().describe("Pull request title"),
    body: z.optional(z.string()).describe("Pull request body (markdown supported)"),
    head: z.string().describe("Name of the branch where changes are implemented"),
    base: z.string().describe("Name of the branch you want the changes pulled into"),
    draft: z.optional(z.boolean()).describe("Whether the pull request is a draft"),
    maintainerCanModify: z.optional(z.boolean()).describe("Whether maintainers can modify the pull request"),
  }),
  async (args): Promise<PullRequest> => {
    await requireApproval({
      action: "github:createPullRequest",
      data: { repo: `${args.owner}/${args.repo}`, head: args.head, base: args.base },
      info: { title: args.title, body: args.body, draft: args.draft },
      description: `Create pull request in ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>("POST", `/repos/${args.owner}/${args.repo}/pulls`, {
      title: args.title,
      body: args.body,
      head: args.head,
      base: args.base,
      draft: args.draft,
      maintainer_can_modify: args.maintainerCanModify,
    });

    const parsed = pullRequestSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const updatePullRequest = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
    title: z.optional(z.string()).describe("New title"),
    body: z.optional(z.string()).describe("New body"),
    state: z.optional(z.enum(["open", "closed"])).describe("New state"),
    base: z.optional(z.string()).describe("New base branch"),
    maintainerCanModify: z.optional(z.boolean()).describe("Whether maintainers can modify the pull request"),
  }),
  async (args): Promise<PullRequest> => {
    await requireApproval({
      action: "github:updatePullRequest",
      data: { repo: `${args.owner}/${args.repo}`, pullNumber: args.pullNumber },
      info: { title: args.title, body: args.body, state: args.state },
      description: `Update pull request #${args.pullNumber} in ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>("PATCH", `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}`, {
      title: args.title,
      body: args.body,
      state: args.state,
      base: args.base,
      maintainer_can_modify: args.maintainerCanModify,
    });

    const parsed = pullRequestSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const mergePullRequest = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
    commitTitle: z.optional(z.string()).describe("Title for the merge commit"),
    commitMessage: z.optional(z.string()).describe("Message for the merge commit"),
    sha: z.optional(z.string()).describe("SHA that pull request head must match to allow merge"),
    mergeMethod: z.optional(z.enum(["merge", "squash", "rebase"])).describe("Merge method"),
  }),
  async (args): Promise<MergeResult> => {
    await requireApproval({
      action: "github:mergePullRequest",
      data: { repo: `${args.owner}/${args.repo}`, pullNumber: args.pullNumber },
      info: { mergeMethod: args.mergeMethod, commitTitle: args.commitTitle },
      description: `Merge pull request #${args.pullNumber} in ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>(
      "PUT",
      `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/merge`,
      {
        commit_title: args.commitTitle,
        commit_message: args.commitMessage,
        sha: args.sha,
        merge_method: args.mergeMethod,
      },
    );

    const parsed = mergeResultSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const listPullRequestFiles = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListPullRequestFilesResult> => {
    const params = new URLSearchParams();
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/files${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(pullRequestFileSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { files: parsed.data };
  },
);
export const listPullRequestCommits = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListPullRequestCommitsResult> => {
    const params = new URLSearchParams();
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/commits${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(commitSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { commits: parsed.data };
  },
);
export const listPullRequestReviews = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListPullRequestReviewsResult> => {
    const params = new URLSearchParams();
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/reviews${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(reviewSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { reviews: parsed.data };
  },
);
export const createPullRequestReview = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
    body: z.optional(z.string()).describe("Review body"),
    event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]).describe("Review event type"),
    commitId: z.optional(z.string()).describe("Commit SHA to review"),
    comments: z
      .optional(
        z.array(
          z.object({
            path: z.string().describe("Path to the file"),
            line: z.optional(z.number()).describe("Line number in the diff"),
            side: z.optional(z.enum(["LEFT", "RIGHT"])).describe("Side of the diff (LEFT or RIGHT)"),
            body: z.string().describe("Comment body"),
          }),
        ),
      )
      .describe("Comments to include with the review"),
  }),
  async (args): Promise<Review> => {
    await requireApproval({
      action: "github:createPullRequestReview",
      data: { repo: `${args.owner}/${args.repo}`, pullNumber: args.pullNumber, event: args.event },
      info: { body: args.body },
      description: `${args.event} pull request #${args.pullNumber} in ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>(
      "POST",
      `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/reviews`,
      {
        body: args.body,
        event: args.event,
        commit_id: args.commitId,
        comments: args.comments,
      },
    );

    const parsed = reviewSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const dismissPullRequestReview = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
    reviewId: z.number().describe("Review ID"),
    message: z.string().describe("Reason for dismissal"),
  }),
  async (args): Promise<Review> => {
    await requireApproval({
      action: "github:dismissPullRequestReview",
      data: { repo: `${args.owner}/${args.repo}`, pullNumber: args.pullNumber, reviewId: args.reviewId },
      info: { message: args.message },
      description: `Dismiss review on pull request #${args.pullNumber} in ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>(
      "PUT",
      `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/reviews/${args.reviewId}/dismissals`,
      { message: args.message },
    );

    const parsed = reviewSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const requestReviewers = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
    reviewers: z.optional(z.array(z.string())).describe("Usernames of reviewers to request"),
    teamReviewers: z.optional(z.array(z.string())).describe("Team slugs to request review from"),
  }),
  async (args): Promise<PullRequest> => {
    await requireApproval({
      action: "github:requestReviewers",
      data: { repo: `${args.owner}/${args.repo}`, pullNumber: args.pullNumber },
      info: { reviewers: args.reviewers, teamReviewers: args.teamReviewers },
      description: `Request reviewers for pull request #${args.pullNumber} in ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>(
      "POST",
      `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/requested_reviewers`,
      {
        reviewers: args.reviewers,
        team_reviewers: args.teamReviewers,
      },
    );

    const parsed = pullRequestSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const removeReviewers = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    pullNumber: z.number().describe("Pull request number"),
    reviewers: z.optional(z.array(z.string())).describe("Usernames of reviewers to remove"),
    teamReviewers: z.optional(z.array(z.string())).describe("Team slugs to remove"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:removeReviewers",
      data: { repo: `${args.owner}/${args.repo}`, pullNumber: args.pullNumber },
      info: { reviewers: args.reviewers, teamReviewers: args.teamReviewers },
      description: `Remove reviewers from pull request #${args.pullNumber} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>(
      "DELETE",
      `/repos/${args.owner}/${args.repo}/pulls/${args.pullNumber}/requested_reviewers`,
      {
        reviewers: args.reviewers,
        team_reviewers: args.teamReviewers,
      },
    );
    return null;
  },
);
export const listIssues = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    state: z.optional(z.enum(["open", "closed", "all"])).describe("Filter by state: open, closed, or all"),
    labels: z.optional(z.string()).describe("Filter by label names (comma-separated)"),
    assignee: z.optional(z.string()).describe('Filter by assignee username, or "none" for unassigned, "*" for any'),
    creator: z.optional(z.string()).describe("Filter by creator username"),
    sort: z.optional(z.enum(["created", "updated", "comments"])).describe("Sort by: created, updated, comments"),
    direction: z.optional(z.enum(["asc", "desc"])).describe("Sort direction"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListIssuesResult> => {
    const params = new URLSearchParams();
    if (args.state) params.append("state", args.state);
    if (args.labels) params.append("labels", args.labels);
    if (args.assignee) params.append("assignee", args.assignee);
    if (args.creator) params.append("creator", args.creator);
    if (args.sort) params.append("sort", args.sort);
    if (args.direction) params.append("direction", args.direction);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/issues${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(issueSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { issues: parsed.data };
  },
);
export const getIssue = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    issueNumber: z.number().describe("Issue number"),
  }),
  async (args): Promise<Issue> => {
    const result = await githubRequest<unknown>("GET", `/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}`);
    const parsed = issueSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const createIssue = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    title: z.string().describe("Issue title"),
    body: z.optional(z.string()).describe("Issue body (markdown supported)"),
    assignees: z.optional(z.array(z.string())).describe("Assignee usernames"),
    labels: z.optional(z.array(z.string())).describe("Label names"),
  }),
  async (args): Promise<Issue> => {
    await requireApproval({
      action: "github:createIssue",
      data: { repo: `${args.owner}/${args.repo}` },
      info: { title: args.title, body: args.body, assignees: args.assignees, labels: args.labels },
      description: `Create issue in ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>("POST", `/repos/${args.owner}/${args.repo}/issues`, {
      title: args.title,
      body: args.body,
      assignees: args.assignees,
      labels: args.labels,
    });

    const parsed = issueSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const updateIssue = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    issueNumber: z.number().describe("Issue number"),
    title: z.optional(z.string()).describe("New title"),
    body: z.optional(z.string()).describe("New body"),
    state: z.optional(z.enum(["open", "closed"])).describe("New state"),
    stateReason: z
      .optional(z.enum(["completed", "not_planned", "reopened"]))
      .describe("State reason (for closed state)"),
    assignees: z.optional(z.array(z.string())).describe("Assignee usernames"),
    labels: z.optional(z.array(z.string())).describe("Label names"),
    milestone: z.optional(z.union([z.number(), z.literal(null)])).describe("Milestone number"),
  }),
  async (args): Promise<Issue> => {
    await requireApproval({
      action: "github:updateIssue",
      data: { repo: `${args.owner}/${args.repo}`, issueNumber: args.issueNumber },
      info: { title: args.title, body: args.body, state: args.state },
      description: `Update issue #${args.issueNumber} in ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>(
      "PATCH",
      `/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}`,
      {
        title: args.title,
        body: args.body,
        state: args.state,
        state_reason: args.stateReason,
        assignees: args.assignees,
        labels: args.labels,
        milestone: args.milestone,
      },
    );

    const parsed = issueSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const lockIssue = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    issueNumber: z.number().describe("Issue number"),
    lockReason: z.optional(z.enum(["off-topic", "too heated", "resolved", "spam"])).describe("Lock reason"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:lockIssue",
      data: { repo: `${args.owner}/${args.repo}`, issueNumber: args.issueNumber },
      info: { lockReason: args.lockReason },
      description: `Lock issue #${args.issueNumber} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>(
      "PUT",
      `/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/lock`,
      args.lockReason ? { lock_reason: args.lockReason } : {},
    );
    return null;
  },
);
export const unlockIssue = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    issueNumber: z.number().describe("Issue number"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:unlockIssue",
      data: { repo: `${args.owner}/${args.repo}`, issueNumber: args.issueNumber },
      info: {},
      description: `Unlock issue #${args.issueNumber} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>("DELETE", `/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/lock`);
    return null;
  },
);
export const listIssueComments = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    issueNumber: z.number().describe("Issue number"),
    since: z.optional(z.string()).describe("Only comments updated after this date (ISO 8601)"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListIssueCommentsResult> => {
    const params = new URLSearchParams();
    if (args.since) params.append("since", args.since);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/comments${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(issueCommentSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { comments: parsed.data };
  },
);

/** @REQUIRES_APPROVAL except for the tokenspace-ai/testing repository */
export const createIssueComment = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    issueNumber: z.number().describe("Issue number"),
    body: z.string().describe("Comment body (markdown supported)"),
  }),
  async (args): Promise<IssueComment> => {
    if (!(args.owner === "tokenspace-ai" && args.repo === "testing")) {
      await requireApproval({
        action: "github:createIssueComment",
        data: { repo: `${args.owner}/${args.repo}`, issueNumber: args.issueNumber },
        info: { body: args.body },
        description: `Comment on issue #${args.issueNumber} in ${args.owner}/${args.repo}`,
      });
    }

    const result = await githubRequest<unknown>(
      "POST",
      `/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/comments`,
      { body: args.body },
    );

    const parsed = issueCommentSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const updateIssueComment = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    commentId: z.number().describe("Comment ID"),
    body: z.string().describe("New comment body"),
  }),
  async (args): Promise<IssueComment> => {
    await requireApproval({
      action: "github:updateIssueComment",
      data: { repo: `${args.owner}/${args.repo}`, commentId: args.commentId },
      info: { body: args.body },
      description: `Update comment in ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>(
      "PATCH",
      `/repos/${args.owner}/${args.repo}/issues/comments/${args.commentId}`,
      { body: args.body },
    );

    const parsed = issueCommentSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const deleteIssueComment = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    commentId: z.number().describe("Comment ID"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:deleteIssueComment",
      data: { repo: `${args.owner}/${args.repo}`, commentId: args.commentId },
      info: {},
      description: `Delete comment in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>("DELETE", `/repos/${args.owner}/${args.repo}/issues/comments/${args.commentId}`);
    return null;
  },
);
export const listLabels = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListLabelsResult> => {
    const params = new URLSearchParams();
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/labels${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(labelSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { labels: parsed.data };
  },
);
export const getLabel = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    name: z.string().describe("Label name"),
  }),
  async (args): Promise<Label> => {
    const result = await githubRequest<unknown>(
      "GET",
      `/repos/${args.owner}/${args.repo}/labels/${encodeURIComponent(args.name)}`,
    );
    const parsed = labelSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const createLabel = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    name: z.string().describe("Label name"),
    color: z.string().describe("Label color (hex without #)"),
    description: z.optional(z.string()).describe("Label description"),
  }),
  async (args): Promise<Label> => {
    const result = await githubRequest<unknown>("POST", `/repos/${args.owner}/${args.repo}/labels`, {
      name: args.name,
      color: args.color,
      description: args.description,
    });

    const parsed = labelSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const updateLabel = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    name: z.string().describe("Current label name"),
    newName: z.optional(z.string()).describe("New label name"),
    color: z.optional(z.string()).describe("New color (hex without #)"),
    description: z.optional(z.string()).describe("New description"),
  }),
  async (args): Promise<Label> => {
    const result = await githubRequest<unknown>(
      "PATCH",
      `/repos/${args.owner}/${args.repo}/labels/${encodeURIComponent(args.name)}`,
      {
        new_name: args.newName,
        color: args.color,
        description: args.description,
      },
    );

    const parsed = labelSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const deleteLabel = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    name: z.string().describe("Label name"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:deleteLabel",
      data: { repo: `${args.owner}/${args.repo}`, name: args.name },
      info: {},
      description: `Delete label "${args.name}" in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>("DELETE", `/repos/${args.owner}/${args.repo}/labels/${encodeURIComponent(args.name)}`);
    return null;
  },
);
export const addLabelsToIssue = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    issueNumber: z.number().describe("Issue number"),
    labels: z.array(z.string()).describe("Label names to add"),
  }),
  async (args): Promise<Label[]> => {
    const result = await githubRequest<unknown[]>(
      "POST",
      `/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/labels`,
      { labels: args.labels },
    );

    const parsed = z.array(labelSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const removeLabelFromIssue = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    issueNumber: z.number().describe("Issue number"),
    name: z.string().describe("Label name to remove"),
  }),
  async (args): Promise<null> => {
    await githubRequest<unknown>(
      "DELETE",
      `/repos/${args.owner}/${args.repo}/issues/${args.issueNumber}/labels/${encodeURIComponent(args.name)}`,
    );
    return null;
  },
);
export const listMilestones = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    state: z.optional(z.enum(["open", "closed", "all"])).describe("Filter by state"),
    sort: z.optional(z.enum(["due_on", "completeness"])).describe("Sort by"),
    direction: z.optional(z.enum(["asc", "desc"])).describe("Sort direction"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListMilestonesResult> => {
    const params = new URLSearchParams();
    if (args.state) params.append("state", args.state);
    if (args.sort) params.append("sort", args.sort);
    if (args.direction) params.append("direction", args.direction);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/milestones${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(milestoneSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { milestones: parsed.data };
  },
);
export const getMilestone = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    milestoneNumber: z.number().describe("Milestone number"),
  }),
  async (args): Promise<Milestone> => {
    const result = await githubRequest<unknown>(
      "GET",
      `/repos/${args.owner}/${args.repo}/milestones/${args.milestoneNumber}`,
    );
    const parsed = milestoneSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const listWorkflows = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListWorkflowsResult> => {
    const params = new URLSearchParams();
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/actions/workflows${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<{ total_count: number; workflows: unknown[] }>("GET", path);
    const parsed = z.array(workflowSchema).safeParse(result.workflows);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { totalCount: result.total_count, workflows: parsed.data };
  },
);
export const getWorkflow = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    workflowId: z.union([z.number(), z.string()]).describe('Workflow ID or workflow file name (e.g., "ci.yml")'),
  }),
  async (args): Promise<Workflow> => {
    const result = await githubRequest<unknown>(
      "GET",
      `/repos/${args.owner}/${args.repo}/actions/workflows/${args.workflowId}`,
    );
    const parsed = workflowSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const triggerWorkflow = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    workflowId: z.union([z.number(), z.string()]).describe('Workflow ID or workflow file name (e.g., "ci.yml")'),
    ref: z.string().describe("Git reference (branch or tag) to run the workflow on"),
    inputs: z.optional(z.record(z.string(), z.string())).describe("Input parameters for the workflow"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:triggerWorkflow",
      data: { repo: `${args.owner}/${args.repo}`, workflowId: args.workflowId, ref: args.ref },
      info: { inputs: args.inputs },
      description: `Trigger workflow ${args.workflowId} in ${args.owner}/${args.repo}`,
    });
    await githubRequest<unknown>(
      "POST",
      `/repos/${args.owner}/${args.repo}/actions/workflows/${args.workflowId}/dispatches`,
      {
        ref: args.ref,
        inputs: args.inputs,
      },
    );
    return null;
  },
);
export const enableWorkflow = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    workflowId: z.union([z.number(), z.string()]).describe("Workflow ID or workflow file name"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:enableWorkflow",
      data: { repo: `${args.owner}/${args.repo}`, workflowId: args.workflowId },
      info: {},
      description: `Enable workflow ${args.workflowId} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>(
      "PUT",
      `/repos/${args.owner}/${args.repo}/actions/workflows/${args.workflowId}/enable`,
    );
    return null;
  },
);
export const disableWorkflow = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    workflowId: z.union([z.number(), z.string()]).describe("Workflow ID or workflow file name"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:disableWorkflow",
      data: { repo: `${args.owner}/${args.repo}`, workflowId: args.workflowId },
      info: {},
      description: `Disable workflow ${args.workflowId} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>(
      "PUT",
      `/repos/${args.owner}/${args.repo}/actions/workflows/${args.workflowId}/disable`,
    );
    return null;
  },
);
export const listWorkflowRuns = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    workflowId: z
      .optional(z.union([z.number(), z.string()]))
      .describe('Filter by workflow ID or workflow file name (e.g., "ci.yml")'),
    actor: z.optional(z.string()).describe("Filter by actor username"),
    branch: z.optional(z.string()).describe("Filter by branch"),
    event: z.optional(z.string()).describe('Filter by event type (e.g., "push", "pull_request")'),
    status: z
      .optional(z.enum(["queued", "in_progress", "completed", "waiting", "requested", "pending"]))
      .describe("Filter by status"),
    conclusion: z
      .optional(
        z.enum(["success", "failure", "neutral", "cancelled", "skipped", "timed_out", "action_required", "stale"]),
      )
      .describe("Filter by conclusion"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListWorkflowRunsResult> => {
    const params = new URLSearchParams();
    if (args.actor) params.append("actor", args.actor);
    if (args.branch) params.append("branch", args.branch);
    if (args.event) params.append("event", args.event);
    if (args.status) params.append("status", args.status);
    if (args.conclusion) params.append("conclusion", args.conclusion);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const basePath = args.workflowId
      ? `/repos/${args.owner}/${args.repo}/actions/workflows/${args.workflowId}/runs`
      : `/repos/${args.owner}/${args.repo}/actions/runs`;
    const path = `${basePath}${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<{ total_count: number; workflow_runs: unknown[] }>("GET", path);
    const parsed = z.array(workflowRunSchema).safeParse(result.workflow_runs);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { totalCount: result.total_count, workflowRuns: parsed.data };
  },
);
export const getWorkflowRun = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    runId: z.number().describe("Workflow run ID"),
  }),
  async (args): Promise<WorkflowRun> => {
    const result = await githubRequest<unknown>("GET", `/repos/${args.owner}/${args.repo}/actions/runs/${args.runId}`);
    const parsed = workflowRunSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const cancelWorkflowRun = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    runId: z.number().describe("Workflow run ID"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:cancelWorkflowRun",
      data: { repo: `${args.owner}/${args.repo}`, runId: args.runId },
      info: {},
      description: `Cancel workflow run #${args.runId} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>("POST", `/repos/${args.owner}/${args.repo}/actions/runs/${args.runId}/cancel`);
    return null;
  },
);
export const rerunWorkflow = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    runId: z.number().describe("Workflow run ID"),
    enableDebugLogging: z.optional(z.boolean()).describe("Whether to enable debug logging"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:rerunWorkflow",
      data: { repo: `${args.owner}/${args.repo}`, runId: args.runId },
      info: { enableDebugLogging: args.enableDebugLogging },
      description: `Re-run workflow #${args.runId} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>(
      "POST",
      `/repos/${args.owner}/${args.repo}/actions/runs/${args.runId}/rerun`,
      args.enableDebugLogging ? { enable_debug_logging: true } : {},
    );
    return null;
  },
);
export const rerunFailedJobs = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    runId: z.number().describe("Workflow run ID"),
    enableDebugLogging: z.optional(z.boolean()).describe("Whether to enable debug logging"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:rerunFailedJobs",
      data: { repo: `${args.owner}/${args.repo}`, runId: args.runId },
      info: { enableDebugLogging: args.enableDebugLogging },
      description: `Re-run failed jobs in workflow #${args.runId} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>(
      "POST",
      `/repos/${args.owner}/${args.repo}/actions/runs/${args.runId}/rerun-failed-jobs`,
      args.enableDebugLogging ? { enable_debug_logging: true } : {},
    );
    return null;
  },
);
export const deleteWorkflowRun = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    runId: z.number().describe("Workflow run ID"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:deleteWorkflowRun",
      data: { repo: `${args.owner}/${args.repo}`, runId: args.runId },
      info: {},
      description: `Delete workflow run #${args.runId} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>("DELETE", `/repos/${args.owner}/${args.repo}/actions/runs/${args.runId}`);
    return null;
  },
);
export const deleteWorkflowRunLogs = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    runId: z.number().describe("Workflow run ID"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:deleteWorkflowRunLogs",
      data: { repo: `${args.owner}/${args.repo}`, runId: args.runId },
      info: {},
      description: `Delete logs for workflow run #${args.runId} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>("DELETE", `/repos/${args.owner}/${args.repo}/actions/runs/${args.runId}/logs`);
    return null;
  },
);
export const listWorkflowRunJobs = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    runId: z.number().describe("Workflow run ID"),
    filter: z.optional(z.enum(["latest", "all"])).describe("Filter jobs by status"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListWorkflowRunJobsResult> => {
    const params = new URLSearchParams();
    if (args.filter) params.append("filter", args.filter);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/actions/runs/${args.runId}/jobs${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<{ total_count: number; jobs: unknown[] }>("GET", path);
    const parsed = z.array(workflowJobSchema).safeParse(result.jobs);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { totalCount: result.total_count, jobs: parsed.data };
  },
);
export const getWorkflowRunLogsUrl = action(
  z.object({
    owner: z.string(),
    repo: z.string(),
    runId: z.number(),
  }),
  async (args): Promise<GetWorkflowRunLogsResult> => {
    const url = `${baseUrl}/repos/${args.owner}/${args.repo}/actions/runs/${args.runId}/logs`;

    // GitHub returns a 302 redirect to the download URL
    const response = await request({
      url,
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      auth: {
        type: "bearer",
        token: await getCredential(githubToken),
      },
      redirect: "manual",
      checkResponseStatus: false,
    });

    if (response.status === 302) {
      const downloadUrl = response.headers.get("location");
      if (downloadUrl) {
        return { downloadUrl };
      }
    }

    if (!response.ok) {
      const errorBody = await parseResponseBody(response).catch(() => null);
      throw new GitHubApiError(
        `Failed to get workflow run logs: ${response.statusText}`,
        response,
        typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody),
      );
    }

    throw new GitHubApiError("Unexpected response when fetching workflow run logs URL", response);
  },
);
export const getJobLogs = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    jobId: z.number().describe("Job ID"),
  }),
  async (args): Promise<GetJobLogsResult> => {
    const url = `${baseUrl}/repos/${args.owner}/${args.repo}/actions/jobs/${args.jobId}/logs`;

    // First request to get the redirect URL
    const response = await request({
      url,
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      auth: {
        type: "bearer",
        token: await getCredential(githubToken),
      },
      redirect: "manual",
      checkResponseStatus: false,
    });

    if (response.status === 302) {
      const downloadUrl = response.headers.get("location");
      if (downloadUrl) {
        // Fetch the actual logs from the redirect URL
        const logsResponse = await request({
          url: downloadUrl,
          method: "GET",
          checkResponseStatus: true,
        });
        const logs = await logsResponse.text();
        return { logs };
      }
    }

    if (!response.ok) {
      const errorBody = await parseResponseBody(response).catch(() => null);
      throw new GitHubApiError(
        `Failed to get job logs: ${response.statusText}`,
        response,
        typeof errorBody === "string" ? errorBody : JSON.stringify(errorBody),
      );
    }

    // If no redirect, try to get the content directly
    const logs = await response.text();
    return { logs };
  },
);
export const listReleases = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListReleasesResult> => {
    const params = new URLSearchParams();
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const path = `/repos/${args.owner}/${args.repo}/releases${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(releaseSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { releases: parsed.data };
  },
);
export const getRelease = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    releaseId: z.number().describe("Release ID"),
  }),
  async (args): Promise<Release> => {
    const result = await githubRequest<unknown>("GET", `/repos/${args.owner}/${args.repo}/releases/${args.releaseId}`);
    const parsed = releaseSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const getLatestRelease = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
  }),
  async (args): Promise<Release> => {
    const result = await githubRequest<unknown>("GET", `/repos/${args.owner}/${args.repo}/releases/latest`);
    const parsed = releaseSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const getReleaseByTag = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    tag: z.string().describe("Tag name"),
  }),
  async (args): Promise<Release> => {
    const result = await githubRequest<unknown>(
      "GET",
      `/repos/${args.owner}/${args.repo}/releases/tags/${encodeURIComponent(args.tag)}`,
    );
    const parsed = releaseSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const createRelease = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    tagName: z.string().describe("Tag name for the release"),
    targetCommitish: z.optional(z.string()).describe("Target commitish (branch or commit SHA)"),
    name: z.optional(z.string()).describe("Release name"),
    body: z.optional(z.string()).describe("Release body (markdown supported)"),
    draft: z.optional(z.boolean()).describe("Whether this is a draft release"),
    prerelease: z.optional(z.boolean()).describe("Whether this is a prerelease"),
    generateReleaseNotes: z.optional(z.boolean()).describe("Whether to auto-generate release notes"),
  }),
  async (args): Promise<Release> => {
    await requireApproval({
      action: "github:createRelease",
      data: { repo: `${args.owner}/${args.repo}`, tagName: args.tagName },
      info: { name: args.name, body: args.body, draft: args.draft, prerelease: args.prerelease },
      description: `Create release ${args.tagName} in ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>("POST", `/repos/${args.owner}/${args.repo}/releases`, {
      tag_name: args.tagName,
      target_commitish: args.targetCommitish,
      name: args.name,
      body: args.body,
      draft: args.draft,
      prerelease: args.prerelease,
      generate_release_notes: args.generateReleaseNotes,
    });

    const parsed = releaseSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const updateRelease = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    releaseId: z.number().describe("Release ID"),
    tagName: z.optional(z.string()).describe("New tag name"),
    targetCommitish: z.optional(z.string()).describe("New target commitish"),
    name: z.optional(z.string()).describe("New name"),
    body: z.optional(z.string()).describe("New body"),
    draft: z.optional(z.boolean()).describe("Whether this is a draft"),
    prerelease: z.optional(z.boolean()).describe("Whether this is a prerelease"),
  }),
  async (args): Promise<Release> => {
    await requireApproval({
      action: "github:updateRelease",
      data: { repo: `${args.owner}/${args.repo}`, releaseId: args.releaseId },
      info: { tagName: args.tagName, name: args.name, draft: args.draft, prerelease: args.prerelease },
      description: `Update release #${args.releaseId} in ${args.owner}/${args.repo}`,
    });

    const result = await githubRequest<unknown>(
      "PATCH",
      `/repos/${args.owner}/${args.repo}/releases/${args.releaseId}`,
      {
        tag_name: args.tagName,
        target_commitish: args.targetCommitish,
        name: args.name,
        body: args.body,
        draft: args.draft,
        prerelease: args.prerelease,
      },
    );

    const parsed = releaseSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const deleteRelease = action(
  z.object({
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    releaseId: z.number().describe("Release ID"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:deleteRelease",
      data: { repo: `${args.owner}/${args.repo}`, releaseId: args.releaseId },
      info: {},
      description: `Delete release #${args.releaseId} in ${args.owner}/${args.repo}`,
    });

    await githubRequest<unknown>("DELETE", `/repos/${args.owner}/${args.repo}/releases/${args.releaseId}`);
    return null;
  },
);
export const searchCode = action(
  z.object({
    query: z.string().describe("Search query (see GitHub search syntax)"),
    sort: z.optional(z.literal("indexed")).describe("Sort by (default: best match)"),
    order: z.optional(z.enum(["asc", "desc"])).describe("Sort order"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<SearchCodeResult> => {
    const params = new URLSearchParams();
    params.append("q", args.query);
    if (args.sort) params.append("sort", args.sort);
    if (args.order) params.append("order", args.order);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const path = `/search/code?${params.toString()}`;

    const result = await githubRequest<unknown>("GET", path);
    const parsed = searchCodeResultSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const searchIssues = action(
  z.object({
    query: z.string().describe("Search query (see GitHub search syntax)"),
    sort: z
      .optional(
        z.enum([
          "comments",
          "reactions",
          "reactions-+1",
          "reactions--1",
          "reactions-smile",
          "reactions-thinking_face",
          "reactions-heart",
          "reactions-tada",
          "interactions",
          "created",
          "updated",
        ]),
      )
      .describe("Sort by"),
    order: z.optional(z.enum(["asc", "desc"])).describe("Sort order"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<SearchIssuesResult> => {
    const params = new URLSearchParams();
    params.append("q", args.query);
    if (args.sort) params.append("sort", args.sort);
    if (args.order) params.append("order", args.order);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const path = `/search/issues?${params.toString()}`;

    const result = await githubRequest<unknown>("GET", path);
    const parsed = searchIssuesResultSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const searchRepositories = action(
  z.object({
    query: z.string().describe("Search query (see GitHub search syntax)"),
    sort: z.optional(z.enum(["stars", "forks", "help-wanted-issues", "updated"])).describe("Sort by"),
    order: z.optional(z.enum(["asc", "desc"])).describe("Sort order"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<SearchRepositoriesResult> => {
    const params = new URLSearchParams();
    params.append("q", args.query);
    if (args.sort) params.append("sort", args.sort);
    if (args.order) params.append("order", args.order);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const path = `/search/repositories?${params.toString()}`;

    const result = await githubRequest<unknown>("GET", path);
    const parsed = searchRepositoriesResultSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const searchCommits = action(
  z.object({
    query: z.string().describe("Search query (see GitHub search syntax)"),
    sort: z.optional(z.enum(["author-date", "committer-date"])).describe("Sort by"),
    order: z.optional(z.enum(["asc", "desc"])).describe("Sort order"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<SearchCommitsResult> => {
    const params = new URLSearchParams();
    params.append("q", args.query);
    if (args.sort) params.append("sort", args.sort);
    if (args.order) params.append("order", args.order);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const path = `/search/commits?${params.toString()}`;

    const result = await githubRequest<unknown>("GET", path);
    const parsed = searchCommitsResultSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const getAuthenticatedUser = action(z.object({}), async (): Promise<UserDetail> => {
  const result = await githubRequest<unknown>("GET", "/user");
  const parsed = userDetailSchema.safeParse(result);
  if (parsed.success === false) {
    throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
  }
  return parsed.data;
});
export const getUser = action(
  z.object({
    username: z.string().describe("Username"),
  }),
  async (args): Promise<UserDetail> => {
    const result = await githubRequest<unknown>("GET", `/users/${args.username}`);
    const parsed = userDetailSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const listGists = action(
  z.object({
    username: z.optional(z.string()).describe("Filter by username (defaults to authenticated user)"),
    since: z.optional(z.string()).describe("Only gists updated after this date (ISO 8601)"),
    perPage: z.optional(z.number()).describe("Results per page (max 100)"),
    page: z.optional(z.number()).describe("Page number"),
  }),
  async (args): Promise<ListGistsResult> => {
    const params = new URLSearchParams();
    if (args.since) params.append("since", args.since);
    if (args.perPage) params.append("per_page", args.perPage.toString());
    if (args.page) params.append("page", args.page.toString());

    const queryString = params.toString();
    const basePath = args.username ? `/users/${args.username}/gists` : "/gists";
    const path = `${basePath}${queryString ? `?${queryString}` : ""}`;

    const result = await githubRequest<unknown[]>("GET", path);
    const parsed = z.array(gistSchema).safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return { gists: parsed.data };
  },
);
export const getGist = action(
  z.object({
    gistId: z.string().describe("Gist ID"),
  }),
  async (args): Promise<Gist> => {
    const result = await githubRequest<unknown>("GET", `/gists/${args.gistId}`);
    const parsed = gistSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const createGist = action(
  z.object({
    description: z.optional(z.string()).describe("Gist description"),
    public: z.optional(z.boolean()).describe("Whether the gist is public"),
    files: z.record(z.string(), z.object({ content: z.string() })).describe("Files to include in the gist"),
  }),
  async (args): Promise<Gist> => {
    await requireApproval({
      action: "github:createGist",
      data: { public: args.public },
      info: { description: args.description, files: Object.keys(args.files) },
      description: `Create ${args.public ? "public" : "private"} gist`,
    });

    const result = await githubRequest<unknown>("POST", "/gists", {
      description: args.description,
      public: args.public,
      files: args.files,
    });

    const parsed = gistSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const updateGist = action(
  z.object({
    gistId: z.string().describe("Gist ID"),
    description: z.optional(z.string()).describe("New description"),
    files: z
      .record(z.string(), z.union([z.object({ content: z.string() }), z.literal(null)]))
      .describe("Files to update, add, or delete (set content to empty string to delete)"),
  }),
  async (args): Promise<Gist> => {
    await requireApproval({
      action: "github:updateGist",
      data: { gistId: args.gistId },
      info: { description: args.description, files: Object.keys(args.files) },
      description: `Update gist ${args.gistId}`,
    });

    const result = await githubRequest<unknown>("PATCH", `/gists/${args.gistId}`, {
      description: args.description,
      files: args.files,
    });

    const parsed = gistSchema.safeParse(result);
    if (parsed.success === false) {
      throw new GitHubApiError("Unexpected response from GitHub API", undefined, parsed.error.message);
    }
    return parsed.data;
  },
);
export const deleteGist = action(
  z.object({
    gistId: z.string().describe("Gist ID"),
  }),
  async (args): Promise<null> => {
    await requireApproval({
      action: "github:deleteGist",
      data: { gistId: args.gistId },
      info: {},
      description: `Delete gist ${args.gistId}`,
    });

    await githubRequest<unknown>("DELETE", `/gists/${args.gistId}`);
    return null;
  },
);
