import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import { GitHubClient, GitHubError } from "./github.ts";

interface Call {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
}

function stubFetch(response: { status?: number; json?: unknown; text?: string } = {}): Call[] {
  const calls: Call[] = [];
  mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
    calls.push({
      url,
      method: init.method ?? "GET",
      headers: init.headers as Record<string, string>,
      body: init.body ? JSON.parse(init.body as string) : undefined,
    });
    const status = response.status ?? 200;
    return new Response(response.text ?? JSON.stringify(response.json ?? {}), { status });
  });
  return calls;
}

const client = new GitHubClient({ baseUrl: "https://api.github.com/", token: "ghp_secret" });

afterEach(() => mock.restoreAll());

describe("GitHubClient", () => {
  it("creates a comment on the pull request's issue thread", async () => {
    const calls = stubFetch({ json: { id: 987 } });

    const id = await client.createNote("acme/app", "42", "hello");

    assert.equal(id, "987");
    assert.equal(calls[0]?.url, "https://api.github.com/repos/acme/app/issues/42/comments");
    assert.equal(calls[0]?.method, "POST");
    assert.deepEqual(calls[0]?.body, { body: "hello" });
    assert.equal(calls[0]?.headers.authorization, "Bearer ghp_secret");
    assert.equal(calls[0]?.headers["user-agent"], "cameri");
  });

  it("edits a comment by id without needing the pull request number", async () => {
    const calls = stubFetch();

    await client.updateNote("acme/app", "42", "987", "updated");

    assert.equal(calls[0]?.url, "https://api.github.com/repos/acme/app/issues/comments/987");
    assert.equal(calls[0]?.method, "PATCH");
    assert.deepEqual(calls[0]?.body, { body: "updated" });
  });

  it("maps the login to a username when checking the token", async () => {
    stubFetch({ json: { login: "octocat" } });

    assert.deepEqual(await client.currentUser(), { username: "octocat" });
  });

  it("reports the status without echoing the token", async () => {
    stubFetch({ status: 401, text: '{"message":"Bad credentials"}' });

    await assert.rejects(client.currentUser(), (error: unknown) => {
      assert.ok(error instanceof GitHubError);
      assert.equal(error.status, 401);
      assert.match(error.message, /401 .*Bad credentials/);
      assert.doesNotMatch(error.message, /ghp_secret/);
      return true;
    });
  });
});
