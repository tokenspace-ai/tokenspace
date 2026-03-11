import { ArrowLeft } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ApprovalCard } from "@/ui/components/approval-card";
import { Button } from "@/ui/components/ui/button";
import { Card, CardContent } from "@/ui/components/ui/card";
import { useNonce } from "@/ui/hooks/use-api";
import type { ApprovalRequest } from "@/ui/lib/types";

export function ApprovalDetail() {
  const { requestId: rawRequestId } = useParams<{ requestId: string }>();
  const requestId = rawRequestId ? decodeURIComponent(rawRequestId) : "";
  const navigate = useNavigate();

  const [request, setRequest] = useState<ApprovalRequest | null>(null);
  const [error, setError] = useState<string | null>(null);
  const nonceResult = useNonce();

  const fetchRequest = useCallback(async () => {
    try {
      const res = await fetch("/api/approvals");
      if (!res.ok) throw new Error(`${res.status}`);
      const body = (await res.json()) as { approvals: ApprovalRequest[] };
      const found = body.approvals.find((a) => a.requestId === requestId);
      if (found) {
        setRequest(found);
        setError(null);
      } else {
        setRequest(null);
        setError("Approval request not found.");
      }
    } catch (err) {
      setRequest(null);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [requestId]);

  useEffect(() => {
    void fetchRequest();
    const id = setInterval(() => void fetchRequest(), 3000);
    return () => clearInterval(id);
  }, [fetchRequest]);

  return (
    <>
      <div className="mb-6">
        <Button variant="ghost" size="sm" onClick={() => navigate("/approvals")}>
          <ArrowLeft className="size-4" />
          Back to approvals
        </Button>
      </div>

      {error && (
        <Card>
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">{error}</p>
          </CardContent>
        </Card>
      )}

      {request && (
        <ApprovalCard request={request} nonce={nonceResult.data} onMutated={() => void fetchRequest()} detailed />
      )}
    </>
  );
}
