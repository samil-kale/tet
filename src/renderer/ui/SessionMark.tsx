import { CircleAlertIcon, CommentIcon, QuestionIcon, SpinnerIcon } from "./icons";

/** What a session shows on its tab and project row ("Turns and session marks" in AGENTS.md). */
type SessionMarkKind = "error" | "waiting" | "working" | "finished";

/** A session's mark; which one wins where several hold is the site's to rank. */
export function SessionMark({ kind, className }: { kind: SessionMarkKind; className?: string }) {
  const classes = (extra: string) => [className, "session-mark", extra].filter(Boolean).join(" ");
  switch (kind) {
    case "error":
      return <CircleAlertIcon className={classes("session-mark-error")} />;
    case "waiting":
      return <QuestionIcon className={classes("")} />;
    case "working":
      return <SpinnerIcon className={classes("spinning")} />;
    case "finished":
      return <CommentIcon className={classes("")} />;
  }
}
