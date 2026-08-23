import { useMemo, useState } from "react";

/** Slices `items` to a growing count, for "Show more" expand-in-place tables. The expanded count persists across re-renders (e.g. switching a filter doesn't collapse it back down) — slice() naturally clamps to whatever length `items` currently has. */
export function useShowMore<T>(items: T[], initialCount = 10, step = 10) {
  const [count, setCount] = useState(initialCount);

  const visible = useMemo(() => items.slice(0, count), [items, count]);
  const hasMore = count < items.length;

  function showMore() {
    setCount((c) => c + step);
  }

  return { visible, hasMore, shown: visible.length, total: items.length, showMore };
}
