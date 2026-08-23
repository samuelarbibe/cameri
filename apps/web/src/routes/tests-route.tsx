import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router";
import { TestExplorer } from "@/components/test-explorer";
import { trpc } from "@/trpc";

/**
 * Every test in the project, ranked by how much trouble it is causing.
 *
 * This is the cross-run view the run pages cannot give you: a test that fails
 * one time in twenty looks fine in each individual run and is obvious here.
 */
export function TestsRoute() {
  const { projectSlug = "" } = useParams();

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => trpc.projects.list.query(),
  });
  const project = projects.data?.find((candidate) => candidate.slug === projectSlug);

  return (
    <div className="flex flex-col gap-4">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">Test Explorer</h1>
        <p className="text-muted-foreground text-sm">
          Every test in {project?.name ?? projectSlug}, worst first.
        </p>
      </div>

      <TestExplorer projectSlug={projectSlug} showFilters />
    </div>
  );
}
