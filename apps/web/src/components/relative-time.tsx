import { useNow } from "@/hooks/use-now";

export function RelativeTime({ timestamp }: { timestamp: number }) {
  const now = useNow();
  const diff = now - timestamp;
  const diffInMinutes = Math.floor(diff / 1000 / 60);
  const diffInHours = Math.floor(diff / 1000 / 60 / 60);
  const diffInDays = Math.floor(diff / 1000 / 60 / 60 / 24);
  if (diffInDays > 0) {
    return <span>{diffInDays}d ago</span>;
  }
  if (diffInHours > 0) {
    return <span>{diffInHours}h ago</span>;
  }
  if (diffInMinutes > 0) {
    return <span>{diffInMinutes}m ago</span>;
  }
  return <span>just now</span>;
}

/**
 * Compact time display for sidebar items
 * Returns: "now", "5m", "2h", "3d", "2w", "1mo"
 */
export function CompactTime({ timestamp }: { timestamp: number }) {
  const now = useNow();
  const diff = now - timestamp;
  const diffInMinutes = Math.floor(diff / 1000 / 60);
  const diffInHours = Math.floor(diff / 1000 / 60 / 60);
  const diffInDays = Math.floor(diff / 1000 / 60 / 60 / 24);
  const diffInWeeks = Math.floor(diffInDays / 7);
  const diffInMonths = Math.floor(diffInDays / 30);

  if (diffInMonths > 0) {
    return <span>{diffInMonths}mo</span>;
  }
  if (diffInWeeks > 0) {
    return <span>{diffInWeeks}w</span>;
  }
  if (diffInDays > 0) {
    return <span>{diffInDays}d</span>;
  }
  if (diffInHours > 0) {
    return <span>{diffInHours}h</span>;
  }
  if (diffInMinutes > 0) {
    return <span>{diffInMinutes}m</span>;
  }
  return <span>now</span>;
}
