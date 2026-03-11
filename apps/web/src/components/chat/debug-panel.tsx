"use client";

import { Link } from "@tanstack/react-router";
import { api } from "@tokenspace/backend/convex/_generated/api";
import type { Doc } from "@tokenspace/backend/convex/_generated/dataModel";
import { useMutation, useQuery } from "convex/react";
import {
  AlertCircle,
  AlertTriangleIcon,
  BarChart3,
  BotIcon,
  CheckCircle,
  CheckCircleIcon,
  ChevronRight,
  Circle,
  CircleIcon,
  Clock,
  CodeXmlIcon,
  Copy,
  ExternalLinkIcon,
  FileCode2,
  GitBranch,
  InfoIcon,
  Loader2,
  MessageSquare,
  Shield,
  SquareIcon,
  TerminalIcon,
  Wrench,
  WrenchIcon,
  XCircle,
} from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { CodeBlock, CodeBlockCopyButton } from "@/components/ai-elements/code-block";
import { JsonTree } from "@/components/json-tree";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card";
import { cn } from "@/lib/utils";
import { ChatConversationView } from "./chat-conversation-view";
import { ChatSidebarPanel, useChatSidebar } from "./chat-sidebar";

function copyToClipboard(text: string) {
  navigator.clipboard.writeText(text);
}

function formatTimestamp(ts: number | undefined) {
  if (!ts) return "N/A";
  return new Date(ts).toLocaleString();
}

function mapThreadStatusToSubAgentStatus(status: string | undefined) {
  switch (status) {
    case "streaming":
      return "running";
    case "awaiting_tool_results":
      return "awaiting_tool_results";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "stopped":
      return "stopped";
    default:
      return undefined;
  }
}

function getSubAgentActivityText(status: string | undefined) {
  switch (status) {
    case "initializing":
      return "Initializing sub-agent...";
    case "running":
      return "Working on the task...";
    case "awaiting_tool_results":
      return "Waiting for tool results...";
    case "completed":
      return "Sub-agent completed.";
    case "failed":
      return "Sub-agent failed.";
    case "stopped":
      return "Sub-agent stopped.";
    case "detached":
      return "Sub-agent running in background.";
    default:
      return "Sub-agent started.";
  }
}

function SubAgentActivityIcon({ status }: { status: string | undefined }) {
  if (status === "failed") {
    return <AlertTriangleIcon className="mt-0.5 size-3.5 text-destructive" />;
  }
  if (status === "initializing" || status === "running" || status === "awaiting_tool_results") {
    return <Clock className="mt-0.5 size-3.5 animate-pulse text-blue-500" />;
  }
  return <CheckCircleIcon className="mt-0.5 size-3.5 text-emerald-500" />;
}

export function StatusBadge({ status }: { status: string | undefined }) {
  if (!status) return <Badge variant="outline">Unknown</Badge>;
  const variants: Record<
    string,
    { variant: "default" | "secondary" | "destructive" | "outline"; icon: React.ReactNode }
  > = {
    active: { variant: "default", icon: <Circle className="size-3 fill-current" /> },
    completed: { variant: "secondary", icon: <CheckCircle className="size-3" /> },
    failed: { variant: "destructive", icon: <XCircle className="size-3" /> },
    streaming: { variant: "default", icon: <Circle className="size-3 fill-current" /> },
    awaiting_tool_results: { variant: "outline", icon: <Clock className="size-3" /> },
    waiting_for_approval: { variant: "outline", icon: <Shield className="size-3" /> },
    stopped: { variant: "outline", icon: <XCircle className="size-3" /> },
    pending: { variant: "outline", icon: <Clock className="size-3" /> },
    approved: { variant: "secondary", icon: <CheckCircle className="size-3" /> },
    denied: { variant: "destructive", icon: <XCircle className="size-3" /> },
    running: { variant: "default", icon: <Circle className="size-3 fill-current" /> },
    detached: { variant: "outline", icon: <GitBranch className="size-3" /> },
  };
  const config = variants[status] ?? { variant: "outline" as const, icon: null };
  return (
    <Badge variant={config.variant} className="gap-1 text-[10px]">
      {config.icon}
      {status}
    </Badge>
  );
}

export function IdBadge({ id, label }: { id: string | undefined; label?: string }) {
  if (!id) return null;
  const shortId = id.length > 16 ? `${id.slice(0, 6)}...${id.slice(-6)}` : id;
  return (
    <button
      type="button"
      onClick={() => copyToClipboard(id)}
      className="inline-flex items-center gap-1 px-1 py-0.5 rounded bg-muted text-[10px] font-mono hover:bg-muted/80 transition-colors"
      title={`Click to copy: ${id}`}
    >
      {label && <span className="text-muted-foreground">{label}:</span>}
      {shortId}
      <Copy className="size-2 text-muted-foreground" />
    </button>
  );
}

function InfoRow({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex justify-between items-center text-xs py-0.5">
      <span className="text-muted-foreground">{label}</span>
      {children}
    </div>
  );
}

// Breadcrumb component
function DebugBreadcrumb({ items }: { items: { label: string; onClick?: () => void }[] }) {
  return (
    <div className="flex items-center gap-1 text-xs text-muted-foreground mb-3 flex-wrap">
      {items.map((item, i) => (
        <span key={i} className="flex items-center gap-1">
          {i > 0 && <ChevronRight className="size-3" />}
          {item.onClick ? (
            <Button
              variant="link"
              size="sm"
              className="h-auto p-0 text-xs text-muted-foreground hover:text-foreground"
              onClick={item.onClick}
            >
              {item.label}
            </Button>
          ) : (
            <span className="font-medium text-foreground">{item.label}</span>
          )}
        </span>
      ))}
    </div>
  );
}

// Navigation item for overview page
function NavItem({
  icon,
  label,
  count,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  count?: number;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="flex items-center gap-2 w-full p-2 hover:bg-muted/50 rounded-lg transition-colors text-sm text-left"
    >
      {icon}
      <span className="font-medium flex-1">{label}</span>
      {count !== undefined && (
        <Badge variant="secondary" className="text-[10px]">
          {count}
        </Badge>
      )}
      <ChevronRight className="size-3 text-muted-foreground" />
    </button>
  );
}

