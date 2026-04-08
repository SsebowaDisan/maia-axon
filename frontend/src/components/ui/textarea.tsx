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
        "w-full resize-none rounded-[24px] border bg-white/75 px-4 py-3 text-sm text-ink outline-none transition placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 dark:bg-panel/90",
        className,
      )}
      {...props}
    />
  );
});

Textarea.displayName = "Textarea";
