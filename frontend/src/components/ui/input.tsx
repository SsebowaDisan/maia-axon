"use client";

import * as React from "react";

import { cn } from "@/lib/utils";

export const Input = React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
  ({ className, ...props }, ref) => {
    return (
      <input
        ref={ref}
        className={cn(
          "h-11 w-full rounded-[18px] border border-black/[0.08] bg-white px-4 text-sm text-ink outline-none transition placeholder:text-muted focus:border-accent/35 focus:ring-4 focus:ring-accent/10 dark:bg-panel/80",
          className,
        )}
        {...props}
      />
    );
  },
);

Input.displayName = "Input";
