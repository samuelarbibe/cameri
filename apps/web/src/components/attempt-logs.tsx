import { CheckIcon, CopyIcon, ExternalLinkIcon, PaperclipIcon } from "lucide-react";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { formatDuration } from "@/lib/dates";
import { traceViewerUrl } from "@/lib/trace";
import type { Attachment, AttemptDetail, AttemptStep } from "@/trpc";

/**
 * Everything one attempt left behind: its step trace, its output streams, its
 * error, and whatever it attached.
 *
 * Ordered by how often it answers the question. The step trace goes first
 * because "what was it doing when it broke" is usually the whole enquiry, and
 * stdout is only useful once you know where in the test to look.
 */
export function AttemptLogs({ detail }: { detail: AttemptDetail }) {
  const empty =
    detail.steps.length === 0 &&
    !detail.stdout &&
    !detail.stderr &&
    !detail.errorStack &&
    detail.attachments.length === 0;

  if (empty) {
    return (
      <p className="text-muted-foreground py-8 text-center text-sm">
        This attempt produced no output.
        <br />
        <span className="text-xs">
          Steps and console output are collected from Playwright's reporter API — a test that
          prints nothing and calls no Playwright API has nothing to show here.
        </span>
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-4">
      {detail.steps.length > 0 ? (
        <Section title="Steps" count={detail.steps.length}>
          <StepTrace steps={detail.steps} />
        </Section>
      ) : null}

      {detail.errorStack || detail.errorSnippet ? (
        <Section title="Error">
          {detail.errorSnippet ? <Pre tone="error">{detail.errorSnippet}</Pre> : null}
          {detail.errorStack ? <Pre tone="muted">{detail.errorStack}</Pre> : null}
        </Section>
      ) : null}

      {detail.stdout ? (
        <Section title="stdout" copy={detail.stdout}>
          <Pre>{detail.stdout}</Pre>
        </Section>
      ) : null}

      {detail.stderr ? (
        <Section title="stderr" copy={detail.stderr}>
          <Pre tone="error">{detail.stderr}</Pre>
        </Section>
      ) : null}

      {detail.attachments.length > 0 ? (
        <Section title="Attachments" count={detail.attachments.length}>
          <ul className="flex flex-col gap-1">
            {detail.attachments.map((file) => (
              <AttachmentRow key={file.id} file={file} />
            ))}
          </ul>
        </Section>
      ) : null}

      {detail.annotations.length > 0 || detail.tags.length > 0 ? (
        <Section title="Annotations">
          <div className="flex flex-wrap gap-1.5">
            {detail.tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="font-mono text-xs">
                {tag}
              </Badge>
            ))}
            {detail.annotations.map((annotation, index) => (
              <Badge key={`${annotation.type}-${index}`} variant="outline" className="text-xs">
                {annotation.type}
                {annotation.description ? `: ${annotation.description}` : ""}
              </Badge>
            ))}
          </div>
        </Section>
      ) : null}
    </div>
  );
}

/**
 * One attachment, with the two things you can do with it.
 *
 * A trace gets a viewer link ahead of the download, because the zip on its own
 * is useless without `npx playwright show-trace` and a checkout — and the whole
 * point of recording it was to make a CI failure inspectable by someone who has
 * neither.
 */
function AttachmentRow({ file }: { file: Attachment }) {
  const isTrace = file.kind === "trace" && file.url !== null;

  return (
    <li className="flex items-center gap-2 rounded-md border px-2.5 py-1.5 text-xs">
      <PaperclipIcon className="text-muted-foreground size-3.5 shrink-0" />
      {file.url ? (
        <a
          href={file.url}
          className="truncate font-mono hover:underline"
          // The endpoint sends `content-disposition: attachment`, so this is a
          // download whatever the browser thinks of the content type.
          download={file.name}
        >
          {file.name}
        </a>
      ) : (
        // Registered but not uploaded — either still in flight, or the shard
        // died between reporting the attachment and sending it.
        <span className="text-muted-foreground truncate font-mono" title="Not uploaded">
          {file.name}
        </span>
      )}

      {isTrace ? (
        <Button size="sm" variant="ghost" className="ml-auto h-6 shrink-0 px-1.5 text-xs" asChild>
          <a href={traceViewerUrl(file.url ?? "")} target="_blank" rel="noreferrer">
            <ExternalLinkIcon className="size-3" />
            Open trace
          </a>
        </Button>
      ) : null}

      <Badge variant="outline" className={`shrink-0 ${isTrace ? "" : "ml-auto"}`}>
        {file.kind}
      </Badge>
      <span className="text-muted-foreground shrink-0 tabular-nums">
        {formatBytes(file.sizeBytes)}
      </span>
    </li>
  );
}

