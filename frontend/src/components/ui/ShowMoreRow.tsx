interface ShowMoreRowProps {
  colSpan: number;
  shown: number;
  total: number;
  canShowLess: boolean;
  onShowMore: () => void;
  onShowLess: () => void;
}

const buttonStyle: React.CSSProperties = { fontSize: 12.5, fontWeight: 600, color: "var(--color-accent)", background: "none", border: "none", cursor: "pointer", padding: 0 };

/** A `<tr>` footer for tables using useShowMore() — "Show more" while there's more to reveal, then "Show less" once fully expanded to collapse back to the first page. Renders nothing when there was never more than the first page to begin with. */
export function ShowMoreRow({ colSpan, shown, total, canShowLess, onShowMore, onShowLess }: ShowMoreRowProps) {
  if (shown >= total) {
    if (!canShowLess) return null;
    return (
      <tr>
        <td colSpan={colSpan} style={{ padding: "12px 20px", textAlign: "center", borderTop: "1px solid var(--color-border)" }}>
          <button type="button" onClick={onShowLess} style={buttonStyle}>
            Show less
          </button>
        </td>
      </tr>
    );
  }

  return (
    <tr>
      <td colSpan={colSpan} style={{ padding: "12px 20px", textAlign: "center", borderTop: "1px solid var(--color-border)" }}>
        <button type="button" onClick={onShowMore} style={buttonStyle}>
          Show more ({total - shown} remaining)
        </button>
      </td>
    </tr>
  );
}
