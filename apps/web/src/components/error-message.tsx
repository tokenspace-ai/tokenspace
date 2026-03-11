import { AlertCircle } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { isKnownError } from "@/lib/error";
import { cn } from "@/lib/utils";

interface ErrorMessageProps {
  title?: ReactNode;
  message?: ReactNode;
  error?: Error;
  className?: string;
  forceDisplayUnknownError?: boolean;
  compact?: boolean;
  actions?: ReactNode;
}

export function ErrorMessage({
  title = "Error",
  error,
  message,
  className,
  forceDisplayUnknownError,
  compact,
  actions,
}: ErrorMessageProps) {
  const resolvedMessage =
    message ??
    (error && (forceDisplayUnknownError || isKnownError(error) ? error.message : undefined)) ??
    "Something went wrong";
  return (
    <div
      className={cn("w-full flex items-center justify-center", !compact && "p-20", className)}
      data-test="error-message"
    >
      <Alert className="w-[700px]" variant="destructive">
        <AlertCircle className="h-4 w-4" />
        <AlertTitle>{title}</AlertTitle>
        <AlertDescription className="font-mono text-xs">{resolvedMessage}</AlertDescription>
        {actions}
      </Alert>
    </div>
  );
}
