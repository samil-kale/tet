import { useCallback, useEffect, useRef, useState } from "react";
import type { Issue, IssueFilter } from "../../../shared/types/providers";
import { subscribeIssues } from "../../editor/editor-tab";
import { notify } from "../../ui/Notices";

export interface IssueOptions {
  labels: string[];
  people: string[];
}

const NO_OPTIONS: IssueOptions = { labels: [], people: [] };

interface Issues {
  /** Undefined until the first answer. */
  issues: Issue[] | undefined;
  /** tet.json's `issues`, where it has one. */
  source: string | undefined;
  options: IssueOptions;
  busy: boolean;
  reload: () => void;
  /** Runs the bar for work of the section's own, until `releaseBusy` or the next list. */
  holdBusy: () => void;
  releaseBusy: () => void;
  /** The list read again, the bar held until it has come. */
  reloadThenRelease: () => void;
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
  const [options, setOptions] = useState(NO_OPTIONS);
  const [busy, setBusy] = useState(false);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((current) => current + 1), []);
  const [held, setHeld] = useState(false);
  const holdBusy = useCallback(() => setHeld(true), []);
  const releaseBusy = useCallback(() => setHeld(false), []);
  /** A list is on its way that ends the hold. */
  const releaseOnList = useRef(false);
  const reloadThenRelease = useCallback(() => {
    releaseOnList.current = true;
    reload();
  }, [reload]);
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

  return { issues, source, options, busy: busy || held, reload, holdBusy, releaseBusy, reloadThenRelease };
}
