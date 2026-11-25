import { useState, type ReactNode } from "react";
import {
  capitalized,
  type ChangeRequestCheck,
  type ChangeRequestDetail,
  changeRequestName,
  type ChangeRequestReviewer,
} from "../../../shared/types/providers";
import { confirmed } from "../../ui/Dialog";
import { CheckIcon, ChevronIcon, CloseIcon } from "../../ui/icons";
import { named } from "../../ui/named";
import type { TrackedActions } from "./tracked-actions";

/** The question merging a change request asks: it is not taken back. */
export function confirmMerge(request: ChangeRequestDetail, whenChecksPass: boolean): Promise<boolean> {
  const { kind, status } = request;
  return confirmed({
    title: whenChecksPass ? `Set ${kind.noun} to auto-merge` : `Merge ${kind.noun}`,
    message: whenChecksPass
      ? named`Merge ${changeRequestName(kind, request.number)} into ${status.base} once nothing is outstanding?`
      : named`Merge ${changeRequestName(kind, request.number)} into ${status.base}?`,
    detail: "It is merged by the repository's own method.",
    confirmLabel: whenChecksPass ? "Auto-Merge" : "Merge",
  });
}

/** A change request is approved from its status line where its host lets the viewer: GitHub never its author. */
export function approvable(request: ChangeRequestDetail, viewer: string | undefined): boolean {
  return request.state === "open" && (request.kind.selfApproval || request.author !== viewer);
}

/** What a reviewer's row says, and the colour of its dot (`.change-request-meter-*`): done, failed, outstanding. */
export const REVIEWER_STATES: Record<ChangeRequestReviewer["state"], { text: string; dot: "passed" | "failed" | "running" }> = {
  approved: { text: "Approved", dot: "passed" },
  "changes-requested": { text: "Changes requested", dot: "failed" },
  requested: { text: "Review requested", dot: "running" },
};

export const CHECK_ORDER: Record<ChangeRequestCheck["state"], number> = { failed: 0, running: 1, passed: 2, skipped: 3 };

/** Parts side by side, each as wide as its count; with none counted it stands hatched. */
export function Meter({ passed = 0, running = 0, failed = 0 }: { passed?: number; running?: number; failed?: number }) {
  const parts = [
    ["passed", passed],
    ["running", running],
    ["failed", failed],
  ] as const;
  return (
    <span className="change-request-meter">
      {passed + running + failed === 0 ? (
        <span className="change-request-meter-empty" />
      ) : (
        parts
          .filter(([, count]) => count > 0)
          .map(([state, count]) => <span key={state} className={`change-request-meter-${state}`} style={{ flexGrow: count }} />)
      )}
    </span>
  );
}

/** One of the three things a change request waits for, as GitHub's merge box draws them: its title and
 *  where it stands over a meter. One with a list under it (`onToggle`) opens it on a click. */
export function Segment({
  title,
  summary,
  meter,
  expanded,
  onToggle,
}: {
  title: string;
  summary: string;
  meter: ReactNode;
  expanded?: boolean;
  onToggle?: () => void;
}) {
  const content = (
    <>
      <span className="change-request-segment-head">
        <strong>{title}</strong>
        <span className="tracked-none">{summary}</span>
        {onToggle && <ChevronIcon expanded={expanded === true} />}
      </span>
      {meter}
    </>
  );
  return onToggle ? (
    <button type="button" className="change-request-segment" onClick={onToggle}>
      {content}
    </button>
  ) : (
    <div className="change-request-segment">{content}</div>
  );
}

/** A count and its word, for those counted: "8 passed, 2 running". */
export function counted(counts: [number, string][]): string {
  return counts
    .filter(([count]) => count > 0)
    .map(([count, word]) => `${count} ${word}`)
    .join(", ");
}

/**
 * A change request's card atop its thread. Its title is what merges into what, its commits and lines.
 * While it is open, its body is as GitHub's merge box: what keeps it from merging, then its checks,
 * its review threads and its approvals as three meters, the checks opening into each one, and the
 * buttons: a link to the host's page of its checks, its approval and the merge itself. Merge takes the
 * repository's own method; where the host would set it to auto-merge, it has the host merge once
 * nothing is outstanding, and stands disabled where it cannot go through. Approve and Auto-Merge, once
 * done, stand disabled with a check.
 */
