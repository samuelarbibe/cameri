import { useQuery } from "@tanstack/react-query";
import { Navigate } from "react-router";
import { trpc } from "@/trpc";

/**
 * `/` carries no project, so it forwards to the first one. A redirect rather
 * than a project picker: with one project — the common case — a picker is a
 * click between someone and the thing they came for.
 */
export function ProjectRedirect() {
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => trpc.projects.list.query(),
  });

  const first = projects.data?.[0];
  if (first) return <Navigate to={`/${first.slug}/runs`} replace />;

  if (projects.isLoading) return null;

  return (
    <div className="flex min-h-svh items-center justify-center p-8 text-center">
      <div>
        <p className="text-sm font-medium">
          {projects.error ? "Could not reach the server" : "No projects yet"}
        </p>
        <p className="text-muted-foreground mt-1 text-sm">
          {projects.error?.message ??
            "Create a project and a record key, then point a reporter at this server."}
        </p>
      </div>
    </div>
  );
}
