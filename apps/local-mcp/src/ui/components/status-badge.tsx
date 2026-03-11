import { Badge } from "@/ui/components/ui/badge";
import { cn } from "@/ui/lib/utils";

type StatusBadgeProps = {
  status: string;
  className?: string;
};

const statusVariants: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  pending: "outline",
  approved: "default",
  configured: "default",
  denied: "destructive",
  missing: "destructive",
  unsupported: "destructive",
};

export function StatusBadge({ status, className }: StatusBadgeProps) {
  const variant = statusVariants[status] ?? "secondary";
  return (
    <Badge variant={variant} className={cn("capitalize", className)}>
      {status}
    </Badge>
  );
}