export function ChangeRequestCard({
  request,
  viewer,
  actions,
}: {
  request: ChangeRequestDetail;
  viewer: string | undefined;
  actions: TrackedActions;
}) {
  const { status, kind } = request;
  const [busy, setBusy] = useState(false);
  const [shown, setShown] = useState<"checks" | "approvals" | "comments" | undefined>(undefined);
  const toggle = (list: "checks" | "approvals" | "comments") => () => setShown(shown === list ? undefined : list);
  const checksWord = capitalized(kind.checks);
  const { state, draft, checks } = request;
  const count = (wanted: ChangeRequestCheck["state"]): number => status.checks.filter((check) => check.state === wanted).length;
  const [passed, running, failed] = [count("passed"), count("running"), count("failed")];
  const unresolvedThreads = request.reviewThreads.filter((thread) => !thread.resolved);
  const unresolved = unresolvedThreads.length;
  const resolved = request.reviewThreads.length - unresolved;
  // Once merged or closed nothing is outstanding, whatever the host's decision still says.
  const approvalsOutstanding = state === "open" ? status.approvalsOutstanding : undefined;
  const given = status.reviewers.filter((reviewer) => reviewer.state === "approved").length;
  const reasons = [
    ...(failed > 0 ? [`${checksWord} failed`] : []),
    ...(status.conflicts ? [`Conflicts with ${status.base}`] : []),
    ...(approvalsOutstanding
      ? [
          approvalsOutstanding.left === undefined
            ? "Approval required"
            : `${approvalsOutstanding.left} more approval${approvalsOutstanding.left === 1 ? "" : "s"} required`,
        ]
      : []),
    ...status.blockers,
    ...(running > 0 ? [`${checksWord} still running`] : []),
  ];
  const mergeable = state === "open" && !draft && !status.conflicts && checks !== "failed";
  const approved = status.reviewers.some((reviewer) => reviewer.login === viewer && reviewer.state === "approved");
  const approve = async (): Promise<void> => {
    setBusy(true);
    await actions.approve();
    setBusy(false);
  };
  const merge = async (): Promise<void> => {
    if (!(await confirmMerge(request, status.autoMergeable))) {
      return;
    }
    setBusy(true);
    await actions.merge(status.autoMergeable);
    setBusy(false);
  };
  const buttons = (
    <span className="change-request-actions">
      {status.checksUrl !== undefined && (
        <button type="button" className="button secondary" onClick={() => void window.tet.shell.openUrl(status.checksUrl ?? "")}>
          {checksWord}
        </button>
      )}
      {approvable(request, viewer) && (
        <button type="button" className="button secondary" disabled={busy || approved} onClick={() => void approve()}>
          {approved && <CheckIcon />}
          <span>Approve</span>
        </button>
      )}
      {state === "open" && (
        <button type="button" className="button" disabled={busy || !mergeable || status.autoMerge} onClick={() => void merge()}>
          {status.autoMerge && <CheckIcon />}
          <span>{status.autoMerge || status.autoMergeable ? "Auto-Merge" : "Merge"}</span>
        </button>
      )}
    </span>
  );
  return (
    <div className="tracked-card change-request-card">
      <div className="tracked-card-header">
        <span className="tracked-card-title">
          {named`${status.head} into ${status.base}`}
          {" "}
          <span className="change-request-fact-unit">
            {"· "}
            {status.commits === 1 ? "1 commit" : `${status.commits} commits`}
          </span>
          {status.additions !== undefined && status.deletions !== undefined && (
            <>
              {" "}
              <span className="change-request-fact-unit">
                {"· "}
                <span className="change-request-additions">+{status.additions}</span>{" "}
                <span className="change-request-deletions">−{status.deletions}</span>
              </span>
            </>
          )}
        </span>
      </div>
      <div className="change-request-status">
        {state === "open" ? (
          <span className="change-request-headline">
            <strong>{draft ? "Draft" : reasons.length > 0 ? "Merging is blocked" : "Ready to merge"}</strong>
            <span className="tracked-none">
              {draft
                ? `This ${kind.noun} is not ready for review yet.`
                : reasons.length > 0
                  ? reasons.join(" · ")
                  : named`No conflicts with ${status.base}`}
            </span>
          </span>
        ) : (
          <span className="change-request-fact">
            {state === "merged" ? <CheckIcon /> : <CloseIcon />}
            {state === "merged" ? named`Merged into ${status.base}` : "Closed"}
            {state === "merged" && status.mergedBy && ` by ${status.mergedBy}`}
          </span>
        )}
        {buttons}
      </div>
      <div className="change-request-segments">
        <Segment
          title={checksWord}
          summary={counted([
            [failed, "failed"],
            [running, "running"],
            [passed, "passed"],
          ])}
          meter={<Meter passed={passed} running={running} failed={failed} />}
          expanded={shown === "checks"}
          onToggle={status.checks.length > 0 ? toggle("checks") : undefined}
        />
        <Segment
          title="Comments"
          summary={unresolved > 0 ? `${unresolved} unresolved` : resolved > 0 ? "All resolved" : ""}
          meter={<Meter passed={resolved} running={unresolved} />}
          expanded={shown === "comments"}
          onToggle={unresolved > 0 ? toggle("comments") : undefined}
        />
        <Segment
          title="Approvals"
          expanded={shown === "approvals"}
          onToggle={status.reviewers.length > 0 || approvalsOutstanding ? toggle("approvals") : undefined}
          summary={
            approvalsOutstanding
              ? approvalsOutstanding.left === undefined
                ? "Required"
                : `${approvalsOutstanding.left} still required`
              : given > 0
                ? `${given} approved`
                : ""
          }
          meter={<Meter passed={given} running={approvalsOutstanding ? Math.max(approvalsOutstanding.left ?? 1, 1) : 0} />}
        />
      </div>
      {shown === "approvals" && (
        <div className="change-request-checks">
          {status.reviewers.map((reviewer) => (
            <div key={reviewer.login} className="change-request-check">
              <span className={`change-request-check-state change-request-meter-${REVIEWER_STATES[reviewer.state].dot}`} />
              <span>{reviewer.login}</span>
              <span className="tracked-none">{REVIEWER_STATES[reviewer.state].text}</span>
            </div>
          ))}
          {approvalsOutstanding && (
            <div className="change-request-check">
              <span className="change-request-check-state change-request-meter-running" />
              <span className="tracked-none">
                {approvalsOutstanding.left === undefined ? "Approval required" : `${approvalsOutstanding.left} still required`}
              </span>
            </div>
          )}
        </div>
      )}
      {shown === "comments" && (
        <div className="change-request-checks">
          {unresolvedThreads.map((thread) => (
            <button
              key={thread.id}
              type="button"
              className="change-request-check"
              onClick={() => document.querySelector(`[data-review-thread="${CSS.escape(thread.id)}"]`)?.scrollIntoView({ block: "center" })}
            >
              <span className="change-request-check-state change-request-meter-running" />
              <span>
                {thread.path}
                {thread.line !== undefined && `:${thread.line}`}
              </span>
              <span className="tracked-none">{thread.comments[0]?.author}</span>
            </button>
          ))}
        </div>
      )}
      {shown === "checks" && (
        <div className="change-request-checks">
          {[...status.checks]
            .sort((a, b) => CHECK_ORDER[a.state] - CHECK_ORDER[b.state])
            .map((check, index) => {
              const content = (
                <>
                  <span className={`change-request-check-state change-request-meter-${check.state}`} />
                  <span>{check.name}</span>
                  {check.detail && <span className="tracked-none">{check.detail}</span>}
                  {check.required && <span className="change-request-required">Required</span>}
                </>
              );
              return check.url === undefined ? (
                <div key={index} className="change-request-check">
                  {content}
                </div>
              ) : (
                <button
                  key={index}
                  type="button"
                  className="change-request-check"
                  onClick={() => void window.tet.shell.openUrl(check.url ?? "")}
                >
                  {content}
                </button>
              );
            })}
        </div>
      )}
    </div>
  );
}
