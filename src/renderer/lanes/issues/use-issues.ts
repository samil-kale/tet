import { useCallback, useEffect, useRef, useState } from "react";
import type { Issue, IssueFilter, IssueListResult, IssuesLatest } from "../../../shared/types/providers";
import { subscribeIssues } from "../../editor/editor-tab";
import { reloadChangedIssueTabs, type IssueOptions } from "../../editor/editor-views";
import { setSeen } from "../../editor/tracked-seen";
import { subscribeAccounts } from "../../git/ProviderAccount";
import { notify } from "../../ui/Notices";
import { useWindowFocused } from "../../ui/use-window-focused";

const NO_OPTIONS: IssueOptions = { labels: [], people: [] };

/** How often the tracker is asked whether the list shown is out of date, while the lane is shown and
 *  the window focused. */
const CHECK_MS = 15_000;

/** Issues asked for at first, and added by each `more`. */
const ISSUE_PAGE = 20;

/** Typing searches the tracker, as the Graph's search runs — but only once the typing stops. */
const SEARCH_DELAY_MS = 300;

/** Whether two answers of the tracker differ: the list they stand for has changed. */
function differ(shown: IssuesLatest | undefined, found: IssuesLatest): boolean {
  return shown?.total !== found.total || shown.updatedAt !== found.updatedAt;
}

interface Issues {
  /** Undefined until the first answer. */
  issues: Issue[] | undefined;
  /** How many the tracker counts under the filter, those not read yet among them. */
  total: number | undefined;
  /** What `issues` were read under: their filter with its text, and how many were asked for. */
  read: { filterKey: string; limit: number } | undefined;
  /** Asks for another page; undefined while the tracker has no more, or one is on its way. */
  more: (() => void) | undefined;
  /** tet.json's `issues`, where it has one. */
  source: string | undefined;
  /** Where the list was read from; undefined until a list came, and after one that failed. */
  tracker: IssueListResult["tracker"];
  /** No account is added for the tracker. */
  noAccount: boolean;
  options: IssueOptions;
  busy: boolean;
  reload: () => void;
  /** Runs a write of the section's own under its bar, answering its result: gone through, the list is
   *  read again, the bar held until it has come. */
  write: <T extends { ok: boolean }>(action: () => Promise<T>) => Promise<T>;
}

/**
 * The project's issues under `filter` whose titles hold `text`, read from its tracker while the lane
 * is shown: nothing is read before, and nothing again until the filter, the text, tet.json or an
 * issue changes through its tab, `reload` is called, or the tracker says the list is out of date. It
 * is asked on every return of the lane or the window and then every `CHECK_MS`, in one request
 * however long the list. The first `ISSUE_PAGE` are read, a page more on each `more`, and as many
 * again on every read after, so the rows scrolled to stay; another filter or text starts over at one
 * page. The text is sent once the typing stops. A list that came has the tabs read again whose issue
 * it shows changed. What the filters offer comes once a list came, so one failure is told once. Held
 * per project by the caller's `key`.
 */
