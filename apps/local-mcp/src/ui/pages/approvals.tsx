import { ApprovalCard } from "@/ui/components/approval-card";
import { Card, CardContent } from "@/ui/components/ui/card";
import { useApprovals, useNonce } from "@/ui/hooks/use-api";

export function ApprovalsPage() {
  const approvals = useApprovals();
  const nonceResult = useNonce();

  return (
    <section>
      <div className="flex items-baseline justify-between mb-4">
        <h2 className="text-lg font-semibold">Approval Requests</h2>
        <span className="text-sm text-muted-foreground">
          {approvals.data?.length ?? 0} request{approvals.data?.length === 1 ? "" : "s"}
        </span>
      </div>

      {approvals.error && (
        <Card className="mb-4">
          <CardContent className="pt-6">
            <p className="text-sm text-destructive">Failed to load approvals: {approvals.error}</p>
          </CardContent>
        </Card>
      )}

      {approvals.data?.length === 0 && (
        <p className="text-sm italic text-muted-foreground">No approval requests yet.</p>
      )}

      <div className="space-y-3">
        {approvals.data?.map((request) => (
          <ApprovalCard
            key={request.requestId}
            request={request}
            nonce={nonceResult.data}
            onMutated={() => void approvals.refresh()}
            linkTo={`/approvals/${encodeURIComponent(request.requestId)}`}
          />
        ))}
      </div>
    </section>
  );
}
