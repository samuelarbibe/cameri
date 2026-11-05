import type { IntegrationProvider } from "@camerihq/contract";
import { GitHubClient } from "./github.ts";
import { GitLabClient } from "./gitlab.ts";

export interface NoteClient {
  createNote(projectId: string, mrIid: string, body: string): Promise<string>;
  updateNote(projectId: string, mrIid: string, noteId: string, body: string): Promise<void>;
  currentUser(): Promise<{ username: string }>;
}

export const PROVIDER_LABELS: Record<IntegrationProvider, string> = {
  gitlab: "GitLab",
  github: "GitHub",
};

export function isIntegrationProvider(value: string | null): value is IntegrationProvider {
  return value === "gitlab" || value === "github";
}

export function createNoteClient(
  provider: IntegrationProvider,
  options: { baseUrl: string; token: string },
): NoteClient {
  return provider === "github" ? new GitHubClient(options) : new GitLabClient(options);
}
