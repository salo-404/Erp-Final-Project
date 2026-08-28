import { useMemo, useState } from "react";

/** Slices `items` to a growing count, for "Show more" expand-in-place tables. The expanded count persists across re-renders (e.g. switching a filter doesn't collapse it back down) — slice() naturally clamps to whatever length `items` currently has. */
export function useShowMore<T>(items: T[], initialCount = 10, step = 10) {
  const [count, setCount] = useState(initialCount);

  const visible = useMemo(() => items.slice(0, count), [items, count]);
  const hasMore = count < items.length;
  /** True once expanded past the initial page — lets the caller offer "Show less" back to the original count. */
  const canShowLess = count > initialCount;

  function showMore() {
    setCount((c) => c + step);
  }

  function showLess() {
    setCount(initialCount);
  }

  return { visible, hasMore, canShowLess, shown: visible.length, total: items.length, showMore, showLess };
}
