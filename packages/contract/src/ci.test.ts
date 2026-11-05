import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { detectMergeRequest } from "./ci.ts";

const dir = mkdtempSync(join(tmpdir(), "cameri-ci-"));
after(() => rmSync(dir, { recursive: true, force: true }));

function eventFile(payload: unknown): string {
  const path = join(dir, `event-${Math.random().toString(36).slice(2)}.json`);
  writeFileSync(path, JSON.stringify(payload));
  return path;
}

const githubBase = {
  GITHUB_ACTIONS: "true",
  GITHUB_REPOSITORY: "acme/app",
  GITHUB_SERVER_URL: "https://github.com",
};

describe("detectMergeRequest on GitHub Actions", () => {
  it("reads the pull request from the event payload", () => {
    const mr = detectMergeRequest({
      ...githubBase,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_BASE_REF: "main",
      GITHUB_EVENT_PATH: eventFile({
        pull_request: {
          number: 42,
          title: "Add checkout",
          html_url: "https://github.com/acme/app/pull/42",
          base: { ref: "main", repo: { full_name: "acme/app" } },
        },
      }),
    });

    assert.deepEqual(mr, {
      provider: "github",
      projectId: "acme/app",
      iid: "42",
      title: "Add checkout",
      targetBranch: "main",
      serverUrl: "https://github.com",
      webUrl: "https://github.com/acme/app/pull/42",
    });
  });

  it("targets the base repository on a fork pull request", () => {
    const mr = detectMergeRequest({
      ...githubBase,
      GITHUB_REPOSITORY: "contributor/app",
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_EVENT_PATH: eventFile({
        pull_request: { number: 7, base: { repo: { full_name: "acme/app" } } },
      }),
    });

    assert.equal(mr.projectId, "acme/app");
  });

  it("falls back to the ref when the payload is unreadable", () => {
    const mr = detectMergeRequest({
      ...githubBase,
      GITHUB_EVENT_NAME: "pull_request",
      GITHUB_REF: "refs/pull/13/merge",
      GITHUB_BASE_REF: "develop",
      GITHUB_EVENT_PATH: join(dir, "missing.json"),
    });

    assert.equal(mr.iid, "13");
    assert.equal(mr.projectId, "acme/app");
    assert.equal(mr.title, null);
    assert.equal(mr.targetBranch, "develop");
    assert.equal(mr.webUrl, "https://github.com/acme/app/pull/13");
  });

  it("is not a pull request on a push", () => {
    const mr = detectMergeRequest({ ...githubBase, GITHUB_EVENT_NAME: "push" });

    assert.equal(mr.provider, null);
    assert.equal(mr.iid, null);
  });

  it("is not a pull request when no number can be found", () => {
    const mr = detectMergeRequest({
      ...githubBase,
      GITHUB_EVENT_NAME: "pull_request_target",
      GITHUB_REF: "refs/heads/main",
    });

    assert.equal(mr.provider, null);
  });
});

describe("detectMergeRequest on GitLab CI", () => {
  it("still reads merge request pipelines", () => {
    const mr = detectMergeRequest({
      GITLAB_CI: "true",
      CI_MERGE_REQUEST_IID: "5",
      CI_MERGE_REQUEST_PROJECT_ID: "99",
      CI_MERGE_REQUEST_PROJECT_URL: "https://gitlab.com/acme/app",
    });

    assert.equal(mr.provider, "gitlab");
    assert.equal(mr.projectId, "99");
    assert.equal(mr.webUrl, "https://gitlab.com/acme/app/-/merge_requests/5");
  });
});
