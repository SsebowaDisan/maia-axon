"use client";

import { cn } from "@/lib/utils";

export function Panel({
  className,
  children,
}: {
  className?: string;
  children: React.ReactNode;
}) {
  return <section className={cn("panel-surface h-full", className)}>{children}</section>;
}
