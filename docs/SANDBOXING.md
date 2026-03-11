# Tokenspace Sandboxing and Human-in-loop Model

Agent-generated code can be safely executed without human approval because:

- It runs in a sandboxed JavaScript isolate
- No access to system APIs (filesystem, networking, etc.)
- Only access to a virtual filesystem
- Only access to a set of guardrailed APIs that facilitate access to other systems

This allows the agent to:

- Work autonomously without human approval
- Operate within the boundaries of the workspace's guardrailed APIs
- Request approval for actions that require it

## Code Execution

Agent-generated TypeScript code executes in a sandboxed JavaScript isolate that does not have access to system APIs (filesystem, networking, etc.). Instead, it receives a set of functions to interact with other systems and a virtual session filesystem (which it can read from and write to).

Each workspace contains code that defines the guardrailed APIs the agent can use.

For example, a workspace might define a function to create a ticket:

```typescript
async function createTicket(title: string, description: string) {
  await requireApproval({ action: "ticket:create", data: { title, description } });
  const response = await fetch("https://myapi.com/ticket/create", { ... });
  // ...
  return ticket.id;
}
```

The agent can then generate code to call this function:

```typescript
const ticketId = await createTicket("My first ticket", "This is a description of the ticket");
console.log(`Ticket created: ${ticketId}`);
```

When the agent first executes this code, it throws an error when `requireApproval` is called because no approval has been granted for this action in this session.

This doesn't immediately trigger an approval dialog on the user's screen—it's up to the agent how to handle the approval requirement (it just cannot invoke the action without it). The agent could do something else, or collect multiple actions to request approval at once.

If the agent decides to request user approval, a popup appears for the user explaining the action and asking them to approve it. (In the future, there will be additional approval routing options to request approval from specific users or groups, or use AI pre-approval.)

When approval has been granted, the agent can execute the same code again, and it will succeed because the approval has been attached to the session.
