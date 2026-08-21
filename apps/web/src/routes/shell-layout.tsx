import { useQuery } from "@tanstack/react-query";
import { Outlet, useNavigate, useParams } from "react-router";
import { AppShell } from "@/components/app-shell";
import { trpc } from "@/trpc";

/**
 * Owns everything the chrome needs: the project list, which project is selected,
 * and the breadcrumb trail. Child routes render into the content area.
 *
 * The selected project comes off the path, so a link to the dashboard is
 * reproducible and the choice survives a reload.
 */
export function ShellLayout() {
  const { projectSlug = "", runId } = useParams();
  const navigate = useNavigate();

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => trpc.projects.list.query(),
  });

  // Same query key the run page uses, so react-query serves both from one
  // request instead of fetching the run twice.
  const run = useQuery({
    queryKey: ["run", runId],
    queryFn: () => trpc.runs.get.query({ runId: runId ?? "" }),
    enabled: runId !== undefined,
  });

  const project = projects.data?.find((candidate) => candidate.slug === projectSlug);

  return (
    <AppShell
      projects={projects.data ?? []}
      activeSlug={projectSlug}
      // Switching project drops whatever run was open: run ids are scoped to a
      // project, so carrying one across would just 404.
      onSelectProject={(next) => navigate(`/${next}/runs`)}
      projectsLoading={projects.isLoading}
      trail={[
        { label: project?.name ?? projectSlug, href: `/${projectSlug}/runs` },
        ...(runId ? [{ label: run.data?.run.runKey ?? "Run" }] : []),
      ]}
    >
      <Outlet />
    </AppShell>
  );
}