// Tool status badge for tool detail view
function ToolStatusBadge({ status }: { status: "running" | "completed" | "failed" }) {
  const variants = {
    running: { className: "bg-blue-500/10 text-blue-500 border-blue-500/20", icon: CircleIcon, label: "Running" },
    completed: {
      className: "bg-green-500/10 text-green-500 border-green-500/20",
      icon: CheckCircleIcon,
      label: "Completed",
    },
    failed: { className: "bg-red-500/10 text-red-500 border-red-500/20", icon: AlertTriangleIcon, label: "Failed" },
  };
  const config = variants[status];
  const Icon = config.icon;
  return (
    <Badge variant="outline" className={cn("gap-1 text-[10px]", config.className)}>
      <Icon className={cn("size-3", status === "running" && "fill-current")} />
      {config.label}
    </Badge>
  );
}

// Main DebugPanel component
export function DebugPanel() {
  const { sidebarSection, chatId, debugView, messageId, toolCallId, subAgentThreadId } = useChatSidebar();

  const debugInfo = useQuery(api.ai.chat.getChatDebugInfo, chatId && sidebarSection === "debug" ? { chatId } : "skip");

  if (sidebarSection !== "debug") return null;

  if (debugInfo === undefined) {
    return (
      <ChatSidebarPanel title="Debug Info">
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </ChatSidebarPanel>
    );
  }

  if (debugInfo === null) {
    return (
      <ChatSidebarPanel title="Debug Info">
        <div className="flex flex-col items-center justify-center py-8 text-center">
          <AlertCircle className="size-8 text-muted-foreground/50" />
          <p className="mt-2 text-sm text-muted-foreground">Debug info not available</p>
        </div>
      </ChatSidebarPanel>
    );
  }

  // Route to appropriate view
  if (debugView === "messages" && messageId) {
    return <DebugMessageDetailView debugInfo={debugInfo} messageId={messageId} />;
  }
  if (debugView === "messages") {
    return <DebugMessagesView debugInfo={debugInfo} />;
  }
  if (debugView === "tools" && toolCallId) {
    return <DebugToolDetailView debugInfo={debugInfo} toolCallId={toolCallId} />;
  }
  if (debugView === "tools") {
    return <DebugToolsView debugInfo={debugInfo} />;
  }
  if (debugView === "subagents") {
    if (subAgentThreadId) {
      return (
        <DebugSubAgentThreadView key={subAgentThreadId} debugInfo={debugInfo} subAgentThreadId={subAgentThreadId} />
      );
    }
    return <DebugSubAgentsView debugInfo={debugInfo} />;
  }
  if (debugView === "approvals") {
    return <DebugApprovalsView debugInfo={debugInfo} />;
  }
  if (debugView === "usage") {
    return <DebugUsageView />;
  }
  if (debugView === "raw") {
    return <DebugRawDataView debugInfo={debugInfo} />;
  }

  // Default: Overview
  return <DebugOverview debugInfo={debugInfo} />;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type DebugInfo = any;

// Overview component
function DebugOverview({ debugInfo }: { debugInfo: DebugInfo }) {
  const { openDebugView, chatId } = useChatSidebar();
  const { chat, session, thread, messages, toolCalls, subAgents, approvalRequests, approvals } = debugInfo;

  const usageData = useQuery(api.ai.chat.getChatUsageRecords, chatId ? { chatId } : "skip");
  const [usageTab, setUsageTab] = useState<"last" | "cumulative">("last");

  return (
    <ChatSidebarPanel title="Debug Info">
      <div className="space-y-4">
        {/* Status and Info */}
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-muted-foreground">Thread Status</span>
            <StatusBadge status={thread?.status} />
          </div>

          {/* Thread State */}
          {thread && (
            <div className="space-y-1 border-t pt-2">
              <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Thread</div>
              <InfoRow label="ID">
                <IdBadge id={thread._id} />
              </InfoRow>
              <InfoRow label="Stop Signal">
                <Badge variant={thread.stopSignal ? "destructive" : "outline"} className="text-[10px]">
                  {thread.stopSignal ? "Yes" : "No"}
                </Badge>
              </InfoRow>
              <InfoRow label="Stream ID">
                <span className="font-mono text-[10px]">{thread.streamId || "None"}</span>
              </InfoRow>
            </div>
          )}

          {/* Session Info */}
          <div className="space-y-1 border-t pt-2">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Session</div>
            <InfoRow label="ID">
              <IdBadge id={session._id} />
            </InfoRow>
            <InfoRow label="Status">
              <StatusBadge status={session.status} />
            </InfoRow>
            <InfoRow label="Created">
              <span className="text-[10px]">{formatTimestamp(session.createdAt)}</span>
            </InfoRow>
            <InfoRow label="Updated">
              <span className="text-[10px]">{formatTimestamp(session.updatedAt)}</span>
            </InfoRow>
          </div>

          {/* Chat Info */}
          <div className="space-y-1 border-t pt-2">
            <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Chat</div>
            <InfoRow label="ID">
              <IdBadge id={chat._id} />
            </InfoRow>
            <InfoRow label="Thread">
              <IdBadge id={chat.threadId} />
            </InfoRow>
            <InfoRow label="Model">
              <span className="font-mono text-[10px]">{chat.modelId || "default"}</span>
            </InfoRow>
            <InfoRow label="Messages">
              <span className="text-[10px]">{chat.messageCount ?? 0}</span>
            </InfoRow>
          </div>

          {/* Token Usage */}
          {(chat.usage || usageData) && (
            <div className="space-y-1 border-t pt-2">
              <div className="flex items-center justify-between">
                <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Token Usage</div>
                <div className="flex items-center gap-0.5 rounded-md bg-muted p-0.5">
                  <button
                    type="button"
                    onClick={() => setUsageTab("last")}
                    className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors",
                      usageTab === "last"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Last
                  </button>
                  <button
                    type="button"
                    onClick={() => setUsageTab("cumulative")}
                    className={cn(
                      "px-1.5 py-0.5 rounded text-[10px] font-medium transition-colors",
                      usageTab === "cumulative"
                        ? "bg-background text-foreground shadow-sm"
                        : "text-muted-foreground hover:text-foreground",
                    )}
                  >
                    Cumulative
                  </button>
                </div>
              </div>

              {usageTab === "last" && chat.usage && (
                <>
                  <InfoRow label="Input">
                    <span className="text-[10px]">{chat.usage.inputTokens.toLocaleString()}</span>
                  </InfoRow>
                  <InfoRow label="Output">
                    <span className="text-[10px]">{chat.usage.outputTokens.toLocaleString()}</span>
                  </InfoRow>
                  <InfoRow label="Total">
                    <span className="text-[10px] font-medium">{chat.usage.totalTokens.toLocaleString()}</span>
                  </InfoRow>
                  {chat.usage.reasoningTokens !== undefined && (
                    <InfoRow label="Reasoning">
                      <span className="text-[10px]">{chat.usage.reasoningTokens.toLocaleString()}</span>
                    </InfoRow>
                  )}
                  {chat.usage.cachedInputTokens !== undefined && (
                    <InfoRow label="Cached">
                      <span className="text-[10px]">{chat.usage.cachedInputTokens.toLocaleString()}</span>
                    </InfoRow>
                  )}
                  {chat.usage.cacheWriteInputTokens !== undefined && (
                    <InfoRow label="Cache Write">
                      <span className="text-[10px]">{chat.usage.cacheWriteInputTokens.toLocaleString()}</span>
                    </InfoRow>
                  )}
                </>
              )}
              {usageTab === "last" && !chat.usage && (
                <p className="text-[10px] text-muted-foreground py-1">No usage data yet</p>
              )}

              {usageTab === "cumulative" && usageData && (
                <>
                  <div className="text-[10px] text-muted-foreground">
                    {usageData.records.length} {usageData.records.length === 1 ? "request" : "requests"}
                  </div>
                  <InfoRow label="Input">
                    <span className="text-[10px]">{usageData.cumulative.inputTokens.toLocaleString()}</span>
                  </InfoRow>
                  <InfoRow label="Output">
                    <span className="text-[10px]">{usageData.cumulative.outputTokens.toLocaleString()}</span>
                  </InfoRow>
                  <InfoRow label="Total">
                    <span className="text-[10px] font-medium">{usageData.cumulative.totalTokens.toLocaleString()}</span>
                  </InfoRow>
                  {usageData.cumulative.reasoningTokens > 0 && (
                    <InfoRow label="Reasoning">
                      <span className="text-[10px]">{usageData.cumulative.reasoningTokens.toLocaleString()}</span>
                    </InfoRow>
                  )}
                  {usageData.cumulative.cachedInputTokens > 0 && (
                    <InfoRow label="Cached">
                      <span className="text-[10px]">{usageData.cumulative.cachedInputTokens.toLocaleString()}</span>
                    </InfoRow>
                  )}
                  {usageData.cumulative.cacheWriteInputTokens > 0 && (
                    <InfoRow label="Cache Write">
                      <span className="text-[10px]">{usageData.cumulative.cacheWriteInputTokens.toLocaleString()}</span>
                    </InfoRow>
                  )}
                  {usageData.cumulative.cost > 0 && (
                    <InfoRow label="Cost">
                      <span className="text-[10px] font-medium">${usageData.cumulative.cost.toFixed(4)}</span>
                    </InfoRow>
                  )}
                  {usageData.cumulative.marketCost > 0 && (
                    <InfoRow label="Market Cost">
                      <span className="text-[10px] font-medium">${usageData.cumulative.marketCost.toFixed(4)}</span>
                    </InfoRow>
                  )}
                </>
              )}
              {usageTab === "cumulative" && !usageData && (
                <div className="flex items-center justify-center py-2">
                  <Loader2 className="size-3 animate-spin text-muted-foreground" />
                </div>
              )}
            </div>
          )}

          {/* Error */}
          {chat.errorMessage && (
            <div className="p-2 bg-destructive/10 rounded border border-destructive/30 text-[10px] text-destructive">
              {chat.errorMessage}
            </div>
          )}
        </div>

        {/* Navigation Items */}
        <div className="space-y-1 border-t pt-3">
          <NavItem
            icon={<MessageSquare className="size-4" />}
            label="Messages"
            count={messages.length}
            onClick={() => openDebugView("messages")}
          />
          <NavItem
            icon={<Wrench className="size-4" />}
            label="Tool Calls"
            count={toolCalls.length}
            onClick={() => openDebugView("tools")}
          />
          <NavItem
            icon={<BotIcon className="size-4" />}
            label="Sub-Agents"
            count={subAgents.children.length}
            onClick={() => openDebugView("subagents")}
          />
          <NavItem
            icon={<Shield className="size-4" />}
            label="Approvals"
            count={approvalRequests.length + approvals.length}
            onClick={() => openDebugView("approvals")}
          />
          <NavItem
            icon={<BarChart3 className="size-4" />}
            label="Usage Records"
            count={usageData?.records.length}
            onClick={() => openDebugView("usage")}
          />
          <NavItem icon={<FileCode2 className="size-4" />} label="Raw Data" onClick={() => openDebugView("raw")} />
        </div>
      </div>
    </ChatSidebarPanel>
  );
}

// Messages List View
function DebugMessagesView({ debugInfo }: { debugInfo: DebugInfo }) {
  const { openDebug, openMessageDetails } = useChatSidebar();
  const { messages } = debugInfo;

  return (
    <ChatSidebarPanel title="Messages">
      <DebugBreadcrumb items={[{ label: "Chat Thread", onClick: openDebug }, { label: "Messages" }]} />
      <div className="space-y-2">
        {messages.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">No messages</p>
        ) : (
          messages.map((msg: any) => (
            <button
              key={msg._id}
              type="button"
              onClick={() => openMessageDetails(msg._id)}
              className="w-full p-2 rounded bg-muted/30 border border-border/40 hover:bg-muted/50 transition-colors text-left"
            >
              <div className="flex items-center justify-between mb-1">
                <Badge
                  variant={msg.role === "user" ? "default" : msg.role === "assistant" ? "secondary" : "outline"}
                  className="text-[10px]"
                >
                  {msg.role}
                </Badge>
                <span className="text-[10px] text-muted-foreground">#{msg.order}</span>
              </div>
              <div className="text-[10px] text-muted-foreground truncate">
                {typeof msg.content === "string"
                  ? msg.content.slice(0, 80)
                  : Array.isArray(msg.content)
                    ? msg.content
                        .map((c: any) => (c.type === "text" ? c.text : `[${c.type}]`))
                        .join(" ")
                        .slice(0, 80)
                    : "[complex]"}
              </div>
              <div className="text-[10px] text-muted-foreground/60 mt-1">{formatTimestamp(msg._creationTime)}</div>
            </button>
          ))
        )}
      </div>
    </ChatSidebarPanel>
  );
}

