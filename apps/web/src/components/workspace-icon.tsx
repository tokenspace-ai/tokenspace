import { useState } from "react";
import { cn } from "@/lib/utils";

type WorkspaceIconProps = {
  name: string;
  iconUrl?: string | null;
  alt?: string;
  className?: string;
  imageClassName?: string;
  fallbackClassName?: string;
};

export function WorkspaceIcon({
  name,
  iconUrl,
  alt = "",
  className,
  imageClassName,
  fallbackClassName,
}: WorkspaceIconProps) {
  const [erroredUrl, setErroredUrl] = useState<string | null>(null);

  const showImage = Boolean(iconUrl) && iconUrl !== erroredUrl;
  const initial = (Array.from(name.trim())[0] ?? "?").toUpperCase();

  return (
    <div className={cn("shrink-0 overflow-hidden rounded-md", className)}>
      {showImage ? (
        <img
          src={iconUrl ?? undefined}
          alt={alt}
          className={cn("size-full object-cover", imageClassName)}
          onError={() => setErroredUrl(iconUrl ?? null)}
        />
      ) : (
        <div className={cn("flex size-full items-center justify-center bg-primary/10 text-primary", fallbackClassName)}>
          <span className="text-[0.8em] font-semibold leading-none uppercase">{initial}</span>
        </div>
      )}
    </div>
  );
}
