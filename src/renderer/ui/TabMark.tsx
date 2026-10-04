import { CommentIcon, QuestionIcon, TabErrorIcon, SpinnerIcon } from "./icons";

/** What a tab shows on itself and on its project row ("Turns and tab marks" in AGENTS.md). */
type TabMarkKind = "error" | "waiting" | "working" | "finished";

/** A session's mark; which one wins where several hold is the site's to rank. */
export function TabMark({ kind, className }: { kind: TabMarkKind; className?: string }) {
  const classes = (extra: string) => [className, "tab-mark", extra].filter(Boolean).join(" ");
  switch (kind) {
    case "error":
      return <TabErrorIcon className={classes("tab-mark-error")} />;
    case "waiting":
      return <QuestionIcon className={classes("")} />;
    case "working":
      return <SpinnerIcon className={classes("spinning")} />;
    case "finished":
      return <CommentIcon className={classes("")} />;
  }
}
