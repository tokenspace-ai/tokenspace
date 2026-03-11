import { CheckCircle, XCircle } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router-dom";
import { Button } from "@/ui/components/ui/button";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "@/ui/components/ui/card";
import { approveRequest, denyRequest } from "@/ui/hooks/use-api";
import type { ApprovalRequest } from "@/ui/lib/types";
import { StatusBadge } from "./status-badge";

type ApprovalCardProps = {
  request: ApprovalRequest;
  nonce: string | null;
  onMutated: () => void;
  linkTo?: string;
  detailed?: boolean;
};

export function ApprovalCard({ request, nonce, onMutated, linkTo, detailed = false }: ApprovalCardProps) {
  const [acting, setActing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleApprove = async () => {
    if (!nonce) return;
    setActing(true);
    setError(null);
    try {
      await approveRequest(request.requestId, nonce);
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  const handleDeny = async () => {
    if (!nonce) return;
    setActing(true);
    setError(null);
    try {
      await denyRequest(request.requestId, nonce);
      onMutated();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setActing(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <div>
          <p className="text-xs uppercase tracking-wide text-muted-foreground mb-1">Approval Request</p>
          <CardTitle>
            {linkTo ? (
              <Link to={linkTo} className="text-left hover:text-primary transition-colors">
                {request.action}
              </Link>
            ) : (
              request.action
            )}
          </CardTitle>
          {(request.description ?? request.reason) && (
            <p className="text-sm text-muted-foreground mt-1">{request.description ?? request.reason}</p>
          )}
        </div>
        <CardAction>
          <StatusBadge status={request.status} />
        </CardAction>
      </CardHeader>

      <CardContent className="space-y-4">
        <div className="grid gap-3 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <MetaItem label="Request ID" value={request.requestId} />
          <MetaItem label="Created" value={request.createdAt} />
          <MetaItem label="Resolved" value={request.resolvedAt ?? "Pending"} />
          <MetaItem label="Resolution" value={request.resolvedVia ?? "Pending"} />
        </div>

        {detailed && (
          <>
            <PreSection label="Reason" content={request.reason} />
            <PreSection label="Data" content={JSON.stringify(request.data ?? null, null, 2)} />
            <PreSection label="Info" content={JSON.stringify(request.info ?? null, null, 2)} />
          </>
        )}

        {request.status === "pending" && (
          <div className="flex gap-2">
            <Button size="sm" disabled={acting || !nonce} onClick={handleApprove}>
              <CheckCircle className="size-4" />
              Approve
            </Button>
            <Button variant="destructive" size="sm" disabled={acting || !nonce} onClick={handleDeny}>
              <XCircle className="size-4" />
              Deny
            </Button>
          </div>
        )}

        {error && <p className="text-sm text-destructive">{error}</p>}
      </CardContent>
    </Card>
  );
}

function MetaItem({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs uppercase tracking-wide text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 break-all font-mono text-xs">{value}</dd>
    </div>
  );
}

function PreSection({ label, content }: { label: string; content: string }) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs uppercase tracking-wide text-muted-foreground">{label}</h4>
      <pre className="overflow-x-auto rounded-md bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-all">
        {content}
      </pre>
    </div>
  );
}
