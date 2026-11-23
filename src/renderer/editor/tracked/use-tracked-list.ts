import { useCallback, useEffect, useRef, useState } from "react";
import type { TrackedRow, TrackedFilterOptions, TrackedLatest, TrackedListResult, TrackedSeen } from "../../../shared/types/providers";
import { notify } from "../../ui/Notices";
import { useWindowFocused } from "../../ui/use-window-focused";

/** What a section's filters offer, off its host. */
export interface TrackedOptions {
  labels: string[];
  /** Offered for every filter that names a person. */
  people: string[];
}

const NO_OPTIONS: TrackedOptions = { labels: [], people: [] };

/** How often the host is asked whether the list shown is out of date, while the lane is shown and
 *  the window focused. */
const CHECK_MS = 15_000;

/** Rows asked for at first, and added by each `more`. */
const PAGE = 20;

/** Typing searches the host, as the Graph's search runs — but only once the typing stops. */
const SEARCH_DELAY_MS = 300;

/** How a section reads its list (`useTrackedList`): a constant of the section's, never changing. */
export interface TrackedListSource<F extends object, T extends TrackedRow, L extends TrackedLatest, R extends TrackedListResult<T, L>> {
  /** At least `limit` from the start, or from `after` for a page more. */
  list(projectId: string, filter: F, limit: number, after?: string): Promise<R>;
  latest(projectId: string, filter: F): Promise<{ latest?: L }>;
  filterOptions(projectId: string): Promise<TrackedFilterOptions>;
  /** Whether two answers of the host differ: the list they stand for has changed. */
  differ(shown: L | undefined, found: L): boolean;
  /** A list came from the start, with what the project's tabs showed of the kind. */
  seen(projectId: string, seen: TrackedSeen): void;
  /** Rows came: the tabs whose one they show changed read it again. */
  changed(projectId: string, items: T[]): void;
  /** What has the list read again: `quiet` as it follows what a tab did, whose own bar says it is
   *  busy. Answers the unsubscribe. */
  subscribe(projectId: string, reread: (quiet: boolean) => void): () => void;
}

/** The rows read and what came with them, under the filter (with its text) they were read under. */
interface Read<T, R> {
  filterKey: string;
  items: T[];
  /** Where the next page starts; undefined once the host has no more. */
  after: string | undefined;
  /** How many pages were added to the first: a page more is no change the host made. */
  pages: number;
  /** The last list read from the start. */
  result: R;
}

export interface TrackedList<T, R> {
  /** Undefined until the first answer. */
  items: T[] | undefined;
  /** The last list read from the start, for what the section shows beside its rows. */
  result: R | undefined;
  /** How many the host counts under the filter, those not read yet among them. */
  total: number | undefined;
  /** What the rows were read under, for `useTrackedRows`: a filter of its own, or a page more, comes
   *  as it is. */
  rowsKey: { filterKey: string; pages: number } | undefined;
  /** Asks for another page; undefined while the host has no more, or a read is on its way. */
  more: (() => void) | undefined;
  options: TrackedOptions;
  busy: boolean;
  reload: () => void;
  /** Runs a write of the section's own under its bar, answering its result: gone through, the list is
   *  read again, the bar held until it has come. */
  write: <W extends { ok: boolean }>(action: () => Promise<W>) => Promise<W>;
}

/**
 * The project's issues or change requests under `filter` whose titles hold `text`, read from the host
 * while the lane is shown: nothing is read before, and nothing again until the filter, the text or
 * what `source.subscribe` hears of changes, `reload` is called, or the host says the list is out of
 * date. It is asked on every return of the lane or the window and then every `CHECK_MS`, in one
 * request however long the list. A page is read at first, the next one after the last on each `more`,
 * and as many as shown again on every read from the start, so the rows scrolled to stay; another
 * filter or text starts over at one page. The text is sent once the typing stops. What the filters
 * offer comes once a list came, so one failure is told once. Held per project by the caller's `key`.
 */
