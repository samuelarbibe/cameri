import { TopBar } from "@/components/top-bar";

/**
 * Both kinds of dead end: a path no route matches, and a project slug the
 * server does not know — deleted, renamed, or mistyped in a pasted link.
 */
export function NotFoundRoute({ projectSlug }: { projectSlug?: string }) {
  return (
    <div className="flex min-h-svh flex-col">
      <TopBar />
      <main className="flex flex-1 flex-col items-center justify-center gap-2 p-8 text-center">
        <p className="text-muted-foreground font-mono text-sm">404</p>
        <h1 className="text-lg font-semibold tracking-tight">
          {projectSlug ? "Project not found" : "Page not found"}
        </h1>
      </main>
    </div>
  );
}
