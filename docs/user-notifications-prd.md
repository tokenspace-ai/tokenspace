# PRD: User Notifications

Issue: [TOK-63](https://linear.app/siftd/issue/TOK-63/user-notifications)
Project: Approvals
Status: Draft
Last updated: 2026-03-18

## Summary

TokenSpace needs a first-class user notification system so agents and platform workflows can reliably reach users when attention is required. Today, the only meaningful "notification" path is implicit: approval requests surface inside an active chat session. That works only when the user is already in-product and looking at the right thread.

This feature introduces:

- A built-in runtime API for sending notifications to users
- A unified notification domain in the backend
- Multi-channel delivery across in-app, email, and external messaging providers
- User-level notification preferences and routing rules
- Escalation policies that can cascade across channels when a notification is not acknowledged
- Rate limiting, deduplication, and batching for noisy non-product channels
- Migration of approval requests onto the same notification rail

The intent is to make notifications a reusable platform primitive, not a one-off approvals feature.

## Problem

TokenSpace agents can reach states where a user needs to know or act:

- An approval is required
- A long-running task completed or failed
- A workflow produced an artifact or answer that needs review
- A credential or integration action needs follow-up
- A scheduled or background run needs human attention

Current limitations:

- Approval requests are only obvious when the user is already in the relevant chat
- There is no durable notification inbox or event history for user-facing attention items
- There is no channel abstraction for email, Slack, or webhook delivery
- There is no user preference model for which channels should be used and when
- There is no escalation behavior when an in-app notification is not seen
- There are no platform-level controls for batching, dedupe, or rate limiting

As TokenSpace adds more asynchronous and background work, this becomes a product gap rather than a UI inconvenience.

## Goals

1. Give agents and platform workflows a standard way to notify a specific user.
2. Ensure important notifications are visible even when the user is not actively in TokenSpace.
3. Let users control how and when they receive notifications.
4. Route approvals through the same notification system so there is one source of truth for "attention needed".
5. Support escalation policies that move from low-friction to high-interruption channels.
6. Prevent noisy or duplicate delivery with batching, dedupe, and rate controls.
7. Preserve a durable audit trail of notification creation, delivery, acknowledgment, and action.

## Non-goals

- Building a generalized marketing or broadcast messaging system
- Shipping mobile push in v1
- Supporting arbitrary third-party channels in v1 beyond the first external messaging target
- Building a complex rule-builder UI in v1
- Replacing chat history, artifacts, or approval records as system-of-record entities
- Solving org-wide escalation or on-call scheduling in v1

## Users and Use Cases

### Primary users

- Workspace members running or collaborating with agents
- Workspace admins who need reliable follow-up on approvals and failures
- Agents and backend workflows that need a user-facing delivery primitive

### Priority use cases

1. Approval required
   A tool call needs human approval. The user should see the request in-product immediately, then receive an external notification if they do not respond.

2. Background task completed
   An agent finishes work while the user is away. The user should get a concise summary and a deep link back into the relevant chat or artifact.

3. Background task failed
   A task fails and likely needs intervention. The user should receive a higher-priority notification with enough context to act.

4. Follow-up needed
   An agent identifies missing credentials, missing input, or a blocked dependency and needs the user to unblock it.

5. Digest-worthy activity
   Lower-priority informational events should be batchable so users are informed without getting spammed.

## Product Principles

- Start in-product, escalate only when needed.
- Notifications should be actionable, not just informative.
- Delivery should be reliable and observable.
- Channel choice belongs to the user, within reasonable product defaults.
- High-urgency notifications should arrive quickly; low-urgency notifications should minimize noise.
- The backend notification model should be channel-agnostic and extensible.

## Scope

### In scope for v1

- Notification object model and lifecycle in the backend
- Built-in runtime API for agent-generated notifications
- In-app notification center and unread indicators
- Email delivery using existing Resend infrastructure
- One external messaging integration path, preferably Slack
- User notification preferences UI
- Delivery policies with fallback and time-based escalation
- Acknowledgment tracking
- Approval requests generated and delivered through the notification system
- Rate limiting, dedupe, and basic batching for external channels
- Deep links from notifications into chats, approvals, and related product surfaces

### Out of scope for v1

- SMS, mobile push, voice, or WhatsApp
- Custom user-defined notification templates
- Arbitrary per-workflow notification rule editing
- Shared team inboxes
- Workflow branching based on read receipts beyond explicit acknowledgment state

## Proposed Experience

### 1. Agent API

Agents and trusted backend workflows can create a notification through a built-in API on the existing `users` namespace:

```ts
await users.sendNotification({
  to: userId,
  category: "approval_required",
  title: "Approval needed to deploy changes",
  content: "The agent wants to deploy workspace updates to production.",
  priority: "high",
  actionUrl: "/workspace/acme/chat/chat_123?approval=request_456",
  actionLabel: "Review approval",
  dedupeKey: "approval:request_456",
  escalationPolicy: "default_approval",
  metadata: {
    sessionId,
    chatId,
    approvalRequestId: "request_456",
  },
});
```

The API should feel like a platform primitive, similar to existing built-in user lookup helpers. It should support:

- Explicit recipient
- Category and priority
- Rich but bounded content
- Action link and label
- Dedupe key
- Policy override
- Metadata for product routing and analytics

### 2. In-app experience

Users get:

- A global notification center accessible from the main app shell
- Unread count badge
- Notification list with filters such as unread, approvals, mentions, failures, completed tasks
- Structured notification cards with title, summary, timestamp, actor/source, priority, and CTA
- Read and unread state
- Acknowledged state for notifications that require attention
- Deep-link navigation to the originating chat, approval request, artifact, or settings page

For approvals specifically:

- Approval notifications should appear in the notification center and continue to render in the existing chat approval UI
- Opening an approval notification should take the user directly to the approval surface
- Once approved or denied, the notification should resolve to a completed state

### 3. Out-of-product delivery

Channel behavior in v1:

- In-app: default for all supported notification types
- Email: supported for all high-value categories and digests
- Slack: supported for direct, actionable notifications where a deep link back into TokenSpace is sufficient
- Webhook: optional stretch goal, not required for v1

External delivery should only happen when:

- The notification category allows it
- The user preference allows it
- The routing policy determines it is needed
- Rate and dedupe checks pass

### 4. Escalation behavior

Default approval policy:

1. Create in-app notification immediately.
2. If the user has an active interactive session in the relevant workspace, rely on in-app delivery first.
3. If the notification is not acknowledged after 1 minute, send Slack.
4. If still not acknowledged after 5 additional minutes, send email.

Default non-approval policy:

- High priority failure: in-app immediately, email within 5 minutes if not acknowledged
- Normal completion: in-app only by default, optionally digest externally
- Low priority informational: digest only, no immediate external delivery

Acknowledgment should stop downstream escalation once a user has clearly engaged.

## Functional Requirements

### Notification model

The platform must store a first-class notification entity with:

- Recipient user ID
- Workspace ID
- Optional chat ID
- Optional session ID
- Optional approval request ID
- Category
- Priority
- Title
- Body/content
- CTA label and URL
- Source type and source ID
- Current state
- Dedupe key
- Escalation policy reference
- Created timestamp
- Read timestamp
- Acknowledged timestamp
- Resolved timestamp

The platform must also store delivery-attempt records per channel with:

- Notification ID
- Channel
- Attempt number
- Delivery state
- Provider payload reference
- Provider response metadata
- Scheduled time
- Attempted time
- Failure reason

### Notification states

At minimum:

- `pending`
- `delivered`
- `read`
- `acknowledged`
- `resolved`
- `failed`
- `suppressed`

Notes:

- `read` means the notification was displayed in-product.
- `acknowledged` means the user actively engaged in a way that should stop escalation.
- `resolved` means the underlying item no longer requires attention.
- `suppressed` covers dedupe, batching, muted-category preference, or rate-limit suppression.

### Preferences

Users must be able to manage notification preferences from user settings.

Initial v1 preference dimensions:

- Category-level enablement
- Channel-level enablement
- Priority thresholds for external delivery
- Digest vs immediate for low-priority categories
- Quiet hours for non-urgent external delivery
- Slack connection status and destination selection

Suggested default categories:

- Approvals
- Task completed
- Task failed
- Agent needs input
- Workspace/system notices

Suggested defaults:

- Approvals: in-app + escalation enabled
- Task failed: in-app immediate, email enabled
- Task completed: in-app immediate, external off by default
- Agent needs input: in-app immediate, email enabled
- Workspace/system notices: digest

### Acknowledgment semantics

A notification counts as acknowledged when one of the following happens:

- The user clicks the primary CTA
- The user opens the approval and takes an approve or deny action
- The user explicitly clicks "Acknowledge" or equivalent on the notification
- The user opens the notification detail and the category is configured so opening counts as acknowledgment

Plain delivery success does not count as acknowledgment.

### Routing and escalation

The system must support channel routing policies with:

- Ordered channel fallback
- Per-step delay
- Stop-on-acknowledge behavior
- Respect for preferences and quiet hours
- Category-specific defaults

The system should allow product-owned default policies such as:

- `default_approval`
- `high_priority_failure`
- `completion_digest`

### Dedupe, batching, and rate limiting

The system must support:

- Dedupe by explicit `dedupeKey`
- Per-user/category channel throttles
- Digest windows for low-priority notifications
- Collapse of repeated failures into a single updated notification where appropriate

Baseline rules for v1:

- Only one active external approval escalation per approval request
- Repeated notifications with the same dedupe key should update the existing notification rather than create new external sends
- Low-priority completions may batch into a digest window of 15 to 30 minutes
- External channel caps should prevent burst spam during workflow storms

### Approvals integration

Approval requests must be emitted as notifications when created.

Approval requirements:

- Creating an approval request creates a linked notification
- Notification metadata links back to `approvalRequests`, `sessions`, and `chats`
- Approving or denying the request marks the notification resolved
- Existing chat UI for approvals remains functional
- Chat status and notification state must not drift

This is the first required migration onto the shared notification rail.

## UX Requirements

### User settings

Add a `Notifications` tab to the existing user settings area.

This page should support:

- Category toggles
- Channel toggles
- Quiet hours
- Slack connection and destination selection
- Digest preferences
- Preview of the default escalation policy for approvals

### App shell

Add a notification entry point in the primary authenticated app shell with:

- Unread badge
- Dropdown or panel preview for recent notifications
- Link to a full notifications page if needed

### Notification list

Users should be able to:

- View unread first
- Filter by category and state
- Mark read
- Acknowledge where supported
- Resolve or dismiss informational items where applicable

### Content guidelines

Every notification should include:

- Clear reason for the interruption
- What needs attention now
- The next action
- Deep link back into the product

External messages should be concise and must not expose sensitive payloads beyond what is necessary to identify the action.

## Technical Direction

This PRD is product-first, but the implementation should align with current Tokenspace architecture.

### Existing system anchors

- `sessions` already provide a durable user execution context
- `chats` already track thread state and workspace context
- `approvalRequests` already exist and represent the first high-value notification source
- `users` built-ins already exist in the runtime and can be extended with `sendNotification`
- Resend is already wired for transactional email
- User settings already exist and are a natural home for preferences

### Suggested backend additions

New Convex tables:

- `notifications`
- `notificationDeliveries`
- `notificationPreferences`
- `notificationPolicies`
- `notificationDigests` or equivalent batching state

Suggested notification categories:

- `approval_required`
- `task_completed`
- `task_failed`
- `agent_input_required`
- `workspace_notice`

Suggested channels:

- `in_app`
- `email`
- `slack`
- `webhook` if later added

### Suggested runtime contract

Add to the server-only built-ins:

```ts
type NotificationCategory =
  | "approval_required"
  | "task_completed"
  | "task_failed"
  | "agent_input_required"
  | "workspace_notice";

type NotificationPriority = "low" | "normal" | "high" | "urgent";

type SendNotificationArgs = {
  to: string;
  title: string;
  content: string;
  category: NotificationCategory;
  priority?: NotificationPriority;
  actionUrl?: string;
  actionLabel?: string;
  dedupeKey?: string;
  escalationPolicy?: string;
  metadata?: Record<string, unknown>;
};

interface TokenspaceUsers {
  getCurrentUserInfo(): Promise<TokenspaceUserInfo>;
  getInfo(args: UserLookup): Promise<TokenspaceUserInfo | null>;
  sendNotification(args: SendNotificationArgs): Promise<{ id: string }>;
}
```

Guardrails:

- Only server/runtime execution contexts with an authenticated user or durable workflow context may send notifications
- The sender must be constrained to users visible within the current workspace context unless a platform-level workflow explicitly bypasses that
- Metadata must remain JSON-serializable and size-bounded

### Suggested orchestration model

Notification creation should be synchronous from the caller perspective. Delivery should be asynchronous and scheduler-driven.

Recommended flow:

1. Caller creates notification.
2. Backend writes notification row and initial in-app delivery row.
3. Scheduler evaluates routing policy.
4. Immediate eligible channels send now.
5. Delayed fallback steps are scheduled.
6. Each step re-checks current state, preferences, quiet hours, and acknowledgment before sending.
7. Resolution or acknowledgment cancels future escalation steps.

## Success Metrics

### Primary metrics

- Approval acknowledgment rate within 10 minutes
- Median time to acknowledge approval requests
- Percentage of high-priority notifications acknowledged before final escalation
- Reduction in "stalled waiting for approval" sessions

### Secondary metrics

- External delivery success rate by channel
- Notification open rate
- Notification click-through rate
- Digest adoption rate
- Mute or disable rates by category
- Spam signals, such as rapid disablement after receipt

## Rollout Plan

### Phase 1

- Backend notification entities and delivery logging
- In-app notification center
- Approval notifications routed through the new system
- Basic preferences

### Phase 2

- Email delivery
- Escalation policies
- Read, acknowledge, and resolve state handling
- Dedupe and rate limiting

### Phase 3

- Slack delivery
- Digesting and batching
- Expanded categories beyond approvals

## Risks

- Over-notification may reduce trust quickly if defaults are too aggressive
- Approval flows can become inconsistent if chat state and notification state diverge
- External delivery without strong dedupe could spam users during retry storms or agent loops
- Slack destination and identity mapping can become a product and support burden if not scoped tightly
- Quiet-hours logic can delay genuinely urgent actions if priority semantics are unclear

## Open Questions

1. Should v1 Slack delivery target a connected user DM, a selected channel, or both?
2. Should opening an approval notification count as acknowledgment, or only approve/deny actions?
3. Do we want workspace-level admin defaults that preconfigure user preferences, or only per-user settings in v1?
4. Should low-priority task completions ever notify externally by default?
5. Is webhook delivery needed in v1, or should it wait until the core user-facing channels are stable?
6. Do we need a "snooze" action in v1 for notifications that are seen but intentionally deferred?

## Recommendation

Build this as a platform notification primitive with approvals as the first mandatory consumer. Ship in-app notifications and approval migration first, then add email-based escalation using the existing Resend setup, then add Slack once preference and routing fundamentals are stable.
