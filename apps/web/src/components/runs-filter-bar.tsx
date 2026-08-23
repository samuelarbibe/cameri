import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { FilterBar, type FilterSelectProps } from "@/components/filter-bar";
import { RUN_STATUS_LABELS, type RunStatus } from "@/components/run-status-badge";
import { useDebouncedInput, useUrlPatch } from "@/lib/url-state";
import { trpc } from "@/trpc";

/** Mirrors the server's sentinel in `runs.list`. */
export const NO_MERGE_REQUEST = "none";

export type RunFilters = {
  q: string;
  status: string | null;
  branch: string | null;
  mrIid: string | null;
};

/**
 * Reads the runs filters out of the query string.
 *
 * A hook rather than a prop chain, because two pages ask the same question —
 * the runs list and a merge request's Runs tab — and both feed the answer
 * straight into `runs.list`.
 */
export function useRunFilters(): RunFilters {
  const [params] = useSearchParams();
  return {
    q: params.get("q") ?? "",
    status: params.get("status"),
    branch: params.get("branch"),
    mrIid: params.get("mr"),
  };
}

/** The filters as `runs.list` wants them: set keys only, empties dropped. */
export function toRunsQuery(filters: RunFilters): {
  search?: string;
  status?: RunStatus;
  branch?: string;
  mrIid?: string;
} {
  return {
    ...(filters.q ? { search: filters.q } : {}),
    // Straight off the URL, so it has to be checked rather than asserted: a
    // hand-edited `?status=nonsense` would otherwise be a 400 from the server.
    ...(isRunStatus(filters.status) ? { status: filters.status } : {}),
    ...(filters.branch ? { branch: filters.branch } : {}),
    ...(filters.mrIid ? { mrIid: filters.mrIid } : {}),
  };
}

function isRunStatus(value: string | null): value is RunStatus {
  return value !== null && value in RUN_STATUS_LABELS;
}

/**
 * Search, status, branch and merge request — the four questions people bring to
 * a runs list.
 *
 * The dropdown contents come from `runs.filters`, which reads them off the runs
 * that exist, so a branch that was deleted six months ago is not offered.
 */
export function RunsFilterBar({
  projectSlug,
  filters,
  /** Hidden on a page already scoped to one merge request. */
  showMergeRequest = true,
}: {
  projectSlug: string;
  filters: RunFilters;
  showMergeRequest?: boolean;
}) {
  const patch = useUrlPatch();
  const [draft, setDraft] = useDebouncedInput(filters.q, (value) =>
    patch({ q: value || null }),
  );

  const options = useQuery({
    queryKey: ["run-filters", projectSlug],
    queryFn: () => trpc.runs.filters.query({ projectSlug }),
    enabled: projectSlug !== "",
    // The menus only need to be roughly current, and this fires alongside the
    // list on every page load.
    staleTime: 60_000,
  });

  const selects: FilterSelectProps[] = [
    {
      label: "Status",
      value: filters.status,
      anyLabel: "Any status",
      onChange: (value) => patch({ status: value }),
      options: Object.entries(RUN_STATUS_LABELS).map(([value, label]) => ({ value, label })),
    },
    {
      label: "Branch",
      value: filters.branch,
      anyLabel: "All branches",
      onChange: (value) => patch({ branch: value }),
      options: (options.data?.branches ?? []).map((row) => ({
        value: row.branch,
        label: row.branch,
      })),
      emptyLabel: "No branches recorded",
    },
  ];

  if (showMergeRequest) {
    selects.push({
      label: "MR",
      value: filters.mrIid,
      anyLabel: "Any pipeline",
      onChange: (value) => patch({ mr: value }),
      options: [
        // Not a merge request, but the same axis: "just the branch pipelines"
        // belongs in this menu rather than as a checkbox beside it.
        { value: NO_MERGE_REQUEST, label: "No merge request", hint: "Branch pipelines only" },
        ...(options.data?.mergeRequests ?? []).map((row) => ({
          value: row.iid,
          label: `!${row.iid}`,
          ...(row.title ? { hint: row.title } : {}),
        })),
      ],
    });
  }

  const active = Boolean(
    filters.q || filters.status || filters.branch || (showMergeRequest && filters.mrIid),
  );

  return (
    <FilterBar
      search={draft}
      onSearchChange={setDraft}
      searchPlaceholder="Search runs, branches, commits…"
      filters={selects}
      onClear={
        active
          ? () =>
              patch({
                q: null,
                status: null,
                branch: null,
                ...(showMergeRequest ? { mr: null } : {}),
              })
          : undefined
      }
    />
  );
}
