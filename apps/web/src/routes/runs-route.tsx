import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { RunsTable } from "@/components/runs-table";
import { trpc } from "@/trpc";

export function RunsRoute() {
  const { projectSlug: slug = "" } = useParams();

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => trpc.projects.list.query(),
  });

  const runs = useQuery({
    queryKey: ["runs", slug],
    queryFn: () => trpc.runs.list.query({ projectSlug: slug, limit: 100 }),
    enabled: slug !== "",
    // Runs are live while CI is going. Polling is the placeholder; SSE off the
    // shard-completion path is the real answer.
    refetchInterval: 5_000,
  });

  const noProjects = projects.data?.length === 0;
  const unknownProject =
    projects.data !== undefined && !projects.data.some((p) => p.slug === slug);

  return (
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
        ) : (
          <EmptyState
            title="No runs recorded"
            body="Run your suite with CAMERI_RECORD_KEY set and results will land here."
          />
        )
      }
    />
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
