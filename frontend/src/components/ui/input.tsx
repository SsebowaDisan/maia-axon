"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "h-11 w-full rounded-2xl border bg-white/70 px-4 text-sm text-ink outline-none transition placeholder:text-muted focus:border-accent focus:ring-2 focus:ring-accent/20 dark:bg-panel/80",
          className,
        )}
        {...props}
      />
    );
  },
);

Input.displayName = "Input";