// Message Detail View
function DebugMessageDetailView({ debugInfo, messageId }: { debugInfo: DebugInfo; messageId: string }) {
  const { openDebug, openDebugView } = useChatSidebar();
  const message = debugInfo.messages.find((m: any) => m._id === messageId);

  if (!message) {
    return (
      <ChatSidebarPanel title="Message">
        <DebugBreadcrumb
          items={[
            { label: "Chat Thread", onClick: openDebug },
            { label: "Messages", onClick: () => openDebugView("messages") },
            { label: "Not Found" },
          ]}
        />
        <p className="text-xs text-muted-foreground text-center py-4">Message not found</p>
      </ChatSidebarPanel>
    );
  }

  return (
    <ChatSidebarPanel title="Message">
      <DebugBreadcrumb
        items={[
          { label: "Chat Thread", onClick: openDebug },
          { label: "Messages", onClick: () => openDebugView("messages") },
          { label: `#${message.order}` },
        ]}
      />
      <div className="space-y-3">
        <div className="flex items-center justify-between">
          <Badge variant={message.role === "user" ? "default" : message.role === "assistant" ? "secondary" : "outline"}>
            {message.role}
          </Badge>
          <span className="text-xs text-muted-foreground">Order: {message.order}</span>
        </div>
        <InfoRow label="Created">
          <span className="text-[10px]">{formatTimestamp(message._creationTime)}</span>
        </InfoRow>
        <div className="space-y-2">
          <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Content</h4>
          <div className="rounded-md border border-border bg-secondary/30 p-2 max-h-[400px] overflow-auto">
            {typeof message.content === "string" ? (
              <div className="font-mono whitespace-pre-wrap text-xs">{message.content}</div>
            ) : (
              <JsonTree data={message.content} initialMaxLines={100} />
            )}
          </div>
        </div>
      </div>
    </ChatSidebarPanel>
  );
}

