/**
 * The two GitLab API calls cameri needs, and nothing else.
 *
 * No SDK: this is one POST and one PUT, and a dependency that speaks the whole
 * GitLab API would be several megabytes to avoid twenty lines.
 */

export interface GitLabClientOptions {
  /** Instance root, e.g. `https://gitlab.com` or a self-hosted host. */
  baseUrl: string;
  token: string;
  /** Bounded so a hanging GitLab cannot pin a request handler open. */
  timeoutMs?: number;
}

export class GitLabError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitLabError";
  }
}

export class GitLabClient {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: GitLabClientOptions) {
    // A trailing slash turns `${base}/api/v4` into a double slash, which some
    // reverse proxies in front of self-hosted instances will 404.
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  /** Posts a new note on a merge request and returns its id. */
  async createNote(projectId: string, mrIid: string, body: string): Promise<string> {
    const note = await this.request<{ id: number }>(
      "POST",
      `/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}/notes`,
      { body },
    );
    return String(note.id);
  }

  /** Rewrites an existing note in place — this is what "updates as it runs" means. */
  async updateNote(
    projectId: string,
    mrIid: string,
    noteId: string,
    body: string,
  ): Promise<void> {
    await this.request(
      "PUT",
      `/projects/${encodeURIComponent(projectId)}/merge_requests/${encodeURIComponent(mrIid)}/notes/${encodeURIComponent(noteId)}`,
      { body },
    );
  }

  /** Cheap credential check, used by the settings page before saving. */
  async currentUser(): Promise<{ username: string }> {
    return this.request<{ username: string }>("GET", "/user");
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}/api/v4${path}`, {
      method,
      headers: {
        // PRIVATE-TOKEN rather than Authorization: it is the one header that
        // works for PATs, group tokens and project tokens alike.
        "PRIVATE-TOKEN": this.token,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      // The response body can echo back parts of the request, so only the
      // status and GitLab's own short message are surfaced — never the token.
      const detail = await response.text().catch(() => "");
      throw new GitLabError(
        `GitLab ${method} ${path} failed: ${response.status} ${truncate(detail)}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }
}

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}
