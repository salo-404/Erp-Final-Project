import { Link } from "react-router-dom";

export function NotFoundPage() {
  return (
    <div className="flex h-screen w-screen flex-col items-center justify-center gap-3 bg-[var(--color-bg)] text-center">
      <h1 className="font-[var(--font-heading)] text-2xl font-bold text-[var(--color-text)]">404</h1>
      <p className="text-sm text-[var(--color-text-muted)]">This page doesn't exist.</p>
      <Link to="/" className="text-sm font-medium text-[var(--color-accent)] hover:underline">
        Back to Control Tower
      </Link>
    </div>
  );
}