// Tools List View
function DebugToolsView({ debugInfo }: { debugInfo: DebugInfo }) {
  const { openDebug, openToolDetails } = useChatSidebar();
  const { toolCalls } = debugInfo;

  return (
    <ChatSidebarPanel title="Tool Calls">
      <DebugBreadcrumb items={[{ label: "Chat Thread", onClick: openDebug }, { label: "Tool Calls" }]} />
      <div className="space-y-2">
        {toolCalls.length === 0 ? (
          <p className="text-xs text-muted-foreground text-center py-4">No tool calls</p>
        ) : (
          toolCalls.map((tc: any) => (
            <button
              key={tc._id}
              type="button"
              onClick={() => openToolDetails(tc.toolCallId)}
              className="w-full p-2 rounded bg-muted/30 border border-border/40 hover:bg-muted/50 transition-colors text-left"
            >
              <div className="flex items-center justify-between mb-1">
                <span className="font-mono text-xs font-medium">{tc.toolName}</span>
                {tc.error ? (
                  <Badge variant="destructive" className="text-[10px]">
                    Error
                  </Badge>
                ) : tc.result !== undefined ? (
                  <Badge variant="secondary" className="text-[10px]">
                    Done
                  </Badge>
                ) : (
                  <Badge variant="outline" className="text-[10px]">
                    Pending
                  </Badge>
                )}
              </div>
              <div className="text-[10px] text-muted-foreground truncate">{tc.toolCallId}</div>
            </button>
          ))
        )}
      </div>
    </ChatSidebarPanel>
  );
}

