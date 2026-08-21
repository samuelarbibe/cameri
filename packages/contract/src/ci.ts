import type { CiContext, GitContext } from "./index.ts";

type Env = NodeJS.ProcessEnv;

/**
 * Every shard of a build has to independently arrive at the *same* run key,
 * otherwise they each open their own run and the build shows up N times. So the
 * key is derived from the CI build identifier only — never from anything
 * per-machine like a hostname, pid or timestamp.
 */
export function detectRunKey(env: Env = process.env): string | undefined {
  if (env.GITHUB_ACTIONS && env.GITHUB_RUN_ID) {
    return `gha-${env.GITHUB_RUN_ID}-${env.GITHUB_RUN_ATTEMPT ?? "1"}`;
  }
  if (env.GITLAB_CI && env.CI_PIPELINE_ID) {
    return `gitlab-${env.CI_PIPELINE_ID}`;
  }
  if (env.CIRCLECI && env.CIRCLE_WORKFLOW_ID) {
    return `circle-${env.CIRCLE_WORKFLOW_ID}`;
  }
  if (env.BUILDKITE && env.BUILDKITE_BUILD_ID) {
    return `buildkite-${env.BUILDKITE_BUILD_ID}`;
  }
  if (env.JENKINS_URL && env.BUILD_TAG) {
    return `jenkins-${env.BUILD_TAG}`;
  }
  return undefined;
}

export function detectCiContext(env: Env = process.env): CiContext {
  if (env.GITHUB_ACTIONS) {
    const repoUrl = `${env.GITHUB_SERVER_URL ?? "https://github.com"}/${env.GITHUB_REPOSITORY ?? ""}`;
    return {
      provider: "github-actions",
      buildId: env.GITHUB_RUN_ID ?? null,
      buildUrl: env.GITHUB_RUN_ID ? `${repoUrl}/actions/runs/${env.GITHUB_RUN_ID}` : null,
      jobName: env.GITHUB_JOB ?? null,
      attempt: Number.parseInt(env.GITHUB_RUN_ATTEMPT ?? "1", 10) || 1,
    };
  }
  if (env.GITLAB_CI) {
    return {
      provider: "gitlab-ci",
      buildId: env.CI_PIPELINE_ID ?? null,
      buildUrl: env.CI_PIPELINE_URL ?? null,
      jobName: env.CI_JOB_NAME ?? null,
      attempt: 1,
    };
  }
  if (env.CIRCLECI) {
    return {
      provider: "circleci",
      buildId: env.CIRCLE_WORKFLOW_ID ?? null,
      buildUrl: env.CIRCLE_BUILD_URL ?? null,
      jobName: env.CIRCLE_JOB ?? null,
      attempt: 1,
    };
  }
  if (env.BUILDKITE) {
    return {
      provider: "buildkite",
      buildId: env.BUILDKITE_BUILD_ID ?? null,
      buildUrl: env.BUILDKITE_BUILD_URL ?? null,
      jobName: env.BUILDKITE_LABEL ?? null,
      attempt: 1,
    };
  }
  return {
    provider: env.CI ? "unknown-ci" : "local",
    buildId: null,
    buildUrl: null,
    jobName: null,
    attempt: 1,
  };
}

export function detectGitContext(env: Env = process.env): GitContext {
  if (env.GITHUB_ACTIONS) {
    return {
      branch: env.GITHUB_HEAD_REF || env.GITHUB_REF_NAME || null,
      commitSha: env.GITHUB_SHA ?? null,
      commitMessage: null,
      author: env.GITHUB_ACTOR ?? null,
      remoteUrl: env.GITHUB_REPOSITORY ?? null,
    };
  }
  if (env.GITLAB_CI) {
    return {
      branch: env.CI_COMMIT_REF_NAME ?? null,
      commitSha: env.CI_COMMIT_SHA ?? null,
      commitMessage: env.CI_COMMIT_MESSAGE ?? null,
      author: env.CI_COMMIT_AUTHOR ?? null,
      remoteUrl: env.CI_PROJECT_URL ?? null,
    };
  }
  if (env.CIRCLECI) {
    return {
      branch: env.CIRCLE_BRANCH ?? null,
      commitSha: env.CIRCLE_SHA1 ?? null,
      commitMessage: null,
      author: env.CIRCLE_USERNAME ?? null,
      remoteUrl: env.CIRCLE_REPOSITORY_URL ?? null,
    };
  }
  return {
    branch: env.CAMERI_BRANCH ?? null,
    commitSha: env.CAMERI_COMMIT_SHA ?? null,
    commitMessage: null,
    author: null,
    remoteUrl: null,
  };
}

/** Local fallback so `npx playwright test` off CI still records something sane. */
export function localRunKey(): string {
  return `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
