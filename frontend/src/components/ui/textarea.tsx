"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export const Textarea = React.forwardRef<
  HTMLTextAreaElement,
  React.TextareaHTMLAttributes<HTMLTextAreaElement>
>(({ className, ...props }, ref) => {
  return (
    <textarea
      ref={ref}
      className={cn(
        "w-full resize-none overflow-hidden rounded-[22px] border border-black/[0.08] bg-white px-4 py-3 text-sm text-ink outline-none transition placeholder:text-muted focus:border-accent/35 focus:ring-4 focus:ring-accent/10 dark:bg-panel/90",
        className,
      )}
      {...props}
    />
  );
});

Textarea.displayName = "Textarea";
