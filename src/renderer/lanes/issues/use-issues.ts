import { useCallback, useEffect, useRef, useState } from "react";
import type { Issue, IssueFilter } from "../../../shared/types/providers";
import { subscribeIssues } from "../../editor/editor-tab";
import type { IssueOptions } from "../../editor/editor-views";
import { subscribeAccounts } from "../../git/ProviderAccount";
import { notify } from "../../ui/Notices";

const NO_OPTIONS: IssueOptions = { labels: [], people: [] };

interface Issues {
  /** Undefined until the first answer. */
  issues: Issue[] | undefined;
  /** tet.json's `issues`, where it has one. */
  source: string | undefined;
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
 * The project's issues under `filter`, read from its tracker while the lane is shown: nothing is
 * read before, and nothing again until the filter, tet.json or an issue changes through its tab or
 * `reload` is called. What
 * the filters offer comes once a list came, so one failure is told once. Held per project by the
 * caller's `key`.
 */
export function useIssues(projectId: string, filter: IssueFilter, shown: boolean): Issues {
  const [issues, setIssues] = useState<Issue[]>();
  const [source, setSource] = useState<string>();
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
  /** The next read follows what an issue's tab did, whose own bar says it is busy. */
  const quiet = useRef(false);

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
          quiet.current = true;
          reload();
        }
      }),
    [projectId, reload],
  );

  const filterKey = JSON.stringify(filter);
  const loaded = useRef<string | undefined>(undefined);
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
    const asked = ++request.current;
    if (!quiet.current) {
      setBusy(true);
    }
    quiet.current = false;
    void window.tet.issues.list(projectId, JSON.parse(filterKey) as IssueFilter).then((result) => {
      if (!mounted.current || asked !== request.current) {
        return;
      }
      setBusy(false);
      if (releaseOnList.current) {
        releaseOnList.current = false;
        setHeld(false);
      }
      setSource(result.source);
      setNoAccount(result.noAccount === true);
      setIssues(result.issues ?? []);
      if (result.error !== undefined) {
        notify("error", result.error);
        return;
      }
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
  }, [projectId, filterKey, shown, generation]);

  return { issues, source, noAccount, options, busy: busy || held, reload, write };
}
