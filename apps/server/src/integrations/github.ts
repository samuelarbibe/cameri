import type { NoteClient } from "./note-client.ts";

export interface GitHubClientOptions {
  /** API root, e.g. `https://api.github.com` or `https://ghe.example.com/api/v3`. */
  baseUrl: string;
  token: string;
  timeoutMs?: number;
}

export class GitHubError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "GitHubError";
  }
}

export class GitHubClient implements NoteClient {
  private readonly base: string;
  private readonly token: string;
  private readonly timeoutMs: number;

  constructor(options: GitHubClientOptions) {
    this.base = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.timeoutMs = options.timeoutMs ?? 10_000;
  }

  async createNote(repository: string, pullNumber: string, body: string): Promise<string> {
    const comment = await this.request<{ id: number }>(
      "POST",
      `/repos/${repositoryPath(repository)}/issues/${encodeURIComponent(pullNumber)}/comments`,
      { body },
    );
    return String(comment.id);
  }

  async updateNote(
    repository: string,
    _pullNumber: string,
    noteId: string,
    body: string,
  ): Promise<void> {
    await this.request(
      "PATCH",
      `/repos/${repositoryPath(repository)}/issues/comments/${encodeURIComponent(noteId)}`,
      { body },
    );
  }

  async currentUser(): Promise<{ username: string }> {
    const user = await this.request<{ login: string }>("GET", "/user");
    return { username: user.login };
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const response = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        "user-agent": "cameri",
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(this.timeoutMs),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new GitHubError(
        `GitHub ${method} ${path} failed: ${response.status} ${truncate(detail)}`,
        response.status,
      );
    }

    return (await response.json()) as T;
  }
}

function repositoryPath(repository: string): string {
  return repository.split("/").map(encodeURIComponent).join("/");
}

function truncate(value: string): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}
