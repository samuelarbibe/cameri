import { BrowserRouter, Route, Routes } from "react-router";
import { ProjectRedirect } from "@/routes/project-redirect";
import { RunRoute } from "@/routes/run-route";
import { RunsRoute } from "@/routes/runs-route";
import { ShellLayout } from "@/routes/shell-layout";

/**
 * The project is a path segment, not a query param: it identifies *what* you
 * are looking at, the same way the run id does, and it reads better in a link
 * someone pastes into a review — /web/runs/<id> rather than /runs/<id>?project=web.
 *
 * The query string is left for view state (tab, selected test, search).
 */
export function App() {
  return (
    <BrowserRouter>
      <Routes>
        {/* Nothing at the root identifies a project, so it bounces to the
            first one as soon as the list arrives. */}
        <Route path="/" element={<ProjectRedirect />} />

        {/* Layout route: the chrome renders once and survives navigation, so
            switching between the run list and a run keeps the sidebar mounted. */}
        <Route path=":projectSlug" element={<ShellLayout />}>
          <Route index element={<RunsRoute />} />
          <Route path="runs" element={<RunsRoute />} />
          <Route path="runs/:runId" element={<RunRoute />} />
        </Route>
      </Routes>
    </BrowserRouter>
  );
}
