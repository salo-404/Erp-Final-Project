interface ShowMoreRowProps {
  colSpan: number;
  shown: number;
  total: number;
  onShowMore: () => void;
}

/** A `<tr>` footer for tables using useShowMore() — renders nothing once everything is already shown. */
export function ShowMoreRow({ colSpan, shown, total, onShowMore }: ShowMoreRowProps) {
  if (shown >= total) return null;
  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: "12px 20px", textAlign: "center", borderTop: "1px solid var(--color-border)" }}>
        <button
          type="button"
          onClick={onShowMore}
          style={{ fontSize: 12.5, fontWeight: 600, color: "var(--color-accent)", background: "none", border: "none", cursor: "pointer", padding: 0 }}
        >
          Show more ({total - shown} remaining)
        </button>
      </td>
    </tr>
  );
}
