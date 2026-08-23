import { useQuery } from "@tanstack/react-query";
import { Outlet, useLocation, useNavigate, useParams } from "react-router";
import { AppShell, type Crumb } from "@/components/app-shell";
import { trpc } from "@/trpc";

/** Path segment → what the breadcrumb calls it. Mirrors the sidebar's views. */
const VIEW_LABELS: Record<string, string> = {
  runs: "Test Runs",
  mrs: "Merge Requests",
  tests: "Test Explorer",
  settings: "Settings",
};

/**
 * Owns everything the chrome needs: the project list, which project is selected,
 * and the breadcrumb trail. Child routes render into the content area.
 *
 * The selected project comes off the path, so a link to the dashboard is
 * reproducible and the choice survives a reload.
 */
export function ShellLayout() {
  const { projectSlug = "", runId, mrIid } = useParams();
  const navigate = useNavigate();
  const { pathname } = useLocation();
  // `/:project/<view>/...` — the segment after the project is the view.
  const view = pathname.split("/")[2] ?? "runs";
  // Every view is at most two deep, so one optional leaf covers all of them.
  const leaf = runId !== undefined || mrIid !== undefined;

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
        {
          label: VIEW_LABELS[view] ?? "Test Runs",
          // The view is only a link when it is not where you already are.
          ...(leaf ? { href: `/${projectSlug}/${view}` } : {}),
        },
        ...(runId ? [{ label: run.data?.run.runKey ?? "Run" }] : []),
        ...(mrIid ? [{ label: `!${mrIid}` }] : []),
      ] satisfies Crumb[]}
    >
      <Outlet />
    </AppShell>
  );
}
