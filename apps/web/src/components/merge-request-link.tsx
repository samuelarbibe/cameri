import { GitPullRequestArrowIcon } from "lucide-react";
import { Link } from "react-router";

type MergeRequestLinkProps = {
  iid: string | null;
  /** The merge request on the provider. Null on a run recorded without one. */
  url?: string | null;
  title?: string | null;
  /** Where the in-app drill-down goes. Omit to render a plain, unlinked chip. */
  projectSlug?: string | undefined;
  className?: string;
};

/**
 * The `!412` chip that marks which merge request a run belongs to.
 *
 * It points *into* cameri rather than out at GitLab. Every place this appears
 * is already a list of runs, so the useful next step is "the rest of this merge
 * request's runs", which is a page cameri has and GitLab does not — and the
 * merge request page carries the outbound link for when you do want the diff.
 *
 * Renders nothing without an iid. Callers do not guard: most runs are branch
 * pipelines, and a column of em-dashes says less than an empty one.
 */
export function MergeRequestLink({
  iid,
  url,
  title,
  projectSlug,
  className = "",
}: MergeRequestLinkProps) {
  if (!iid) return null;

  const label = (
    <>
      <GitPullRequestArrowIcon className="size-3.5 shrink-0" />
      <span className="tabular-nums">!{iid}</span>
    </>
  );
  // The tooltip is where the title goes: in a table row it would cost a column,
  // and it is context rather than something you scan for.
  const tooltip = title ?? (url ? `Merge request !${iid}` : undefined);
  const base = `inline-flex items-center gap-1 text-xs ${className}`;

  if (!projectSlug) {
    return (
      <span className={`text-muted-foreground ${base}`} title={tooltip}>
        {label}
      </span>
    );
  }

  return (
    <Link
      to={`/${projectSlug}/mrs/${encodeURIComponent(iid)}`}
      title={tooltip}
      // `relative z-10`: rows in the runs table are covered by a stretched link
      // to the run, and without this the chip sits underneath it and never gets
      // the click.
      className={`text-muted-foreground hover:text-foreground relative z-10 hover:underline ${base}`}
      // Same reason — the stretched anchor is an ancestor-adjacent overlay, so
      // the event must not bubble up into the row.
      onClick={(event) => event.stopPropagation()}
    >
      {label}
    </Link>
  );
}
