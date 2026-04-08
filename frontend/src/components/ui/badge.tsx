"use client";

import { cn } from "@/lib/utils";

export function Badge({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded-full border border-accent/15 bg-accentSoft px-3 py-1 text-xs font-medium text-accent",
        className,
      )}
    >
      {children}
    </span>
  );
}
