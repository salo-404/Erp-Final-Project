import { useCallback, useEffect, useRef, useState, type DependencyList } from "react";
import { ApiError } from "./api-client";

interface FetchState<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
  errorStatus: number | null;
}

// Minimal hand-rolled data-fetching hook (no TanStack Query dependency) —
// re-runs whenever `deps` changes, ignores results from a stale run.
export function useFetch<T>(fetcher: () => Promise<T>, deps: DependencyList): FetchState<T> & { refetch: () => void } {
  const [state, setState] = useState<FetchState<T>>({ data: null, loading: true, error: null, errorStatus: null });
  const requestId = useRef(0);

  const run = useCallback(() => {
    const id = ++requestId.current;
    setState((s) => ({ ...s, loading: true, error: null, errorStatus: null }));
    fetcher()
      .then((data) => {
        if (id === requestId.current) setState({ data, loading: false, error: null, errorStatus: null });
      })
      .catch((err) => {
        if (id === requestId.current) {
          setState({
            data: null,
            loading: false,
            error: err instanceof ApiError ? err.message : "Something went wrong. Please try again.",
            errorStatus: err instanceof ApiError ? err.statusCode : null,
          });
        }
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  useEffect(() => {
    run();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  return { ...state, refetch: run };
}