export function useTrackedList<F extends object, T extends TrackedRow, L extends TrackedLatest, R extends TrackedListResult<T, L>>(
  source: TrackedListSource<F, T, L, R>,
  projectId: string,
  filter: F,
  text: string,
  shown: boolean,
): TrackedList<T, R> {
  const [read, setRead] = useState<Read<T, R>>();
  const [options, setOptions] = useState(NO_OPTIONS);
  const [busy, setBusy] = useState(false);
  /** A read of either kind is on its way. */
  const [pending, setPending] = useState(false);
  const [generation, setGeneration] = useState(0);
  const reload = useCallback(() => setGeneration((current) => current + 1), []);
  const [held, setHeld] = useState(false);
  /** A list is on its way that ends the hold. */
  const releaseOnList = useRef(false);
  const write = useCallback(
    async <W extends { ok: boolean }>(action: () => Promise<W>): Promise<W> => {
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
  /** How the next read is made: "quiet" as it follows what a tab did, whose own bar says it is busy;
   *  "unasked" as it follows the host's saying the list is out of date, a failure leaving the list as
   *  it is and telling nothing, as nobody asked for that read. */
  const nextRead = useRef<"asked" | "quiet" | "unasked">("asked");

  useEffect(
    () =>
      source.subscribe(projectId, (quiet) => {
        if (quiet) {
          nextRead.current = "quiet";
        }
        reload();
      }),
    [source, projectId, reload],
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
  const loaded = useRef<string | undefined>(undefined);
  /** What the host said of the list shown when it was read. */
  const latest = useRef<L | undefined>(undefined);
  const reading = useRef(false);
  const checking = useRef(false);
  const optionsLoaded = useRef<number | undefined>(undefined);
  /** The latest read asked for: only its answer counts. */
  const request = useRef(0);
  /** How many rows the list shows under its filter: a read from the start asks for as many. */
  const shownCount = useRef({ filterKey, count: 0 });
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
    setPending(true);
    const asked = ++request.current;
    const how = nextRead.current;
    nextRead.current = "asked";
    if (how === "asked") {
      setBusy(true);
    }
    const limit = Math.max(PAGE, shownCount.current.filterKey === filterKey ? shownCount.current.count : 0);
    void source.list(projectId, JSON.parse(filterKey) as F, limit).then((result) => {
      if (!mounted.current || asked !== request.current) {
        return;
      }
      reading.current = false;
      setPending(false);
      setBusy(false);
      if (releaseOnList.current) {
        releaseOnList.current = false;
        setHeld(false);
      }
      if (how === "unasked" && result.error !== undefined) {
        return;
      }
      latest.current = result.latest;
      const items = result.items ?? [];
      shownCount.current = { filterKey, count: items.length };
      setRead((before) => ({ filterKey, items, after: result.after, pages: before?.filterKey === filterKey ? before.pages : 0, result }));
      if (result.seen !== undefined) {
        source.seen(projectId, result.seen);
      }
      if (result.error !== undefined) {
        notify("error", result.error);
        return;
      }
      source.changed(projectId, items);
      if (optionsLoaded.current !== generation) {
        optionsLoaded.current = generation;
        void source.filterOptions(projectId).then((answer) => {
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
  }, [source, projectId, filterKey, shown, generation]);

  /** Asks the host about the list shown, and reads it again where the answer differs. Nothing is told
   *  of a failure: the next check asks again. */
  const check = useCallback(async (): Promise<void> => {
    if (checking.current || reading.current) {
      return;
    }
    checking.current = true;
    const asked = request.current;
    const answer = await source.latest(projectId, JSON.parse(filterKey) as F).finally(() => {
      checking.current = false;
    });
    // A list asked for meanwhile has its own answer to go by.
    if (!mounted.current || request.current !== asked || answer.latest === undefined || !source.differ(latest.current, answer.latest)) {
      return;
    }
    nextRead.current = "unasked";
    reload();
  }, [source, projectId, filterKey, reload]);

  const focused = useWindowFocused();
  useEffect(() => {
    if (!shown || !focused) {
      return;
    }
    void check();
    const timer = window.setInterval(() => void check(), CHECK_MS);
    return () => window.clearInterval(timer);
  }, [shown, focused, check]);

  /** The page after the rows shown, added to them; one the host moved meanwhile is shown once. */
  const more = useCallback(() => {
    if (read?.after === undefined || reading.current) {
      return;
    }
    reading.current = true;
    setPending(true);
    const asked = ++request.current;
    void source.list(projectId, JSON.parse(read.filterKey) as F, PAGE, read.after).then((result) => {
      if (!mounted.current || asked !== request.current) {
        return;
      }
      reading.current = false;
      setPending(false);
      if (result.error !== undefined) {
        notify("error", result.error);
        return;
      }
      const known = new Set(read.items.map((item) => item.number));
      const added = (result.items ?? []).filter((item) => !known.has(item.number));
      const items = [...read.items, ...added];
      shownCount.current = { filterKey: read.filterKey, count: items.length };
      setRead({ ...read, items, after: result.after, pages: read.pages + 1 });
      source.changed(projectId, added);
    });
  }, [read, source, projectId]);

  const hasMore = read?.filterKey === filterKey && read.after !== undefined && !pending;

  return {
    items: read?.items,
    result: read?.result,
    total: read?.result.latest?.total,
    rowsKey: read && { filterKey: read.filterKey, pages: read.pages },
    more: hasMore ? more : undefined,
    options,
    busy: busy || held,
    reload,
    write,
  };
}
