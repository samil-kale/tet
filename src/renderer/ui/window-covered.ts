import { useEffect, useSyncExternalStore, type RefObject } from "react";
import { createStore, useStore } from "./store";

/**
 * The card dialogs (`DialogFrame`) covering the window, the last opened on top. While one does, no
 * tab is on screen: a turn ending behind it keeps its mark and raises a notification. A list, since a
 * question can stand over another dialog.
 */
const covering = createStore<readonly HTMLDialogElement[]>([]);

/** A dialog covers the window while mounted. */
export function useCoversWindow(dialog: RefObject<HTMLDialogElement | null>): void {
  useEffect(() => {
    const element = dialog.current;
    if (!element) {
      return;
    }
    covering.set([...covering.get(), element]);
    return () => covering.set(covering.get().filter((entry) => entry !== element));
  }, [dialog]);
}

/** For a listener outside React. */
export function isWindowCovered(): boolean {
  return covering.get().length > 0;
}

export function useWindowCovered(): boolean {
  return useStore(covering).length > 0;
}

/** The dialog on top: a modal dialog leaves the rest of the window inert and under its dim, so
 *  what must stay live over it is drawn inside it (`Notices`). */
export function useTopDialog(): HTMLDialogElement | undefined {
  return useStore(covering).at(-1);
}

/**
 * What floats over the window's views without covering it: a context menu, the notices, a tab
 * being dragged over the panes, a sash being dragged. A browser tab's page is drawn above the whole
 * window (BrowserHost), so it gives way where one of these overlaps it, as it does to a dialog.
 */
const floating = createStore<readonly Floating[]>([]);

export interface Floating {
  element: Element;
  /** The notices, which a page under them says it waits on (BrowserHost). */
  notice: boolean;
}

/** `element` floats while mounted and `shown`; a change of its box tells the readers again. */
export function useFloatsOver(element: RefObject<Element | null>, shown = true, notice = false): void {
  useEffect(() => {
    const current = element.current;
    if (!shown || !current) {
      return;
    }
    const entry: Floating = { element: current, notice };
    floating.set([...floating.get(), entry]);
    const observer = new ResizeObserver(() => floating.set([...floating.get()]));
    observer.observe(current);
    return () => {
      observer.disconnect();
      floating.set(floating.get().filter((held) => held !== entry));
    };
  }, [element, shown, notice]);
}

const NOTHING_FLOATING: readonly Floating[] = [];
const unwatched = (): (() => void) => () => undefined;
const nothingFloating = (): readonly Floating[] => NOTHING_FLOATING;

/** What floats over the window while `watched`; nothing, and no re-render for its changes, while
 *  not. */
export function useFloating(watched: boolean): readonly Floating[] {
  return useSyncExternalStore(watched ? floating.subscribe : unwatched, watched ? floating.get : nothingFloating);
}
