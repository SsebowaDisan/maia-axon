"use client";

import React from "react";

import { Button } from "@/components/ui/button";

interface ErrorBoundaryState {
  hasError: boolean;
}

export class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  ErrorBoundaryState
> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  render() {
    if (this.state.hasError) {
      return (
        <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-4 rounded-[28px] border border-danger/20 bg-danger/5 p-8 text-center">
          <p className="font-display text-lg text-danger">The interface hit an unexpected error.</p>
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