// Tool Detail View
function DebugToolDetailView({ debugInfo, toolCallId }: { debugInfo: DebugInfo; toolCallId: string }) {
  const { openDebug, openDebugView, workspaceSlug, sessionId, threadId } = useChatSidebar();
  const tc = debugInfo.toolCalls.find((t: any) => t.toolCallId === toolCallId);

  // Fetch job info for runCode/bash tools
  const job = useQuery(
    api.executor.getJobByToolCallId,
    threadId && tc && (tc.toolName === "runCode" || tc.toolName === "bash") ? { threadId, toolCallId } : "skip",
  );

  const requestStopJob = useMutation(api.executor.requestStopJob);

  const handleStopJob = async () => {
    if (job?._id) {
      try {
        await requestStopJob({ jobId: job._id, reason: "Stopped by user" });
        toast.success("Stop requested");
      } catch {
        toast.error("Failed to stop job");
      }
    }
  };

  if (!tc) {
    return (
      <ChatSidebarPanel title="Tool Call">
        <DebugBreadcrumb
          items={[
            { label: "Chat Thread", onClick: openDebug },
            { label: "Tool Calls", onClick: () => openDebugView("tools") },
            { label: "Not Found" },
          ]}
        />
        <p className="text-xs text-muted-foreground text-center py-4">Tool call not found</p>
      </ChatSidebarPanel>
    );
  }

  const status: "running" | "completed" | "failed" = tc.error
    ? "failed"
    : tc.result !== undefined
      ? "completed"
      : "running";
  const isRunCode = tc.toolName === "runCode";
  const isBash = tc.toolName === "bash";
  const input = tc.args as { code?: string; command?: string; description?: string } | undefined;
  const Icon = isRunCode ? CodeXmlIcon : isBash ? TerminalIcon : WrenchIcon;

  const rawOutput = tc.result;
  const output =
    typeof rawOutput === "string"
      ? rawOutput
      : rawOutput && typeof rawOutput === "object" && "output" in rawOutput
        ? String((rawOutput as any).output)
        : rawOutput != null
          ? JSON.stringify(rawOutput, null, 2)
          : undefined;

  // Determine if job can be stopped
  const canStop = job && (job.status === "pending" || job.status === "running") && !job.stopRequestedAt;

  return (
    <ChatSidebarPanel title="Tool Call" flexContent>
      <div className="flex-1 overflow-auto p-4">
        <div className="space-y-4 min-w-0">
          <DebugBreadcrumb
            items={[
              { label: "Chat Thread", onClick: openDebug },
              { label: "Tool Calls", onClick: () => openDebugView("tools") },
              { label: tc.toolName },
            ]}
          />

          <div className="flex items-center justify-between gap-2">
            <div className="flex items-center gap-2 min-w-0">
              <Icon className="size-4 text-muted-foreground shrink-0" />
              <span className="text-sm font-medium font-mono truncate">{tc.toolName}</span>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              {/* Job info hovercard for runCode/bash */}
              {(isRunCode || isBash) && job && <JobInfoHoverCard job={job} />}
              {/* Stop button for running jobs */}
              {canStop && (
                <Button
                  variant="outline"
                  size="sm"
                  onClick={handleStopJob}
                  className="h-6 px-2 text-xs gap-1 text-destructive hover:text-destructive hover:bg-destructive/10"
                >
                  <SquareIcon className="size-3" />
                  Stop
                </Button>
              )}
              <ToolStatusBadge status={status} />
            </div>
          </div>

          <div className="text-[10px] text-muted-foreground font-mono truncate">ID: {tc.toolCallId}</div>

          {isRunCode && input?.code && (
            <div className="space-y-2 min-w-0">
              <div className="flex items-center justify-between gap-2">
                <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Code</h4>
                {workspaceSlug && (
                  <Link
                    to="/workspace/$slug/playground"
                    params={{ slug: workspaceSlug }}
                    search={{ code: input.code.trim(), sessionId: sessionId ?? undefined }}
                    className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground shrink-0"
                  >
                    <ExternalLinkIcon className="size-3" />
                    Try in Playground
                  </Link>
                )}
              </div>
              <div className="max-h-[300px] overflow-auto rounded-md border border-border">
                <CodeBlock code={input.code.trim()} language="typescript" fontSize="xs">
                  <CodeBlockCopyButton className="size-6" />
                </CodeBlock>
              </div>
            </div>
          )}

          {isBash && input?.command && (
            <div className="space-y-2 min-w-0">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Command</h4>
              <div className="overflow-x-auto rounded-md border border-border bg-secondary/30 p-3">
                <code className="text-xs font-mono whitespace-pre">$ {input.command}</code>
              </div>
            </div>
          )}

          {!isRunCode && !isBash && input && (
            <div className="space-y-2 min-w-0">
              <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Arguments</h4>
              <div className="max-h-[200px] overflow-auto rounded-md border border-border bg-secondary/30 p-2">
                <JsonTree data={input} initialMaxLines={30} />
              </div>
            </div>
          )}

          <div className="space-y-2 min-w-0">
            <h4 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">Output</h4>
            <div
              className={cn(
                "max-h-[300px] overflow-auto rounded-md border p-3 font-mono text-xs whitespace-pre-wrap wrap-break-word",
                status === "failed" ? "border-red-500/30 bg-red-500/5 text-red-400" : "border-border bg-secondary/30",
              )}
            >
              {status === "running" ? (
                <span className="text-muted-foreground italic">Waiting for output...</span>
              ) : tc.error ? (
                tc.error
              ) : output ? (
                output
              ) : (
                <span className="text-muted-foreground italic">No output</span>
              )}
            </div>
          </div>
        </div>
      </div>
    </ChatSidebarPanel>
  );
}

// Job info hovercard component
function JobInfoHoverCard({ job }: { job: Doc<"jobs"> }) {
  const formatDuration = (startedAt?: number, completedAt?: number) => {
    if (!startedAt) return "N/A";
    const end = completedAt ?? Date.now();
    const durationMs = end - startedAt;
    if (durationMs < 1000) return `${durationMs}ms`;
    if (durationMs < 60000) return `${(durationMs / 1000).toFixed(1)}s`;
    return `${(durationMs / 60000).toFixed(1)}m`;
  };

  const statusColors: Record<string, string> = {
    pending: "text-yellow-500",
    running: "text-blue-500",
    completed: "text-green-500",
    failed: "text-red-500",
    canceled: "text-muted-foreground",
  };

  return (
    <HoverCard openDelay={200}>
      <HoverCardTrigger asChild>
        <button
          type="button"
          className="p-1 rounded hover:bg-muted/50 transition-colors text-muted-foreground hover:text-foreground"
        >
          <InfoIcon className="size-3.5" />
        </button>
      </HoverCardTrigger>
      <HoverCardContent align="end" className="w-72 p-3">
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-xs font-medium">Job Details</span>
            <span className={cn("text-xs font-medium capitalize", statusColors[job.status] ?? "text-muted-foreground")}>
              {job.status}
            </span>
          </div>
          <div className="space-y-1.5 text-[10px]">
            <div className="flex justify-between">
              <span className="text-muted-foreground">Job ID</span>
              <span className="font-mono truncate max-w-[140px]" title={job._id}>
                {job._id.slice(0, 8)}...
              </span>
            </div>
            <div className="flex justify-between">
              <span className="text-muted-foreground">Language</span>
              <span className="font-mono">{job.language ?? "typescript"}</span>
            </div>
            {job.workerId && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Worker</span>
                <span className="font-mono truncate max-w-[140px]" title={job.workerId}>
                  {job.workerId.slice(0, 12)}...
                </span>
              </div>
            )}
            {job.startedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Started</span>
                <span>{new Date(job.startedAt).toLocaleTimeString()}</span>
              </div>
            )}
            {job.completedAt && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Completed</span>
                <span>{new Date(job.completedAt).toLocaleTimeString()}</span>
              </div>
            )}
            <div className="flex justify-between">
              <span className="text-muted-foreground">Duration</span>
              <span>{formatDuration(job.startedAt, job.completedAt)}</span>
            </div>
            {job.timeoutMs && (
              <div className="flex justify-between">
                <span className="text-muted-foreground">Timeout</span>
                <span>{(job.timeoutMs / 1000).toFixed(0)}s</span>
              </div>
            )}
            {job.stopRequestedAt && (
              <div className="flex justify-between text-yellow-500">
                <span>Stop Requested</span>
                <span>{new Date(job.stopRequestedAt).toLocaleTimeString()}</span>
              </div>
            )}
            {job.stopReason && (
              <div className="flex justify-between text-yellow-500">
                <span>Stop Reason</span>
                <span className="truncate max-w-[140px]" title={job.stopReason}>
                  {job.stopReason}
                </span>
              </div>
            )}
          </div>
        </div>
      </HoverCardContent>
    </HoverCard>
  );
}

