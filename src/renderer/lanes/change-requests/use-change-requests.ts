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

/** Whether two answers of the host differ: the list they stand for, or its checks, changed. */
function differ(shown: ChangeRequestsLatest | undefined, found: ChangeRequestsLatest): boolean {
  return shown?.total !== found.total || shown.updatedAt !== found.updatedAt || shown.checks !== found.checks;
}

interface ChangeRequests {
  /** Undefined until the first answer. */
  changeRequests: ChangeRequestRow[] | undefined;
  /** What the host calls one; undefined until it is known. */
  kind: ChangeRequestKind | undefined;
  /** No account is added for the host. */
  noAccount: boolean;
  options: IssueOptions;
  busy: boolean;
  reload: () => void;
}

/**
 * The project's change requests under `filter`, read from its repository's remote while the lane is
 * shown, as `useIssues` reads its issues: nothing is read before, and nothing again until the filter
 * or one changes through its tab, `reload` is called, or the host says the list or its checks are out
 * of date. A list that came has the tabs read again whose change request it shows changed. Held per
 * project by the caller's `key`.
 */
export function useChangeRequests(projectId: string, filter: ChangeRequestFilter, shown: boolean): ChangeRequests {
  const [changeRequests, setChangeRequests] = useState<ChangeRequestRow[]>();
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

  const filterKey = JSON.stringify(filter);
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
    const key = `${generation}|${filterKey}`;
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
    void window.tet.changeRequests.list(projectId, JSON.parse(filterKey) as ChangeRequestFilter).then((result: ChangeRequestListResult) => {
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
  }, [projectId, filterKey, shown, generation]);

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

  return { changeRequests, kind, noAccount, options, busy, reload };
}
