import { BrowserRouter, Route, Routes } from "react-router";
import { MergeRequestRoute } from "@/routes/mr-route";
import { MergeRequestsRoute } from "@/routes/mrs-route";
import { NotFoundRoute } from "@/routes/not-found-route";
import { ProjectsRoute } from "@/routes/projects-route";
import { RunRoute } from "@/routes/run-route";
import { RunsRoute } from "@/routes/runs-route";
import { SettingsRoute } from "@/routes/settings-route";
import { ShellLayout } from "@/routes/shell-layout";
import { TestsRoute } from "@/routes/tests-route";

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
        <Route path="/" element={<ProjectsRoute />} />

        <Route path=":projectSlug" element={<ShellLayout />}>
          <Route index element={<RunsRoute />} />
          <Route path="runs" element={<RunsRoute />} />
          <Route path="runs/:runId" element={<RunRoute />} />
          {/* `mrs`, not `merge-requests`: it is typed into the address bar and
              read in pasted links more often than it is read as prose. */}
          <Route path="mrs" element={<MergeRequestsRoute />} />
          <Route path="mrs/:mrIid" element={<MergeRequestRoute />} />
          <Route path="tests" element={<TestsRoute />} />
          <Route path="settings" element={<SettingsRoute />} />
        </Route>

        <Route path="*" element={<NotFoundRoute />} />
      </Routes>
    </BrowserRouter>
  );
}
