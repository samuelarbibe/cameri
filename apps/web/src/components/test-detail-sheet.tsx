import { Badge } from "@/components/ui/badge";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { formatClock, formatDuration } from "@/lib/dates";
import type { TestGroup } from "@/lib/run-stats";
import { OUTCOME_BADGE, OUTCOME_LABEL, STATUS_FILL } from "@/lib/status-colors";
import type { RunAttempt, RunDetail } from "@/trpc";

type TestDetailSheetProps = {
  test: TestGroup | null;
  /** Which attempt to scroll into view / highlight, when opened from the timeline. */
  focusAttemptId?: string;
  shards: RunDetail["shards"];
  onClose: () => void;
};

/**
 * Detail panel for one test, opened from the timeline or the file tree.
 *
 * Deliberately plain for now — the layout is going to be reworked, so this
 * sticks to what is already on the wire (the retry chain, where each attempt
 * ran, and its error) rather than inventing structure that will be thrown away.
 */
export function TestDetailSheet({ test, focusAttemptId, shards, onClose }: TestDetailSheetProps) {
  const shardIndexById = new Map(shards.map((shard) => [shard.id, shard.shardIndex]));
  const suite = test?.titlePath.slice(1, -1).join(" › ");

  return (
    <Sheet open={test !== null} onOpenChange={(open) => !open && onClose()}>
      <SheetContent side="right" className="w-full gap-0 sm:max-w-xl">
        {test ? (
          <>
            <SheetHeader className="gap-2 border-b">
              <div className="flex items-start gap-2">
                <Badge variant="outline" className={`mt-0.5 shrink-0 ${OUTCOME_BADGE[test.outcome]}`}>
                  {OUTCOME_LABEL[test.outcome]}
                </Badge>
                <SheetTitle className="text-base leading-snug">{test.title}</SheetTitle>
              </div>
              <SheetDescription className="font-mono text-xs">
                {test.file}
                {suite ? ` › ${suite}` : ""}
              </SheetDescription>
            </SheetHeader>

            <div className="flex-1 overflow-y-auto">
              <dl className="grid grid-cols-3 gap-4 border-b px-4 py-4 text-sm">
                <Field label="Project" value={test.projectName || "—"} />
                <Field label="Attempts" value={String(test.attempts.length)} />
                <Field label="Total time" value={formatDuration(test.durationMs)} />
              </dl>

              <div className="px-4 py-4">
                <p className="text-muted-foreground mb-2 text-xs font-medium">Attempts</p>
                <div className="flex flex-col gap-2">
                  {test.attempts.map((attempt) => (
                    <AttemptCard
                      key={attempt.id}
                      attempt={attempt}
                      shardIndex={shardIndexById.get(attempt.shardId)}
                      focused={attempt.id === focusAttemptId}
                    />
                  ))}
                </div>
              </div>
            </div>
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

function AttemptCard({
  attempt,
  shardIndex,
  focused,
}: {
  attempt: RunAttempt;
  shardIndex: number | undefined;
  focused: boolean;
}) {
  return (
    <div className={`rounded-lg border p-3 ${focused ? "ring-ring ring-2" : ""}`}>
      <div className="flex items-center gap-2">
        <span className={`size-2 shrink-0 rounded-full ${STATUS_FILL[attempt.status].split(" ")[0]}`} />
        <span className="text-sm font-medium">
          {attempt.retry === 0 ? "First run" : `Retry ${attempt.retry}`}
        </span>
        <span className="text-muted-foreground text-xs">{attempt.status}</span>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {formatDuration(attempt.durationMs)}
        </span>
      </div>
      <p className="text-muted-foreground mt-1.5 text-xs tabular-nums">
        {shardIndex !== undefined ? `Shard ${shardIndex} · ` : ""}
        worker {attempt.parallelIndex}
        {/* Only worth showing when it disagrees with the slot — that means a
            worker died and Playwright started a replacement. */}
        {attempt.workerIndex !== attempt.parallelIndex
          ? ` (worker index ${attempt.workerIndex})`
          : ""}{" "}
        · started {formatClock(new Date(attempt.startedAt).getTime(), true)}
      </p>
      {attempt.errorMessage ? (
        <pre className="text-destructive bg-destructive/5 mt-2 max-h-56 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap">
          {attempt.errorMessage}
        </pre>
      ) : null}
    </div>
  );
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted-foreground text-xs">{label}</dt>
      <dd className="mt-0.5 truncate">{value}</dd>
    </div>
  );
}
