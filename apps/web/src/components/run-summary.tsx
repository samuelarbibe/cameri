import { ExternalLinkIcon, GitBranchIcon, GitCommitHorizontalIcon, UserIcon } from "lucide-react";
import { useParams } from "react-router";
import { MergeRequestLink } from "@/components/merge-request-link";
import { RunStatusBadge } from "@/components/run-status-badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatDuration, relativeTime, toDate } from "@/lib/dates";
import type { OutcomeCounts, TestOutcome } from "@/lib/run-stats";
import { OUTCOME_FILL, OUTCOME_LABEL } from "@/lib/status-colors";
import type { RunDetail } from "@/trpc";

type RunSummaryProps = {
  detail: RunDetail;
  counts: OutcomeCounts;
  /** Wall-clock window the run occupied, not the summed test time. */
  window: { start: number; end: number };
};

/**
 * Ordered worst-first: a failing run should read its bad news left to right.
 * `running` trails the lot, so on a live run the undecided slice sits at the
 * right-hand end of the bar and visibly shrinks as results come in.
 */
const BREAKDOWN: TestOutcome[] = ["failed", "flaky", "passed", "skipped", "running"];

export function RunSummary({ detail, counts, window }: RunSummaryProps) {
  const { run } = detail;
  const { projectSlug } = useParams();
  const completedShards = detail.shards.filter((shard) => shard.completedAt !== null).length;
  const wallClock = window.end - window.start;
  const testTime = detail.attempts.reduce((sum, attempt) => sum + attempt.durationMs, 0);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start gap-x-4 gap-y-2">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h1 className="truncate font-mono text-lg font-semibold tracking-tight">
              {run.runKey}
            </h1>
            <RunStatusBadge status={run.status} />
          </div>
          <p className="text-muted-foreground mt-1 truncate text-sm">
            {run.commitMessage ?? "No commit message"}
          </p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          {run.mrUrl ? (
            <Button variant="outline" size="sm" asChild>
              <a href={run.mrUrl} target="_blank" rel="noreferrer">
                <ExternalLinkIcon className="size-4" />
                Merge request
              </a>
            </Button>
          ) : null}
          {run.ciBuildUrl ? (
            <Button variant="outline" size="sm" asChild>
              <a href={run.ciBuildUrl} target="_blank" rel="noreferrer">
                <ExternalLinkIcon className="size-4" />
                CI build
              </a>
            </Button>
          ) : null}
        </div>
      </div>

      <div className="text-muted-foreground flex flex-wrap items-center gap-x-4 gap-y-1 text-sm">
        {/* First in the row: on a merge request pipeline it is the thing that
            says what this run was for, and the branch is a detail of it. */}
        <MergeRequestLink
          iid={run.mrIid}
          url={run.mrUrl}
          title={run.mrTitle}
          projectSlug={projectSlug}
          className="text-sm"
        />
        <Meta icon={GitBranchIcon} value={run.branch} />
        <Meta icon={GitCommitHorizontalIcon} value={run.commitSha?.slice(0, 8)} mono />
        <Meta icon={UserIcon} value={run.author} />
        <span title={toDate(run.startedAt).toLocaleString()}>
          started {relativeTime(run.startedAt)}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <Stat label="Tests" value={counts.total} />
        <Stat label="Passed" value={counts.passed} tone="passed" />
        <Stat label="Failed" value={counts.failed} tone="failed" />
        <Stat label="Flaky" value={counts.flaky} tone="flaky" />
        <Stat
          label="Duration"
          value={formatDuration(wallClock)}
          hint={`${formatDuration(testTime)} of test time`}
        />
        <Stat
          label="Shards"
          value={`${completedShards}/${run.expectedShards}`}
          hint={`${detail.attempts.length} attempts`}
        />
      </div>

      {counts.total > 0 ? <PassRate counts={counts} /> : null}
    </div>
  );
}

/**
 * One stacked bar in place of a pie: it answers "how much of this run is red"
 * at a glance and keeps its meaning at any width.
 */
function PassRate({ counts }: { counts: OutcomeCounts }) {
  return (
    <div className="flex flex-col gap-1.5">
      <div className="bg-muted flex h-2 overflow-hidden rounded-full">
        {BREAKDOWN.filter((outcome) => counts[outcome] > 0).map((outcome) => (
          <div
            key={outcome}
            className={OUTCOME_FILL[outcome]}
            style={{ width: `${(counts[outcome] / counts.total) * 100}%` }}
            title={`${counts[outcome]} ${OUTCOME_LABEL[outcome].toLowerCase()}`}
          />
        ))}
      </div>
      <div className="text-muted-foreground flex flex-wrap gap-x-4 text-xs">
        {BREAKDOWN.filter((outcome) => counts[outcome] > 0).map((outcome) => (
          <span key={outcome} className="flex items-center gap-1.5">
            <span className={`size-2 rounded-full ${OUTCOME_FILL[outcome]}`} />
            {counts[outcome]} {OUTCOME_LABEL[outcome].toLowerCase()}
          </span>
        ))}
      </div>
    </div>
  );
}

const TONE: Record<string, string> = {
  passed: "text-emerald-600 dark:text-emerald-400",
  failed: "text-red-600 dark:text-red-400",
  flaky: "text-amber-600 dark:text-amber-400",
};

function Stat({
  label,
  value,
  hint,
  tone,
}: {
  label: string;
  value: string | number;
  hint?: string;
  tone?: keyof typeof TONE;
}) {
  // Zero of a bad thing is good news, so it stays neutral rather than red.
  const coloured = tone && value !== 0 ? TONE[tone] : "";
  return (
    <Card className="gap-0 py-3">
      <CardContent className="px-4">
        <p className="text-muted-foreground text-xs font-medium">{label}</p>
        <p className={`mt-1 text-2xl font-semibold tabular-nums ${coloured}`}>{value}</p>
        {hint ? <p className="text-muted-foreground mt-0.5 text-xs">{hint}</p> : null}
      </CardContent>
    </Card>
  );
}

function Meta({
  icon: Icon,
  value,
  mono,
}: {
  icon: React.ComponentType<{ className?: string }>;
  value: string | null | undefined;
  mono?: boolean;
}) {
  if (!value) return null;
  return (
    <span className="flex items-center gap-1.5">
      <Icon className="size-3.5" />
      <span className={mono ? "font-mono text-xs" : undefined}>{value}</span>
    </span>
  );
}