// Sub-Agents View
function DebugSubAgentsView({ debugInfo }: { debugInfo: DebugInfo }) {
  const { openDebug, openSubAgentConversation, subAgentThreadId, debugView } = useChatSidebar();
  const { subAgents } = debugInfo;
  const children = [...subAgents.children].sort((a: any, b: any) => (b.createdAt ?? 0) - (a.createdAt ?? 0));

  return (
    <ChatSidebarPanel title="Sub-Agents">
      <DebugBreadcrumb items={[{ label: "Chat Thread", onClick: openDebug }, { label: "Sub-Agents" }]} />
      <div className="space-y-3">
        {/* Parent Info */}
        {subAgents.parent && (
          <div className="p-3 rounded-lg border border-primary/30 bg-primary/5 space-y-2">
            <div className="flex items-center gap-2 text-xs font-medium">
              <GitBranch className="size-3" />
              Parent Thread
            </div>
            <InfoRow label="Parent Thread">
              <IdBadge id={subAgents.parent.parentThreadId} />
            </InfoRow>
            <InfoRow label="Depth">
              <span className="text-[10px]">{subAgents.parent.depth}</span>
            </InfoRow>
            <InfoRow label="Status">
              <StatusBadge status={subAgents.parent.status} />
            </InfoRow>
            <InfoRow label="Wait for Result">
              <Badge variant="outline" className="text-[10px]">
                {subAgents.parent.waitForResult ? "Yes" : "No"}
              </Badge>
            </InfoRow>
          </div>
        )}

        {/* Children */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">Child Threads ({children.length})</h4>
          {children.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">No sub-agents spawned</p>
          ) : (
            children.map((sa: any) => {
              const isSelected = debugView === "subagents" && subAgentThreadId === sa.threadId;
              const activityText = getSubAgentActivityText(sa.status);
              return (
                <button
                  key={sa._id}
                  type="button"
                  onClick={() => openSubAgentConversation(sa.threadId)}
                  className={cn(
                    "w-full rounded-md border bg-card px-3 py-2 text-left transition-colors hover:bg-muted/40",
                    isSelected && "border-primary/40 bg-muted/60",
                  )}
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <BotIcon className="size-4 text-muted-foreground" />
                      <span className="font-medium text-sm">Sub-agent</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <StatusBadge status={sa.status} />
                      <ChevronRight className="size-4 text-muted-foreground" />
                    </div>
                  </div>
                  <div className="mt-2 flex items-start gap-2 text-xs text-muted-foreground">
                    <SubAgentActivityIcon status={sa.status} />
                    <span>{activityText}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-muted-foreground">
                    Depth {sa.depth} • {sa.waitForResult ? "Waits for result" : "Detached"} •{" "}
                    {formatTimestamp(sa.createdAt)}
                  </div>
                  <div className="mt-1 font-mono text-[11px] text-muted-foreground break-all">{sa.threadId}</div>
                  {sa.error && (
                    <div className="mt-2 rounded border border-destructive/30 bg-destructive/10 p-2 text-[10px] text-destructive">
                      {sa.error}
                    </div>
                  )}
                </button>
              );
            })
          )}
        </div>
      </div>
    </ChatSidebarPanel>
  );
}

function DebugSubAgentThreadView({ debugInfo, subAgentThreadId }: { debugInfo: DebugInfo; subAgentThreadId: string }) {
  const { openDebug, openDebugView, sessionId } = useChatSidebar();
  const [activeTab, setActiveTab] = useState<"conversation" | "details">("conversation");
  const messages = useQuery(api.ai.chat.listMessages, { threadId: subAgentThreadId });
  const thread = useQuery(api.ai.chat.getThread, { threadId: subAgentThreadId });
  const subAgentRows = useQuery(api.ai.subagent.listSubAgentsForSession, sessionId ? { sessionId } : "skip");

  const selected =
    subAgentRows?.find((row) => row.threadId === subAgentThreadId) ??
    debugInfo.subAgents.children.find((row: any) => row.threadId === subAgentThreadId);
  const status = selected?.status ?? mapThreadStatusToSubAgentStatus(thread?.status);
  const isRunning = status === "initializing" || status === "running" || status === "awaiting_tool_results";
  const shortId =
    subAgentThreadId.length > 16 ? `${subAgentThreadId.slice(0, 6)}...${subAgentThreadId.slice(-6)}` : subAgentThreadId;

  return (
    <ChatSidebarPanel title="Sub-Agent" flexContent>
      <div className="border-b border-border/40 px-4 py-3">
        <DebugBreadcrumb
          items={[
            { label: "Chat Thread", onClick: openDebug },
            { label: "Sub-Agents", onClick: () => openDebugView("subagents") },
            { label: shortId },
          ]}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <BotIcon className="size-4 text-muted-foreground" />
            <span className="font-medium text-sm">Sub-Agent Conversation</span>
          </div>
          {status ? <StatusBadge status={status} /> : null}
        </div>
        <div className="mt-1 text-[11px] text-muted-foreground break-all">{subAgentThreadId}</div>
        <div className="mt-3 inline-flex items-center rounded-md bg-muted p-0.5">
          <button
            type="button"
            onClick={() => setActiveTab("conversation")}
            className={cn(
              "rounded px-2 py-1 text-xs font-medium transition-colors",
              activeTab === "conversation" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
            )}
          >
            Conversation
          </button>
          <button
            type="button"
            onClick={() => setActiveTab("details")}
            className={cn(
              "rounded px-2 py-1 text-xs font-medium transition-colors",
              activeTab === "details" ? "bg-background text-foreground shadow-sm" : "text-muted-foreground",
            )}
          >
            Details
          </button>
        </div>
      </div>
      {activeTab === "conversation" ? (
        <ChatConversationView
          messages={messages ?? []}
          sessionId={sessionId}
          isLoading={messages === undefined}
          isGenerating={isRunning}
          isError={status === "failed"}
          errorMessage={selected?.error}
          emptyStateTitle="No sub-agent messages yet"
          emptyStateDescription="This sub-agent thread has not produced messages yet."
          className="min-h-0"
          contentClassName="max-w-none px-4"
          showScrollButton={false}
        />
      ) : (
        <div className="flex-1 overflow-auto p-4">
          <div className="space-y-3">
            <div className="rounded border border-border/60 bg-card p-3 space-y-1">
              <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Thread</div>
              <InfoRow label="Thread ID">
                <IdBadge id={subAgentThreadId} />
              </InfoRow>
              <InfoRow label="Status">
                <StatusBadge status={status} />
              </InfoRow>
              <InfoRow label="Depth">
                <span className="text-[10px]">{selected?.depth ?? "N/A"}</span>
              </InfoRow>
              <InfoRow label="Wait for Result">
                <span className="text-[10px]">{selected?.waitForResult ? "Yes" : "No"}</span>
              </InfoRow>
              <InfoRow label="Profile">
                <span className="text-[10px]">{selected?.profile ?? "default"}</span>
              </InfoRow>
              <InfoRow label="Tool Policy">
                <span className="text-[10px]">{selected?.toolPolicy ?? "inherit"}</span>
              </InfoRow>
              <InfoRow label="Run Seq">
                <span className="text-[10px]">{selected?.runSeq ?? "N/A"}</span>
              </InfoRow>
            </div>

            <div className="rounded border border-border/60 bg-card p-3 space-y-1">
              <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Linkage</div>
              <InfoRow label="Parent Thread">
                <IdBadge id={selected?.parentThreadId} />
              </InfoRow>
              <InfoRow label="Tool Call">
                <IdBadge id={selected?.toolCallId} />
              </InfoRow>
              <InfoRow label="Store Transcript">
                <span className="text-[10px]">{selected?.storeTranscript ? "Yes" : "No"}</span>
              </InfoRow>
              {selected?.transcriptPath && (
                <InfoRow label="Transcript">
                  <span className="font-mono text-[10px] break-all text-right">{selected.transcriptPath}</span>
                </InfoRow>
              )}
              <InfoRow label="Created">
                <span className="text-[10px]">{formatTimestamp(selected?.createdAt)}</span>
              </InfoRow>
              <InfoRow label="Started">
                <span className="text-[10px]">{formatTimestamp(selected?.startedAt)}</span>
              </InfoRow>
              <InfoRow label="Completed">
                <span className="text-[10px]">{formatTimestamp(selected?.completedAt)}</span>
              </InfoRow>
            </div>

            {selected?.result !== undefined && (
              <div className="rounded border border-border/60 bg-card p-3">
                <div className="mb-2 text-[10px] font-medium text-muted-foreground uppercase tracking-wide">Result</div>
                <div className="max-h-[220px] overflow-auto rounded border border-border bg-secondary/30 p-2">
                  <JsonTree data={selected.result} initialMaxLines={40} />
                </div>
              </div>
            )}

            {selected?.error && (
              <div className="rounded border border-destructive/30 bg-destructive/10 p-3 text-[11px] text-destructive">
                {selected.error}
              </div>
            )}
          </div>
        </div>
      )}
    </ChatSidebarPanel>
  );
}

