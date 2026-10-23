import type { NoticeMark } from "../../shared/types/app";
import { CommentIcon, QuestionIcon, TabErrorIcon, SpinnerIcon } from "./icons";

/** What a tab shows on itself and on its project row ("Turns and tab marks" in AGENTS.md). */
export type TabMarkKind = NoticeMark | "error";

/** A session's mark; which one wins where several hold is the site's to rank. */
export function TabMark({ kind, className }: { kind: TabMarkKind; className?: string }) {
  const classes = (extra?: string) => [className, "tab-mark", `tab-mark-${kind}`, extra].filter(Boolean).join(" ");
  switch (kind) {
    case "error":
      return <TabErrorIcon className={classes()} />;
    case "waiting":
      return <QuestionIcon className={classes()} />;
    case "working":
      return <SpinnerIcon className={classes("spinning")} />;
    case "finished":
      return <CommentIcon className={classes()} />;
  }
}
