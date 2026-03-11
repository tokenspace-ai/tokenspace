import { useQuery } from "@tanstack/react-query";
import { api } from "@tokenspace/backend/convex/_generated/api";
import { useAction } from "convex/react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { cn } from "@/lib/utils";
import { useWorkspaceContext } from "@/routes/_app/workspace.$slug";

type UserDisplayMode = "full" | "avatar";

type UserDisplayProps = {
  userId: string;
  mode?: UserDisplayMode;
  className?: string;
  avatarClassName?: string;
};

function getDisplayName({
  firstName,
  lastName,
  email,
  userId,
}: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  userId: string;
}): string {
  const fullName = [firstName, lastName].filter(Boolean).join(" ").trim();
  if (fullName) {
    return fullName;
  }
  if (email) {
    return email;
  }
  return userId;
}

function getInitials({
  firstName,
  lastName,
  email,
  userId,
}: {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  userId: string;
}): string {
  if (firstName && lastName) {
    return `${firstName[0]}${lastName[0]}`.toUpperCase();
  }
  if (firstName) {
    return firstName[0].toUpperCase();
  }
  if (email) {
    return email[0].toUpperCase();
  }
  return userId[0]?.toUpperCase() ?? "U";
}

export function UserDisplay({ userId, mode = "full", className, avatarClassName }: UserDisplayProps) {
  const { workspaceId } = useWorkspaceContext();
  const getUserDetails = useAction(api.users.userDetails);
  const { data: user } = useQuery({
    queryKey: ["user-details", workspaceId, userId],
    queryFn: () => getUserDetails({ workspaceId, userId }),
    enabled: Boolean(userId),
    staleTime: 5 * 60 * 1000,
  });

  const displayName = getDisplayName({
    firstName: user?.firstName,
    lastName: user?.lastName,
    email: user?.email,
    userId,
  });
  const initials = getInitials({
    firstName: user?.firstName,
    lastName: user?.lastName,
    email: user?.email,
    userId,
  });

  if (mode === "avatar") {
    return (
      <Avatar className={cn("size-7", avatarClassName)} title={user?.email ?? displayName}>
        {user?.profilePictureUrl && <AvatarImage src={user.profilePictureUrl} alt={displayName} />}
        <AvatarFallback className="text-xs">{initials}</AvatarFallback>
      </Avatar>
    );
  }

  return (
    <div className={cn("flex items-center gap-2 min-w-0", className)}>
      <Avatar className={cn("size-7 shrink-0", avatarClassName)}>
        {user?.profilePictureUrl && (
          <AvatarImage src={user.profilePictureUrl} alt={displayName} title={user?.email ?? displayName} />
        )}
        <AvatarFallback className="text-xs">{initials}</AvatarFallback>
      </Avatar>
      <span className="truncate">{displayName}</span>
    </div>
  );
}
