"use client";

import React from "react";

import { Button } from "@/components/ui/button";

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: React.ErrorInfo | null;
}

export class ErrorBoundary extends React.Component<
  React.PropsWithChildren,
  ErrorBoundaryState
> {
  constructor(props: React.PropsWithChildren) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: null };
  }

  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error, errorInfo: null };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo) {
    // Surface the real cause so we can fix it instead of staring at a generic
    // fallback. Always logs to the console; the message is also rendered
    // inline below in dev so the user doesn't have to open devtools.
    console.error("[ErrorBoundary]", error, errorInfo);
    this.setState({ errorInfo });
  }

  render() {
    if (this.state.hasError) {
      const isDev = process.env.NODE_ENV !== "production";
      return (
        <div className="flex h-full min-h-[300px] flex-col items-center justify-center gap-4 rounded-[28px] border border-danger/20 bg-danger/5 p-8 text-center">
          <p className="font-display text-lg text-danger">The interface hit an unexpected error.</p>
          {isDev && this.state.error ? (
            <details className="max-w-3xl text-left text-xs text-danger/80" open>
              <summary className="cursor-pointer font-medium">
                {this.state.error.name}: {this.state.error.message}
              </summary>
              <pre className="mt-2 max-h-[280px] overflow-auto whitespace-pre-wrap rounded-md bg-white/60 p-3 font-mono text-[11px] leading-5">
                {this.state.error.stack}
                {this.state.errorInfo?.componentStack}
              </pre>
            </details>
          ) : null}
          <Button variant="secondary" onClick={() => window.location.reload()}>
            Reload
          </Button>
        </div>
      );
    }

    return this.props.children;
  }
}
