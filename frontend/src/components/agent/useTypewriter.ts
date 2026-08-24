import { useEffect, useRef, useState } from "react";

// Guarantees a reveal takes at least this long, however short the text is —
// this is what makes a fast/short answer (which can arrive as a single
// network chunk in ~100ms) still visibly "type in" instead of popping in
// whole. For text that naturally arrives over a longer real span (a table
// streamed across many chunks), the rate recomputes from the current,
// growing target length each tick, so it stays comfortably ahead of real
// arrival and never introduces artificial lag there.
const MIN_REVEAL_SECONDS = 1.4;

// Paces the reveal of `target` at a rate derived from its own length, rather
// than rendering it the instant it arrives. `active` false renders the full
// target immediately (used once a message is no longer the live/settling
// tail — see ConversationView).
export function useTypewriter(target: string, active: boolean): string {
  const [displayed, setDisplayed] = useState(() => (active ? "" : target));
  const rafRef = useRef<number | undefined>(undefined);
  const lastTimeRef = useRef<number | undefined>(undefined);
  const carryRef = useRef(0);

  useEffect(() => {
    if (!active) {
      setDisplayed(target);
      return;
    }

    function tick(time: number) {
      setDisplayed((prev) => {
        if (prev.length >= target.length) return prev === target ? prev : target;
        const last = lastTimeRef.current ?? time;
        const elapsedSeconds = (time - last) / 1000;
        lastTimeRef.current = time;
        const rate = target.length / MIN_REVEAL_SECONDS;
        const budget = carryRef.current + elapsedSeconds * rate;
        const whole = Math.floor(budget);
        carryRef.current = budget - whole;
        if (whole <= 0) return prev;
        return target.slice(0, Math.min(target.length, prev.length + whole));
      });
      rafRef.current = requestAnimationFrame(tick);
    }

    lastTimeRef.current = undefined;
    rafRef.current = requestAnimationFrame(tick);
    return () => {
      if (rafRef.current !== undefined) cancelAnimationFrame(rafRef.current);
    };
  }, [target, active]);

  return active ? displayed : target;
}
