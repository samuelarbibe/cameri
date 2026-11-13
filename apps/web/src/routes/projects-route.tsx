import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CheckIcon, ChevronRightIcon, CopyIcon, PlusIcon } from "lucide-react";
import { useState } from "react";
import { Link } from "react-router";
import { AdminGate, useAdminMutationError } from "@/components/admin-gate";
import { TopBar } from "@/components/top-bar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { relativeTime } from "@/lib/dates";
import { trpc } from "@/trpc";

/**
 * `/` carries no project, so it lists them. Each row opens that project's runs.
 *
 * Creating sits next to the title rather than on the rows: it is an admin
 * action, and its panel asks for the admin token before it shows anything that
 * can change the server.
 */
export function ProjectsRoute() {
  const [creating, setCreating] = useState(false);
  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: () => trpc.projects.list.query(),
  });

  return (
    <div className="flex min-h-svh flex-col">
      <TopBar />

      <Sheet open={creating} onOpenChange={setCreating}>
        <SheetContent>
          <SheetHeader>
            <SheetTitle>New project</SheetTitle>
            <SheetDescription>
              Creates the project and its first record key, which the reporter uses to send
              results here.
            </SheetDescription>
          </SheetHeader>
          <div className="px-4">
            {/* Remounted on every open, so a key from last time is not left on screen. */}
            {creating ? (
              <AdminGate>
                <CreateProject />
              </AdminGate>
            ) : null}
          </div>
        </SheetContent>
      </Sheet>

      <main className="flex flex-1 flex-col gap-4 p-4">
        <div className="flex items-center gap-3">
          {/* Same heading as the runs page, without its counter. */}
          <h1 className="text-lg font-semibold tracking-tight">Projects</h1>
          {/* Same look as the shell's sidebar toggle. */}
          <Button
            variant="ghost"
            size="icon"
            className="ml-auto size-7"
            aria-label="New project"
            title="New project"
            onClick={() => setCreating(true)}
          >
            <PlusIcon />
          </Button>
        </div>
        {projects.isLoading ? (
          <Skeleton className="h-40" />
        ) : projects.error ? (
          <div className="text-muted-foreground py-16 text-center text-sm">
            <p className="text-foreground font-medium">Could not reach the server</p>
            <p className="mt-1">{projects.error.message}</p>
          </div>
        ) : (projects.data ?? []).length === 0 ? (
          <div className="text-muted-foreground py-16 text-center text-sm">
            <p className="text-foreground font-medium">No projects yet</p>
            <p className="mt-1">
              Create a project and a record key, then point a reporter at this server.
            </p>
          </div>
        ) : (
          <ul className="bg-card divide-y overflow-hidden rounded-lg border">
            {projects.data?.map((project) => (
              <li key={project.id}>
                <Link
                  to={`/${project.slug}/runs`}
                  className="hover:bg-muted/50 flex items-center gap-3 px-4 py-3 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium">{project.name}</p>
                    <p className="text-muted-foreground truncate font-mono text-xs">
                      {project.slug}
                    </p>
                  </div>
                  <span className="text-muted-foreground shrink-0 text-xs">
                    created {relativeTime(project.createdAt)}
                  </span>
                  <ChevronRightIcon className="text-muted-foreground size-4 shrink-0" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </main>
    </div>
  );
}

/** The name form, then — once — the record key it produced. */
function CreateProject() {
  const queryClient = useQueryClient();
  const onError = useAdminMutationError();
  const [name, setName] = useState("");

  const create = useMutation({
    mutationFn: (input: { name: string }) => trpc.projects.create.mutate(input),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: ["projects"] }),
    onError,
  });

  if (create.data) {
    const { project, recordKey } = create.data;
    return (
      <div className="flex flex-col gap-4 text-sm">
        <p>
          <span className="font-medium">{project.name}</span> is ready at{" "}
          <Link to={`/${project.slug}/runs`} className="font-mono underline underline-offset-4">
            /{project.slug}
          </Link>
          .
        </p>
        <div className="flex flex-col gap-2">
          <p className="font-medium">Record key</p>
          <CopyField value={recordKey} />
          <p className="text-muted-foreground">
            Shown this once — only its hash is stored. Give it to the reporter as{" "}
            <code className="font-mono text-xs">CAMERI_RECORD_KEY</code>.
          </p>
        </div>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        create.mutate({ name: name.trim() });
      }}
    >
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="font-medium">Name</span>
        <Input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="My App"
          maxLength={100}
          autoFocus
          required
        />
      </label>
      <Button
        type="submit"
        size="sm"
        className="self-start"
        disabled={create.isPending || !name.trim()}
      >
        {create.isPending ? "Creating…" : "Create project"}
      </Button>
    </form>
  );
}

function CopyField({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <div className="flex gap-2">
      <code className="bg-muted min-w-0 flex-1 truncate rounded-md px-2 py-1.5 font-mono text-xs">
        {value}
      </code>
      <Button
        size="sm"
        variant="outline"
        onClick={() => {
          void navigator.clipboard.writeText(value).then(() => setCopied(true));
        }}
      >
        {copied ? <CheckIcon /> : <CopyIcon />}
        {copied ? "Copied" : "Copy"}
      </Button>
    </div>
  );
}
