import { useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";

/**
 * The query string as the single store for view state.
 *
 * Every page here keeps its tabs, filters, search and open panel in the URL, so
 * "the flaky ones on !412 over 90 days" is a link rather than a description of
 * how to reproduce a screen. These helpers exist because doing that by hand is
 * four lines of `URLSearchParams` copying per page, and getting the push/replace
 * decision wrong is what makes the Back button useless.
 */

export type UrlPatch = Record<string, string | null>;

/**
 * Merges keys into the query string; a `null` value removes one.
 *
 * `replace` defaults to true: most patches are view toggles, and a filter that
 * pushes a history entry per change turns Back into "undo my last click"
 * instead of "go back". Pass `{ replace: false }` for the ones that open
 * something, so Back closes it.
 */
export function useUrlPatch(): (patch: UrlPatch, options?: { replace?: boolean }) => void {
  const [, setParams] = useSearchParams();

  return useCallback(
    (patch: UrlPatch, { replace = true }: { replace?: boolean } = {}) => {
      setParams(
        (previous) => {
          const next = new URLSearchParams(previous);
          for (const [key, value] of Object.entries(patch)) {
            if (value === null) next.delete(key);
            else next.set(key, value);
          }
          return next;
        },
        { replace },
      );
    },
    [setParams],
  );
}

/**
 * A text input that writes to the URL once the typing stops.
 *
 * Bound straight to the query string, every keystroke would be a navigation and
 * a refetch. The draft is local; the URL catches up on the pause.
 */
export function useDebouncedInput(
  committed: string,
  commit: (value: string) => void,
  delayMs = 300,
): [string, (value: string) => void] {
  const [draft, setDraft] = useState(committed);

  // Keeps the box in step when the URL changes from outside — a Back press, or
  // a link that arrives with a different search on it.
  useEffect(() => setDraft(committed), [committed]);

  useEffect(() => {
    if (draft === committed) return;
    const id = window.setTimeout(() => commit(draft), delayMs);
    return () => window.clearTimeout(id);
  }, [draft, committed, delayMs]);

  return [draft, setDraft];
}