export function useIssues(projectId: string, filter: IssueFilter, text: string, shown: boolean): Issues {
  const [issues, setIssues] = useState<Issue[]>();
  const [total, setTotal] = useState<number>();
  const [read, setRead] = useState<Issues["read"]>();
  const [source, setSource] = useState<string>();
  const [tracker, setTracker] = useState<IssueListResult["tracker"]>();
  const [noAccount, setNoAccount] = useState(false);
  const [options, setOptions] = useState(NO_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((current) => current + 1), []);
  const [held, setHeld] = useState(false);
  /** A list is on its way that ends the hold. */
  const releaseOnList = useRef(false);
  const write = useCallback(
    async <T extends { ok: boolean }>(action: () => Promise<T>): Promise<T> => {
      setHeld(true);
      const result = await action();
      if (result.ok) {
        releaseOnList.current = true;
        reload();
      } else {
        setHeld(false);
      }
      return result;
    },
    [reload],
  );
  /** How the next read is made: "quiet" as it follows what an issue's tab did, whose own bar says it is
   *  busy; "unasked" as it follows the tracker's saying the list is out of date, a failure leaving the
   *  list as it is and telling nothing, as nobody asked for that read. */
  const nextRead = useRef<"asked" | "quiet" | "unasked">("asked");

  useEffect(
    () =>
      window.tet.commands.onChanged((changed) => {
        if (changed.projectId === projectId) {
          reload();
        }
      }),
    [projectId, reload],
  );

  useEffect(() => subscribeAccounts(reload), [reload]);

  useEffect(
    () =>
      subscribeIssues((changed) => {
        if (changed === projectId) {
          nextRead.current = "quiet";
          reload();
        }
      }),
    [projectId, reload],
  );

  const [sent, setSent] = useState(text.trim());
  useEffect(() => {
    const typed = text.trim();
    if (typed === "") {
      setSent("");
      return;
    }
    const timer = setTimeout(() => setSent(typed), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  const filterKey = JSON.stringify(sent === "" ? filter : { ...filter, text: sent });
  /** How many are asked for under the filter: one page under one not asked for before. */
  const [paged, setPaged] = useState({ filterKey, limit: ISSUE_PAGE });
  const limit = paged.filterKey === filterKey ? paged.limit : ISSUE_PAGE;
  const loaded = useRef<string | undefined>(undefined);
  /** What the tracker said of the list shown when it was read. */
  const latest = useRef<IssuesLatest | undefined>(undefined);
  /** A list is on its way. */
  const reading = useRef(false);
  const checking = useRef(false);
  const optionsLoaded = useRef<number | undefined>(undefined);
  /** The latest list asked for: only its answer counts. */
  const request = useRef(0);
  const mounted = useRef(true);
  useEffect(
    () => () => {
      mounted.current = false;
    },
    [],
  );

  useEffect(() => {
    const key = `${generation}|${filterKey}|${limit}`;
    if (!shown || loaded.current === key) {
      return;
    }
    loaded.current = key;
    reading.current = true;
    const asked = ++request.current;
    const how = nextRead.current;
    nextRead.current = "asked";
    if (how === "asked") {
      setBusy(true);
    }
    void window.tet.issues.list(projectId, JSON.parse(filterKey) as IssueFilter, limit).then((result) => {
      if (!mounted.current || asked !== request.current) {
        return;
      }
      reading.current = false;
      setBusy(false);
      if (releaseOnList.current) {
        releaseOnList.current = false;
        setHeld(false);
      }
      if (how === "unasked" && result.error !== undefined) {
        return;
      }
      latest.current = result.latest;
      setSource(result.source);
      setTracker(result.tracker);
      setNoAccount(result.noAccount === true);
      setIssues(result.issues ?? []);
      setTotal(result.latest?.total);
      setRead({ filterKey, limit });
      if (result.seen !== undefined) {
        setSeen("issue", projectId, result.seen);
      }
      if (result.error !== undefined) {
        notify("error", result.error);
        return;
      }
      reloadChangedIssueTabs(projectId, result.issues ?? []);
      if (optionsLoaded.current !== generation) {
        optionsLoaded.current = generation;
        void window.tet.issues.filterOptions(projectId).then((answer) => {
          if (!mounted.current) {
            return;
          }
          if (answer.error !== undefined) {
            notify("error", answer.error);
          } else {
            setOptions({ labels: answer.labels ?? [], people: answer.people ?? [] });
          }
        });
      }
    });
  }, [projectId, filterKey, limit, shown, generation]);

  /** Asks the tracker about the list shown, and reads it again where the answer differs. Nothing is
   *  told of a failure: the next check asks again. */
  const check = useCallback(async (): Promise<void> => {
    if (checking.current || reading.current) {
      return;
    }
    checking.current = true;
    const asked = request.current;
    const answer = await window.tet.issues.latest(projectId, JSON.parse(filterKey) as IssueFilter).finally(() => {
      checking.current = false;
    });
    // A list asked for meanwhile has its own answer to go by.
    if (!mounted.current || request.current !== asked || answer.latest === undefined || !differ(latest.current, answer.latest)) {
      return;
    }
    nextRead.current = "unasked";
    reload();
  }, [projectId, filterKey, reload]);

  const focused = useWindowFocused();
  useEffect(() => {
    if (!shown || !focused) {
      return;
    }
    void check();
    const timer = window.setInterval(() => void check(), CHECK_MS);
    return () => window.clearInterval(timer);
  }, [shown, focused, check]);

  // Only for the list last asked for: while a page is on its way, nothing more is asked.
  const hasMore = read?.filterKey === filterKey && read.limit === limit && (issues?.length ?? 0) >= limit;
  const more = useCallback(() => setPaged({ filterKey, limit: limit + ISSUE_PAGE }), [filterKey, limit]);

  return { issues, total, read, more: hasMore ? more : undefined, source, tracker, noAccount, options, busy: busy || held, reload, write };
}
