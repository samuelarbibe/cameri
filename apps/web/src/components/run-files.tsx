import { ChevronRightIcon, FileCodeIcon, RotateCcwIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDuration } from "@/lib/dates";
import type { FileGroup, TestGroup } from "@/lib/run-stats";
import { OUTCOME_BADGE, OUTCOME_FILL, OUTCOME_LABEL } from "@/lib/status-colors";

/**
 * One collapsible section per spec file, tests inside. Files with failures open
 * by default: the reason to be on this tab is almost always to find out what
 * broke, and a wall of collapsed green is not that.
 */
type RunFilesProps = {
  files: FileGroup[];
  onSelectTest: (test: TestGroup) => void;
  selectedTestRef?: string;
};

export function RunFiles({ files, onSelectTest, selectedTestRef }: RunFilesProps) {
  if (files.length === 0) {
    return (
      <p className="text-muted-foreground py-12 text-center text-sm">
        No tests were recorded for this run.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      {files.map((file) => (
        <FileSection
          key={file.file}
          file={file}
          onSelectTest={onSelectTest}
          selectedTestRef={selectedTestRef}
        />
      ))}
    </div>
  );
}

function FileSection({
  file,
  onSelectTest,
  selectedTestRef,
}: {
  file: FileGroup;
  onSelectTest: (test: TestGroup) => void;
  selectedTestRef?: string;
}) {
  // A deep link can point at a test inside an all-green file, which would
  // otherwise open collapsed with nothing visibly selected.
  const hasSelected =
    selectedTestRef !== undefined && file.tests.some((test) => test.testRef === selectedTestRef);
  // Failures and in-flight tests are both "the thing worth looking at right
  // now"; everything else can stay folded away.
  const [open, setOpen] = useState(
    file.counts.failed > 0 || file.counts.running > 0 || hasSelected,
  );
  useEffect(() => {
    if (hasSelected) setOpen(true);
  }, [hasSelected]);

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className="bg-card overflow-hidden rounded-lg border"
    >
      <CollapsibleTrigger className="group hover:bg-accent/50 flex w-full items-center gap-3 px-4 py-3 text-left transition-colors">
        {/* `data-state` sits on the trigger, so the chevron reads it off the group. */}
        <ChevronRightIcon className="text-muted-foreground size-4 shrink-0 transition-transform duration-200 group-data-[state=open]:rotate-90" />
        <FileCodeIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="truncate font-mono text-sm">{file.file}</span>
        <div className="ml-auto flex shrink-0 items-center gap-2">
          <span className="text-muted-foreground text-xs tabular-nums">
            {formatDuration(file.durationMs)}
          </span>
          <OutcomeDots counts={file.counts} />
          <span className="text-muted-foreground text-xs tabular-nums">
            {file.counts.total} {file.counts.total === 1 ? "test" : "tests"}
          </span>
        </div>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="divide-y border-t">
          {file.tests.map((test) => (
            <TestRow
              key={test.testRef}
              test={test}
              onSelect={onSelectTest}
              selected={test.testRef === selectedTestRef}
            />
          ))}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** Compact per-file tally — a dot and a count for each outcome present. */
function OutcomeDots({ counts }: { counts: FileGroup["counts"] }) {
  const present = (["failed", "flaky", "passed", "skipped", "running"] as const).filter(
    (outcome) => counts[outcome] > 0,
  );
  return (
    <span className="flex items-center gap-2">
      {present.map((outcome) => (
        <span
          key={outcome}
          className="text-muted-foreground flex items-center gap-1 text-xs tabular-nums"
          title={OUTCOME_LABEL[outcome]}
        >
          <span className={`size-2 rounded-full ${OUTCOME_FILL[outcome]}`} />
          {counts[outcome]}
        </span>
      ))}
    </span>
  );
}

function TestRow({
  test,
  onSelect,
  selected,
}: {
  test: TestGroup;
  onSelect: (test: TestGroup) => void;
  selected: boolean;
}) {
  // `titlePath` is Playwright's full describe chain including the file and the
  // test itself; the middle slice is the describe blocks the test sits under.
  const suite = test.titlePath.slice(1, -1).join(" › ");

  return (
    <button
      type="button"
      onClick={() => onSelect(test)}
      className={`hover:bg-accent/50 flex w-full items-start gap-3 px-4 py-2.5 pl-11 text-left transition-colors ${selected ? "bg-accent/60" : ""}`}
    >
      <Badge variant="outline" className={`mt-0.5 shrink-0 ${OUTCOME_BADGE[test.outcome]}`}>
        {OUTCOME_LABEL[test.outcome]}
      </Badge>
      <div className="min-w-0 flex-1">
        {suite ? <p className="text-muted-foreground truncate text-xs">{suite}</p> : null}
        <p className="truncate text-sm">{test.title}</p>
        {test.projectName ? (
          <p className="text-muted-foreground text-xs">{test.projectName}</p>
        ) : null}
        {test.final.errorMessage ? (
          <pre className="text-destructive bg-destructive/5 mt-2 max-h-40 overflow-auto rounded-md p-2 font-mono text-xs whitespace-pre-wrap">
            {test.final.errorMessage}
          </pre>
        ) : null}
      </div>
      <div className="text-muted-foreground flex shrink-0 items-center gap-3 text-xs tabular-nums">
        {test.attempts.length > 1 ? (
          <span
            className="flex items-center gap-1"
            title={`${test.attempts.length - 1} retries`}
          >
            <RotateCcwIcon className="size-3" />
            {test.attempts.length - 1}
          </span>
        ) : null}
        <span>{formatDuration(test.durationMs)}</span>
      </div>
    </button>
  );
}
