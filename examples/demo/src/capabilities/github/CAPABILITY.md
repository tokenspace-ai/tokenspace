---
name: GitHub
description: GitHub hosts the source code and infrastructure configuration for our products. We use GitHub actions for deployment.
---

# Our GitHub

Important repositories:

- tokenspace-ai/demo-infra: Hosts the demo infrastructure codebase.
- tokenspace-ai/demo-app: Hosts the demo application codebase.
- tokenspace-ai/testing: Test repo, which doesn't require approval for most operations.

## Available Operations

### Repositories
- `getRepository` - Get repository information
- `listRepositories` - List repositories for a user or organization
- `createRepository` - Create a new repository (requires approval)
- `updateRepository` - Update repository settings (requires approval)
- `deleteRepository` - Delete a repository (requires approval)
- `forkRepository` - Fork a repository (requires approval)

### Branches
- `listBranches` - List branches in a repository
- `getBranch` - Get branch details
- `createBranch` - Create a new branch (requires approval)
- `deleteBranch` - Delete a branch (requires approval)

### Commits
- `listCommits` - List commits in a repository
- `getCommit` - Get commit details
- `compareCommits` - Compare two commits

### File Contents
- `getContent` - Get file or directory contents
- `getFileContentRaw` - Get raw file content as string
- `createOrUpdateFile` - Create or update a file (requires approval)
- `deleteFile` - Delete a file (requires approval)

### Tags
- `listTags` - List tags in a repository
- `createTag` - Create an annotated tag (requires approval)
- `deleteTag` - Delete a tag (requires approval)

### Pull Requests
- `listPullRequests` - List pull requests
- `getPullRequest` - Get pull request details
- `createPullRequest` - Create a pull request (requires approval)
- `updatePullRequest` - Update a pull request (requires approval)
- `mergePullRequest` - Merge a pull request (requires approval)
- `listPullRequestFiles` - List files changed in a PR
- `listPullRequestCommits` - List commits in a PR

### Pull Request Reviews
- `listPullRequestReviews` - List reviews on a PR
- `createPullRequestReview` - Create a review (requires approval)
- `dismissPullRequestReview` - Dismiss a review (requires approval)
- `requestReviewers` - Request reviewers (requires approval)
- `removeReviewers` - Remove reviewers (requires approval)

### Issues
- `listIssues` - List issues in a repository
- `getIssue` - Get issue details
- `createIssue` - Create an issue (requires approval)
- `updateIssue` - Update an issue (requires approval)
- `lockIssue` - Lock an issue (requires approval)
- `unlockIssue` - Unlock an issue (requires approval)

### Issue Comments
- `listIssueComments` - List comments on an issue
- `createIssueComment` - Create a comment (requires approval)
- `updateIssueComment` - Update a comment (requires approval)
- `deleteIssueComment` - Delete a comment (requires approval)

### Labels
- `listLabels` - List labels in a repository
- `getLabel` - Get label details
- `createLabel` - Create a label (requires approval)
- `updateLabel` - Update a label (requires approval)
- `deleteLabel` - Delete a label (requires approval)
- `addLabelsToIssue` - Add labels to an issue (requires approval)
- `removeLabelFromIssue` - Remove a label from an issue (requires approval)

### GitHub Actions - Workflows
- `listWorkflows` - List workflows in a repository
- `getWorkflow` - Get workflow details
- `triggerWorkflow` - Trigger a workflow dispatch (requires approval)
- `enableWorkflow` - Enable a workflow (requires approval)
- `disableWorkflow` - Disable a workflow (requires approval)

### GitHub Actions - Workflow Runs
- `listWorkflowRuns` - List workflow runs
- `getWorkflowRun` - Get workflow run details
- `cancelWorkflowRun` - Cancel a workflow run (requires approval)
- `rerunWorkflow` - Re-run a workflow (requires approval)
- `rerunFailedJobs` - Re-run only failed jobs (requires approval)
- `deleteWorkflowRun` - Delete a workflow run (requires approval)
- `deleteWorkflowRunLogs` - Delete workflow run logs (requires approval)

### GitHub Actions - Jobs & Logs
- `listWorkflowRunJobs` - List jobs in a workflow run
- `getWorkflowRunLogsUrl` - Get download URL for workflow run logs
- `getJobLogs` - Get logs for a specific job

### Releases
- `listReleases` - List releases in a repository
- `getRelease` - Get release details
- `getLatestRelease` - Get the latest release
- `getReleaseByTag` - Get a release by tag name
- `createRelease` - Create a release (requires approval)
- `updateRelease` - Update a release (requires approval)
- `deleteRelease` - Delete a release (requires approval)

### Search
- `searchCode` - Search for code across repositories
- `searchIssues` - Search for issues and pull requests
- `searchRepositories` - Search for repositories
- `searchCommits` - Search for commits

### Users
- `getAuthenticatedUser` - Get the authenticated user
- `getUser` - Get a user by username

### Gists
- `listGists` - List gists for a user
- `getGist` - Get gist details
- `createGist` - Create a gist (requires approval)
- `updateGist` - Update a gist (requires approval)
- `deleteGist` - Delete a gist (requires approval)
