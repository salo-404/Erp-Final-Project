interface LoadingSpinnerProps {
  label?: string;
}

export function LoadingSpinner({ label }: LoadingSpinnerProps) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 p-8">
      <div
        className="h-8 w-8 animate-spin rounded-full border-2 border-[var(--color-border)] border-t-[var(--color-accent)]"
        role="status"
        aria-label={label ?? "Loading"}
      />
      {label && <p className="text-sm text-[var(--color-text-muted)]">{label}</p>}
    </div>
  );
}
