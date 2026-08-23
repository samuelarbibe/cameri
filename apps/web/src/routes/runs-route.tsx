import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { RunsFilterBar, toRunsQuery, useRunFilters } from "@/components/runs-filter-bar";
import { RunsTable } from "@/components/runs-table";
import { trpc } from "@/trpc";

export function RunsRoute() {
  const { projectSlug: slug = "" } = useParams();
  const filters = useRunFilters();
  const query = toRunsQuery(filters);

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => trpc.projects.list.query(),
  });

  const runs = useQuery({
    // The filters are part of the key: they are applied server-side, so each
    // combination is a different response rather than a view of one list.
    queryKey: ["runs", slug, query],
    queryFn: () => trpc.runs.list.query({ projectSlug: slug, limit: 100, ...query }),
    enabled: slug !== "",
    // Runs are live while CI is going. Polling is the placeholder; SSE off the
    // shard-completion path is the real answer.
    refetchInterval: 5_000,
    // Without this the table empties on every filter change and the page jumps.
    placeholderData: (previous) => previous,
  });

  const noProjects = projects.data?.length === 0;
  const unknownProject = projects.data !== undefined && !projects.data.some((p) => p.slug === slug);
  const filtered = Object.keys(query).length > 0;

  return (
    <div className="flex flex-1 flex-col gap-4">
      <div className="flex flex-wrap items-center gap-3">
        <div>
          <h1 className="text-lg font-semibold tracking-tight">Runs</h1>
          <p className="text-muted-foreground text-sm">
            {runs.isLoading ? "Loading…" : `${runs.data?.length ?? 0} runs`}
            {filtered ? " matching" : ""}
          </p>
        </div>
      </div>

      <RunsFilterBar projectSlug={slug} filters={filters} />

      <RunsTable
        runs={runs.data ?? []}
        isLoading={projects.isLoading || (slug !== "" && runs.isLoading)}
        error={projects.error ?? runs.error}
        emptyState={
          noProjects ? (
            <EmptyState
              title="No projects yet"
              body="Create a project and a record key, then point a reporter at this server."
            />
          ) : unknownProject ? (
            <EmptyState
              title={`No project called “${slug}”`}
              body="Pick one from the sidebar, or check the link you followed."
            />
          ) : filtered ? (
            <EmptyState
              title="No runs match these filters"
              body="Clear one of them, or widen the search."
            />
          ) : (
            <EmptyState
              title="No runs recorded"
              body="Run your suite with CAMERI_RECORD_KEY set and results will land here."
            />
          )
        }
      />
    </div>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <div>
      <p className="text-sm font-medium">{title}</p>
      <p className="text-muted-foreground mt-1 text-sm">{body}</p>
    </div>
  );
}