// Approvals View
function DebugApprovalsView({ debugInfo }: { debugInfo: DebugInfo }) {
  const { openDebug } = useChatSidebar();
  const { approvalRequests, approvals } = debugInfo;

  return (
    <ChatSidebarPanel title="Approvals">
      <DebugBreadcrumb items={[{ label: "Chat Thread", onClick: openDebug }, { label: "Approvals" }]} />
      <div className="space-y-4">
        {/* Approval Requests */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-2">
            <Shield className="size-3" />
            Approval Requests ({approvalRequests.length})
          </h4>
          {approvalRequests.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-2">No approval requests</p>
          ) : (
            approvalRequests.map((ar: any) => (
              <div key={ar._id} className="p-2 rounded bg-muted/30 border border-border/40 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-medium">{ar.action}</span>
                  <StatusBadge status={ar.status} />
                </div>
                {ar.description && <p className="text-[10px] text-muted-foreground">{ar.description}</p>}
                <InfoRow label="Reason">
                  <span className="text-[10px]">{ar.reason}</span>
                </InfoRow>
                <InfoRow label="Created">
                  <span className="text-[10px]">{formatTimestamp(ar.createdAt)}</span>
                </InfoRow>
                {ar.resolvedAt && (
                  <InfoRow label="Resolved">
                    <span className="text-[10px]">{formatTimestamp(ar.resolvedAt)}</span>
                  </InfoRow>
                )}
                {ar.resolvedBy && (
                  <InfoRow label="Resolved By">
                    <IdBadge id={ar.resolvedBy} />
                  </InfoRow>
                )}
                {ar.resolverComment && (
                  <div className="p-2 bg-muted rounded text-[10px]">
                    <span className="text-muted-foreground">Comment:</span> {ar.resolverComment}
                  </div>
                )}
                {(ar.data || ar.info) && (
                  <div className="space-y-1">
                    {ar.data && (
                      <div>
                        <span className="text-[10px] text-muted-foreground">Data:</span>
                        <div className="rounded border border-border bg-secondary/30 p-1 max-h-[80px] overflow-auto">
                          <JsonTree data={ar.data} initialMaxLines={5} />
                        </div>
                      </div>
                    )}
                    {ar.info && (
                      <div>
                        <span className="text-[10px] text-muted-foreground">Info:</span>
                        <div className="rounded border border-border bg-secondary/30 p-1 max-h-[80px] overflow-auto">
                          <JsonTree data={ar.info} initialMaxLines={5} />
                        </div>
                      </div>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>

        {/* Granted Approvals */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground flex items-center gap-2">
            <CheckCircle className="size-3 text-green-500" />
            Granted Approvals ({approvals.length})
          </h4>
          {approvals.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-2">No granted approvals</p>
          ) : (
            approvals.map((a: any) => (
              <div key={a._id} className="p-2 rounded bg-green-500/10 border border-green-500/20 space-y-2">
                <div className="flex items-center justify-between">
                  <span className="font-mono text-xs font-medium">{a.action}</span>
                  <span className="text-[10px] text-muted-foreground">{formatTimestamp(a.grantedAt)}</span>
                </div>
                <InfoRow label="Granted By">
                  <IdBadge id={a.grantedBy} />
                </InfoRow>
                {a.expiresAt && (
                  <InfoRow label="Expires">
                    <span className="text-[10px]">{formatTimestamp(a.expiresAt)}</span>
                  </InfoRow>
                )}
                {a.data && (
                  <div>
                    <span className="text-[10px] text-muted-foreground">Data:</span>
                    <div className="rounded border border-green-500/20 bg-green-500/5 p-1 max-h-[80px] overflow-auto">
                      <JsonTree data={a.data} initialMaxLines={5} />
                    </div>
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </ChatSidebarPanel>
  );
}

// Usage Records View
function DebugUsageView() {
  const { openDebug, chatId } = useChatSidebar();
  const usageData = useQuery(api.ai.chat.getChatUsageRecords, chatId ? { chatId } : "skip");

  if (!usageData) {
    return (
      <ChatSidebarPanel title="Usage Records">
        <DebugBreadcrumb items={[{ label: "Chat Thread", onClick: openDebug }, { label: "Usage Records" }]} />
        <div className="flex items-center justify-center py-8">
          <Loader2 className="size-5 animate-spin text-muted-foreground" />
        </div>
      </ChatSidebarPanel>
    );
  }

  const { cumulative, records } = usageData;

  return (
    <ChatSidebarPanel title="Usage Records">
      <DebugBreadcrumb items={[{ label: "Chat Thread", onClick: openDebug }, { label: "Usage Records" }]} />
      <div className="space-y-4">
        {/* Cumulative Totals */}
        <div className="p-3 rounded-lg border border-primary/30 bg-primary/5 space-y-1">
          <div className="text-[10px] font-medium text-muted-foreground uppercase tracking-wide">
            Cumulative ({records.length} {records.length === 1 ? "request" : "requests"})
          </div>
          <InfoRow label="Input">
            <span className="text-[10px]">{cumulative.inputTokens.toLocaleString()}</span>
          </InfoRow>
          <InfoRow label="Output">
            <span className="text-[10px]">{cumulative.outputTokens.toLocaleString()}</span>
          </InfoRow>
          <InfoRow label="Total">
            <span className="text-[10px] font-medium">{cumulative.totalTokens.toLocaleString()}</span>
          </InfoRow>
          {cumulative.reasoningTokens > 0 && (
            <InfoRow label="Reasoning">
              <span className="text-[10px]">{cumulative.reasoningTokens.toLocaleString()}</span>
            </InfoRow>
          )}
          {cumulative.cachedInputTokens > 0 && (
            <InfoRow label="Cached">
              <span className="text-[10px]">{cumulative.cachedInputTokens.toLocaleString()}</span>
            </InfoRow>
          )}
          {cumulative.cacheWriteInputTokens > 0 && (
            <InfoRow label="Cache Write">
              <span className="text-[10px]">{cumulative.cacheWriteInputTokens.toLocaleString()}</span>
            </InfoRow>
          )}
          {cumulative.cost > 0 && (
            <InfoRow label="Cost">
              <span className="text-[10px] font-medium">${cumulative.cost.toFixed(4)}</span>
            </InfoRow>
          )}
          {cumulative.marketCost > 0 && (
            <InfoRow label="Market Cost">
              <span className="text-[10px] font-medium">${cumulative.marketCost.toFixed(4)}</span>
            </InfoRow>
          )}
        </div>

        {/* Individual Records */}
        <div className="space-y-2">
          <h4 className="text-xs font-medium text-muted-foreground">Individual Requests</h4>
          {records.length === 0 ? (
            <p className="text-xs text-muted-foreground text-center py-4">No usage records</p>
          ) : (
            records.map((record) => (
              <div key={record._id} className="p-2 rounded bg-muted/30 border border-border/40 space-y-1">
                <div className="flex items-center justify-between mb-1">
                  <span className="font-mono text-[10px] font-medium truncate">{record.model}</span>
                  <span className="text-[10px] text-muted-foreground shrink-0">
                    {formatTimestamp(record._creationTime)}
                  </span>
                </div>
                {record.provider !== "n/a" && (
                  <div className="text-[10px] text-muted-foreground">via {record.provider}</div>
                )}
                <InfoRow label="Input">
                  <span className="text-[10px]">{record.inputTokens.toLocaleString()}</span>
                </InfoRow>
                <InfoRow label="Output">
                  <span className="text-[10px]">{record.outputTokens.toLocaleString()}</span>
                </InfoRow>
                <InfoRow label="Total">
                  <span className="text-[10px] font-medium">{record.totalTokens.toLocaleString()}</span>
                </InfoRow>
                {record.reasoningTokens !== undefined && (
                  <InfoRow label="Reasoning">
                    <span className="text-[10px]">{record.reasoningTokens.toLocaleString()}</span>
                  </InfoRow>
                )}
                {record.cachedInputTokens !== undefined && (
                  <InfoRow label="Cached">
                    <span className="text-[10px]">{record.cachedInputTokens.toLocaleString()}</span>
                  </InfoRow>
                )}
                {record.cacheWriteInputTokens !== undefined && (
                  <InfoRow label="Cache Write">
                    <span className="text-[10px]">{record.cacheWriteInputTokens.toLocaleString()}</span>
                  </InfoRow>
                )}
                {(record.cost !== undefined || record.marketCost !== undefined) && (
                  <div className="flex items-center gap-2 pt-1 border-t border-border/30">
                    {record.cost !== undefined && (
                      <span className="text-[10px] text-muted-foreground">
                        Cost: <span className="font-medium text-foreground">${record.cost.toFixed(4)}</span>
                      </span>
                    )}
                    {record.marketCost !== undefined && (
                      <span className="text-[10px] text-muted-foreground">
                        Market: <span className="font-medium text-foreground">${record.marketCost.toFixed(4)}</span>
                      </span>
                    )}
                  </div>
                )}
              </div>
            ))
          )}
        </div>
      </div>
    </ChatSidebarPanel>
  );
}

// Raw Data View
function DebugRawDataView({ debugInfo }: { debugInfo: DebugInfo }) {
  const { openDebug } = useChatSidebar();

  return (
    <ChatSidebarPanel title="Raw Data">
      <DebugBreadcrumb items={[{ label: "Chat Thread", onClick: openDebug }, { label: "Raw Data" }]} />
      <div className="rounded-md border border-border bg-secondary/30 p-2">
        <JsonTree data={debugInfo} initialMaxLines={100} />
      </div>
    </ChatSidebarPanel>
  );
}
