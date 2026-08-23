/**
 * Links into Playwright's hosted trace viewer.
 *
 * It is a static site that fetches the trace in the browser rather than
 * uploading it anywhere, so the bytes go straight from this server to the
 * reader — nothing is sent to Playwright. That only works because the endpoints
 * it fetches answer cross-origin GETs; see the CORS headers on `/blobs/*` and
 * `/attempts/:id/trace`.
 */
const TRACE_VIEWER = "https://trace.playwright.dev/?trace=";

/**
 * The viewer needs an absolute URL: it resolves what it is given against
 * `trace.playwright.dev`, so a path would point at Playwright's own site.
 */
export function traceViewerUrl(target: string): string {
  return `${TRACE_VIEWER}${encodeURIComponent(new URL(target, window.location.origin).href)}`;
}

/** The trace of one attempt, via the redirect that keeps the link stable. */
export function attemptTraceUrl(attemptId: string): string {
  return traceViewerUrl(`/api/v1/attempts/${attemptId}/trace`);
}
