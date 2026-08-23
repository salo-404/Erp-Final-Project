import { Component, type ErrorInfo, type ReactNode } from "react";

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  error: Error | null;
}

export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { error: null };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("Unhandled error in UI tree:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="flex h-screen w-screen flex-col items-center justify-center gap-4 bg-[var(--color-bg)] p-8 text-center">
          <h1 className="font-[var(--font-heading)] text-xl font-semibold text-[var(--color-text)]">
            Something went wrong
          </h1>
          <p className="max-w-md text-sm text-[var(--color-text-muted)]">{this.state.error.message}</p>
          <button
            type="button"
            onClick={() => this.setState({ error: null })}
            className="rounded-md bg-[var(--color-accent)] px-4 py-2 text-sm font-medium text-white"
          >
            Try again
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}