/**
 * The step tree, re-indented from each step's depth.
 *
 * Nesting is drawn with padding rather than nested elements: the list stays
 * flat, which means a 400-step trace is 400 divs instead of 400 divs inside
 * each other, and the browser can scroll it.
 */
function StepTrace({ steps }: { steps: AttemptStep[] }) {
  // Noise floor. `pw:api` steps are the individual clicks and waits — genuinely
  // useful when chasing a hang, overwhelming when reading a test's shape.
  const [showApi, setShowApi] = useState(() => steps.some((step) => step.error));
  const shown = showApi ? steps : steps.filter((step) => step.category !== "pw:api");
  const hidden = steps.length - shown.length;

  // Scaled against the slowest step, so the bars say "this one took the time"
  // rather than restating the duration that is already printed next to them.
  const slowest = Math.max(1, ...shown.map((step) => step.durationMs));

  return (
    <div className="flex flex-col">
      {shown.map((step, index) => (
        <div
          key={`${step.startedAt}-${index}`}
          className={`flex items-center gap-2 rounded-sm py-1 text-xs ${
            step.error ? "text-destructive" : ""
          }`}
          style={{ paddingLeft: `${step.depth * 14}px` }}
        >
          <span className="truncate font-mono" title={step.title}>
            {step.title}
          </span>
          {step.error ? (
            <span className="text-destructive/80 truncate" title={step.error}>
              — {step.error}
            </span>
          ) : null}
          <span className="ml-auto flex shrink-0 items-center gap-2">
            <span className="bg-muted h-1 w-16 overflow-hidden rounded-full">
              <span
                className={`block h-full ${step.error ? "bg-destructive" : "bg-primary/50"}`}
                style={{ width: `${(step.durationMs / slowest) * 100}%` }}
              />
            </span>
            <span className="text-muted-foreground w-14 text-right tabular-nums">
              {formatDuration(step.durationMs)}
            </span>
          </span>
        </div>
      ))}

      {hidden > 0 || showApi ? (
        <Button
          size="sm"
          variant="ghost"
          className="mt-1 h-7 self-start px-2 text-xs"
          onClick={() => setShowApi((previous) => !previous)}
        >
          {showApi ? "Hide Playwright API steps" : `Show ${hidden} Playwright API steps`}
        </Button>
      ) : null}
    </div>
  );
}

function Section({
  title,
  count,
  copy,
  children,
}: {
  title: string;
  count?: number;
  /** When set, a copy button appears — for the blocks people paste into a chat. */
  copy?: string;
  children: React.ReactNode;
}) {
  return (
    <Collapsible defaultOpen>
      <div className="flex items-center gap-2">
        <CollapsibleTrigger className="text-muted-foreground hover:text-foreground text-xs font-medium transition-colors">
          {title}
          {count !== undefined ? <span className="ml-1 tabular-nums">{count}</span> : null}
        </CollapsibleTrigger>
        {copy ? <CopyButton value={copy} /> : null}
      </div>
      <CollapsibleContent className="mt-1.5">{children}</CollapsibleContent>
    </Collapsible>
  );
}

function CopyButton({ value }: { value: string }) {
  const [copied, setCopied] = useState(false);

  return (
    <Button
      size="sm"
      variant="ghost"
      className="ml-auto h-6 px-1.5 text-xs"
      onClick={() => {
        void navigator.clipboard.writeText(value);
        setCopied(true);
        window.setTimeout(() => setCopied(false), 1500);
      }}
    >
      {copied ? <CheckIcon className="size-3" /> : <CopyIcon className="size-3" />}
      {copied ? "Copied" : "Copy"}
    </Button>
  );
}

function Pre({ children, tone = "plain" }: { children: string; tone?: "plain" | "error" | "muted" }) {
  const toneClass = {
    plain: "bg-muted/50",
    error: "text-destructive bg-destructive/5",
    muted: "text-muted-foreground bg-muted/50",
  }[tone];

  return (
    <pre
      className={`mt-1.5 max-h-80 overflow-auto rounded-md p-2.5 font-mono text-xs whitespace-pre-wrap ${toneClass}`}
    >
      {children}
    </pre>
  );
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
