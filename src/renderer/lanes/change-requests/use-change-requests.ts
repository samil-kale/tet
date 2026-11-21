import { useCallback, useEffect, useRef, useState } from "react";
import type {
  ChangeRequestFilter,
  ChangeRequestKind,
  ChangeRequestListResult,
  ChangeRequestRow,
  ChangeRequestsLatest,
} from "../../../shared/types/providers";
import { subscribeIssues } from "../../editor/editor-tab";
import { reloadChangedChangeRequestTabs, type IssueOptions } from "../../editor/editor-views";
import { setSeen } from "../../editor/tracked-seen";
import { subscribeAccounts } from "../../git/ProviderAccount";
import { notify } from "../../ui/Notices";
import { useWindowFocused } from "../../ui/use-window-focused";

const NO_OPTIONS: IssueOptions = { labels: [], people: [] };

/** How often the host is asked whether the list shown is out of date, while the lane is shown and
 *  the window focused, as the Issues section asks. */
const CHECK_MS = 15_000;

/** Change requests asked for at first, and added by each `more`, as `useIssues` pages its issues. */
const CHANGE_REQUEST_PAGE = 20;

/** Typing searches the host once the typing stops, as `useIssues` waits. */
const SEARCH_DELAY_MS = 300;

/** Whether two answers of the host differ: the list they stand for, or its checks, changed. */
function differ(shown: ChangeRequestsLatest | undefined, found: ChangeRequestsLatest): boolean {
  return shown?.total !== found.total || shown.updatedAt !== found.updatedAt || shown.checks !== found.checks;
}

interface ChangeRequests {
  /** Undefined until the first answer. */
  changeRequests: ChangeRequestRow[] | undefined;
  /** How many the host counts under the filter, those not read yet among them. */
  total: number | undefined;
  /** What `changeRequests` were read under: their filter with its text, and how many were asked for. */
  read: { filterKey: string; limit: number } | undefined;
  /** Asks for another page; undefined while the host has no more, or one is on its way. */
  more: (() => void) | undefined;
  /** What the host calls one; undefined until it is known. */
  kind: ChangeRequestKind | undefined;
  /** No account is added for the host. */
  noAccount: boolean;
  options: IssueOptions;
  busy: boolean;
  reload: () => void;
}

/**
 * The project's change requests under `filter` whose titles hold `text`, read from its repository's
 * remote while the lane is shown, as `useIssues` reads its issues: nothing is read before, and nothing
 * again until the filter, the text or one changes through its tab, `reload` is called, or the host
 * says the list or its checks are out of date; a page at a time, as many again on every read after. A
 * list that came has the tabs read again whose change request it shows changed. Held per project by
 * the caller's `key`.
 */
export function useChangeRequests(projectId: string, filter: ChangeRequestFilter, text: string, shown: boolean): ChangeRequests {
  const [changeRequests, setChangeRequests] = useState<ChangeRequestRow[]>();
  const [total, setTotal] = useState<number>();
  const [read, setRead] = useState<ChangeRequests["read"]>();
  const [kind, setKind] = useState<ChangeRequestKind>();
  const [noAccount, setNoAccount] = useState(false);
  const [options, setOptions] = useState(NO_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((current) => current + 1), []);
  /** How the next read is made, as `useIssues` makes it. */
  const nextRead = useRef<"asked" | "quiet" | "unasked">("asked");

  useEffect(() => subscribeAccounts(reload), [reload]);

  useEffect(
    () =>
      subscribeIssues((changed) => {
        if (changed === projectId) {
          nextRead.current = "quiet";
          reload();
        }
      }, "change-request"),
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
  const [paged, setPaged] = useState({ filterKey, limit: CHANGE_REQUEST_PAGE });
  const limit = paged.filterKey === filterKey ? paged.limit : CHANGE_REQUEST_PAGE;
  const loaded = useRef<string | undefined>(undefined);
  /** What the host said of the list shown when it was read. */
  const latest = useRef<ChangeRequestsLatest | undefined>(undefined);
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
    void window.tet.changeRequests
      .list(projectId, JSON.parse(filterKey) as ChangeRequestFilter, limit)
      .then((result: ChangeRequestListResult) => {
        if (!mounted.current || asked !== request.current) {
          return;
        }
        reading.current = false;
        setBusy(false);
        if (how === "unasked" && result.error !== undefined) {
          return;
        }
        latest.current = result.latest;
        setKind(result.kind);
        setNoAccount(result.noAccount === true);
        setChangeRequests(result.changeRequests ?? []);
        setTotal(result.latest?.total);
        setRead({ filterKey, limit });
        if (result.seen !== undefined) {
          setSeen("change-request", projectId, result.seen);
        }
        if (result.error !== undefined) {
          notify("error", result.error);
          return;
        }
        reloadChangedChangeRequestTabs(projectId, result.changeRequests ?? []);
        if (optionsLoaded.current !== generation) {
          optionsLoaded.current = generation;
          void window.tet.changeRequests.filterOptions(projectId).then((answer) => {
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

  /** Asks the host about the list shown, and reads it again where the answer differs. Nothing is told
   *  of a failure: the next check asks again. */
  const check = useCallback(async (): Promise<void> => {
    if (checking.current || reading.current) {
      return;
    }
    checking.current = true;
    const asked = request.current;
    const answer = await window.tet.changeRequests.latest(projectId, JSON.parse(filterKey) as ChangeRequestFilter).finally(() => {
      checking.current = false;
    });
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
  const hasMore = read?.filterKey === filterKey && read.limit === limit && (changeRequests?.length ?? 0) >= limit;
  const more = useCallback(() => setPaged({ filterKey, limit: limit + CHANGE_REQUEST_PAGE }), [filterKey, limit]);

  return { changeRequests, total, read, more: hasMore ? more : undefined, kind, noAccount, options, busy, reload };
}
