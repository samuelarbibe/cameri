import { useQuery, useQueryClient } from "@tanstack/react-query";
import { TRPCClientError } from "@trpc/client";
import { AlertTriangleIcon } from "lucide-react";
import { useState, type ReactNode } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { adminToken, trpc } from "@/trpc";

/**
 * Renders `children` only once this tab holds a working admin token; until
 * then, whichever wall is in the way — no token on the server, or none typed
 * here yet.
 */
export function AdminGate({ children }: { children: ReactNode }) {
  const queryClient = useQueryClient();
  const admin = useQuery({
    queryKey: ["admin-status"],
    queryFn: () => trpc.admin.status.query(),
  });

  if (admin.isLoading) return <Skeleton className="h-32" />;
  if (admin.data?.configured === false) return <NoAdminToken />;
  if (admin.data?.unlocked === false) {
    return (
      <Unlock
        onUnlock={(value) => {
          adminToken.set(value);
          void queryClient.invalidateQueries({ queryKey: ["admin-status"] });
        }}
      />
    );
  }
  return children;
}

/**
 * A rejected token is a stale token nine times out of ten — the server was
 * restarted with a new one. Drop it and put the keyhole back, rather than
 * leaving the page in a state where every button fails.
 */
export function useAdminMutationError() {
  const queryClient = useQueryClient();
  return (error: Error) => {
    if (error instanceof TRPCClientError && error.data?.code === "UNAUTHORIZED") {
      adminToken.clear();
      void queryClient.invalidateQueries({ queryKey: ["admin-status"] });
    }
    toast.error(error.message);
  };
}

/**
 * Same shape as the settings page's `NoEncryptionKey` on purpose: both are
 * "the server has not been given something it needs", and both are fixed by
 * setting one variable and restarting.
 */
function NoAdminToken() {
  return (
    <div className="flex gap-3 rounded-lg border border-amber-500/40 bg-amber-500/5 p-3 text-sm">
      <AlertTriangleIcon className="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400" />
      <div className="flex flex-col gap-2">
        <p className="font-medium">No admin token configured</p>
        <p className="text-muted-foreground">
          Reading cameri is open, but changing it — creating a project, storing a credential the
          server will later spend — is not, so it will not accept a change until it can tell who
          is asking. Set a token on the server and restart:
        </p>
        <pre className="bg-muted overflow-auto rounded-md p-2 font-mono text-xs">
          {`CAMERI_ADMIN_TOKEN=$(node -e \\
  "console.log(require('crypto').randomBytes(32).toString('base64url'))")`}
        </pre>
      </div>
    </div>
  );
}

/** Where the admin token gets typed. Held for the tab, never written to disk. */
function Unlock({ onUnlock }: { onUnlock: (token: string) => void }) {
  const [value, setValue] = useState("");

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        onUnlock(value.trim());
      }}
    >
      <p className="text-muted-foreground text-sm">
        This needs the server&rsquo;s{" "}
        <code className="font-mono text-xs">CAMERI_ADMIN_TOKEN</code>. It is kept for this tab only.
      </p>
      <div className="flex gap-2">
        <Input
          type="password"
          autoComplete="off"
          value={value}
          onChange={(event) => setValue(event.target.value)}
          placeholder="Admin token"
          className="max-w-xs"
          required
        />
        <Button type="submit" size="sm" disabled={!value.trim()}>
          Unlock
        </Button>
      </div>
    </form>
  );
}
