import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangleIcon, CheckCircle2Icon } from "lucide-react";
import { useState } from "react";
import { useParams } from "react-router";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime, toDate } from "@/lib/dates";
import { trpc, type Integration } from "@/trpc";

/**
 * Per-project configuration. One card today: the GitLab connection that lets
 * cameri keep a status comment on a merge request up to date while the suite
 * runs.
 */
export function SettingsRoute() {
  const { projectSlug = "" } = useParams();
  const queryClient = useQueryClient();

  const canStoreSecrets = useQuery({
    queryKey: ["can-store-secrets"],
    queryFn: () => trpc.integrations.canStoreSecrets.query(),
  });

  const integrations = useQuery({
    queryKey: ["integrations", projectSlug],
    queryFn: () => trpc.integrations.list.query({ projectSlug }),
  });

  const gitlab = integrations.data?.find((row) => row.provider === "gitlab");

  const save = useMutation({
    mutationFn: (input: { baseUrl: string; token: string }) =>
      trpc.integrations.save.mutate({ projectSlug, provider: "gitlab", ...input }),
    onSuccess: () => {
      toast.success("GitLab connected");
      void queryClient.invalidateQueries({ queryKey: ["integrations", projectSlug] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  const remove = useMutation({
    mutationFn: () =>
      trpc.integrations.remove.mutate({ projectSlug, provider: "gitlab" }),
    onSuccess: () => {
      toast.success("GitLab disconnected");
      void queryClient.invalidateQueries({ queryKey: ["integrations", projectSlug] });
    },
    onError: (error: Error) => toast.error(error.message),
  });

  return (
    <div className="flex max-w-3xl flex-col gap-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            GitLab
            {gitlab ? (
              <Badge variant="outline" className="border-transparent bg-emerald-100 text-emerald-800 dark:bg-emerald-500/15 dark:text-emerald-300">
                Connected
              </Badge>
            ) : null}
          </CardTitle>
          <CardDescription>
            When a run comes from a merge request pipeline, cameri posts one comment on the merge
            request and edits it in place as shards report — so the thread gets a live summary
            rather than a note per batch.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {canStoreSecrets.isLoading || integrations.isLoading ? (
            <Skeleton className="h-32" />
          ) : canStoreSecrets.data === false ? (
            <NoEncryptionKey />
          ) : gitlab ? (
            <Connected
              integration={gitlab}
              onDisconnect={() => remove.mutate()}
              disconnecting={remove.isPending}
            />
          ) : (
            <ConnectForm onSave={(input) => save.mutate(input)} saving={save.isPending} />
          )}
        </CardContent>
      </Card>
    </div>
  );
}

/**
 * The server refuses to store a token it cannot encrypt, so this is a wall
 * rather than a warning — with the exact command to get past it.
 */
function NoEncryptionKey() {
  return (
    <div className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex flex-col gap-2">
        <p className="font-medium">No encryption key configured</p>
        <p className="text-muted-foreground">
          A GitLab token has to be stored in a form the server can read back, so cameri encrypts
          it at rest and will not accept one until it has a key. Generate one, set it on the
          server and restart:
        </p>
        <pre className="bg-muted overflow-auto rounded-md p-2 font-mono text-xs">
          {`CAMERI_ENCRYPTION_KEY=$(node -e \\
  "console.log(require('crypto').randomBytes(32).toString('base64'))")`}
        </pre>
      </div>
    </div>
  );
}

function Connected({
  integration,
  onDisconnect,
  disconnecting,
}: {
  integration: Integration;
  onDisconnect: () => void;
  disconnecting: boolean;
}) {
  return (
    <div className="flex flex-col gap-4">
      <dl className="grid gap-4 text-sm sm:grid-cols-3">
        <div>
          <dt className="text-muted-foreground text-xs">Instance</dt>
          <dd className="mt-0.5 truncate font-mono text-xs">{integration.baseUrl}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Token</dt>
          <dd className="mt-0.5 font-mono text-xs">{integration.tokenHint}</dd>
        </div>
        <div>
          <dt className="text-muted-foreground text-xs">Last used</dt>
          <dd className="mt-0.5 text-xs">
            {integration.lastUsedAt ? relativeTime(toDate(integration.lastUsedAt)) : "Never"}
          </dd>
        </div>
      </dl>

      {integration.lastError ? (
        <div className="flex gap-2 rounded-md border border-red-500/40 bg-red-500/5 p-2.5 text-xs">
          <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0 text-red-600 dark:text-red-400" />
          <div>
            <p className="font-medium">The last comment failed</p>
            <p className="text-muted-foreground mt-0.5 font-mono">{integration.lastError}</p>
          </div>
        </div>
      ) : integration.lastUsedAt ? (
        <p className="text-muted-foreground flex items-center gap-1.5 text-xs">
          <CheckCircle2Icon className="size-3.5 text-emerald-600 dark:text-emerald-400" />
          Last comment posted successfully.
        </p>
      ) : null}

      <Button
        variant="outline"
        size="sm"
        className="self-start"
        onClick={onDisconnect}
        disabled={disconnecting}
      >
        Disconnect
      </Button>
    </div>
  );
}

function ConnectForm({
  onSave,
  saving,
}: {
  onSave: (input: { baseUrl: string; token: string }) => void;
  saving: boolean;
}) {
  const [baseUrl, setBaseUrl] = useState("https://gitlab.com");
  const [token, setToken] = useState("");

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        onSave({ baseUrl: baseUrl.trim(), token: token.trim() });
      }}
    >
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Instance URL</span>
          <Input
            value={baseUrl}
            onChange={(event) => setBaseUrl(event.target.value)}
            placeholder="https://gitlab.example.com"
            required
          />
        </label>
        <label className="flex flex-col gap-1.5 text-sm">
          <span className="font-medium">Access token</span>
          {/* `type=password` so the value does not sit in plaintext on a shared
              screen, and no autofill: this is not a login. */}
          <Input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="glpat-…"
            required
          />
        </label>
      </div>

      <p className="text-muted-foreground text-xs">
        A project access token with the <code className="font-mono">api</code> scope and at least
        the Reporter role is enough — that is what posting and editing a note requires. The token
        is verified against the instance before it is stored, and is never sent back to this page
        afterwards.
      </p>

      <Button type="submit" size="sm" className="self-start" disabled={saving || !token}>
        {saving ? "Verifying…" : "Connect"}
      </Button>
    </form>
  );
}
