import { useCallback, useSyncExternalStore } from "react";
import type { Terminal } from "@xterm/xterm";
import {
  annotationAt,
  formatFeedback,
  MOUSE_TRACKING_OFF,
  mouseTrackingOn,
  relocateRange,
  rowSegments,
  textOfRange,
  type Annotation,
  type AnnotationKind,
  type CellRange,
  type MouseTracking,
} from "./annotate-feedback";

/**
 * The annotate mode of agent tabs: what a tab's terminal is marked with, kept outside React as the
 * xterm instances are, and read through `useAnnotate` (editor/editor-views.ts keeps the editor's
 * the same way). A tab is in the mode while it has a session here; ending it drops every mark.
 */

/** Where the right click landed. */
export interface AnnotateMenu {
  x: number;
  y: number;
  /** Text is selected: it can be marked and copied. */
  selected: boolean;
  /** The annotation under the pointer. */
  annotationId?: number;
}

/** The annotation under the pointer, and where it rested. */
export interface AnnotateHover {
  id: number;
  x: number;
  y: number;
}

/** Where an annotation's pill stands in the layer, in pixels: `top` is its row's middle, which the
 *  pill centres on, so its height is its own. */
export interface AnnotationPill {
  id: number;
  number: number;
  kind: AnnotationKind;
  left: number;
  top: number;
}

export interface AnnotateSnapshot {
  active: boolean;
  annotations: readonly Annotation[];
  hover?: AnnotateHover;
  menu?: AnnotateMenu;
  /** Over the whole terminal, above xterm's scrollable element, which would take the pointer from
   *  anything in `.xterm-screen`: the pills are drawn into it (`AnnotateBar`). */
  layer?: HTMLElement;
  pills: readonly AnnotationPill[];
}

/** A tab not in the mode — one instance, so it compares equal. */
const OFF: AnnotateSnapshot = { active: false, annotations: [], pills: [] };

/** The room a pill keeps at the screen's right edge, wide enough for its number and button. */
const PILL_ROOM = 72;

/** What a pill is, for a pointer to tell it from the text under it. */
const PILL_SELECTOR = ".annotation-pill";

/** How soon a text that was looked for in vain is looked for again: the search reads the whole
 *  buffer, and a program that is printing redraws all the time. */
const RELOCATE_INTERVAL_MS = 250;

/** A click moves no more than this and still is no drag. */
const CLICK_SLOP = 3;

interface Session {
  key: string;
  term: Terminal;
  snapshot: AnnotateSnapshot;
  nextId: number;
  /** Types text into the tab's prompt (`terminal-views.ts`). */
  type: (text: string) => void;
  /** The mouse reporting a drag took from the program, put back when it ends. */
  suspended?: MouseTracking;
  /** The overlay's elements, in `.xterm-screen`. */
  marks: HTMLElement[];
  frame?: number;
  /** When an annotation's text was looked for in vain, by its id, and the draw that looks again. */
  failedAt: Map<number, number>;
  retry?: ReturnType<typeof setTimeout>;
  stops: (() => void)[];
}

const sessions = new Map<string, Session>();
const listeners = new Map<string, Set<() => void>>();

function snapshotOf(key: string): AnnotateSnapshot {
  return sessions.get(key)?.snapshot ?? OFF;
}

function notify(key: string): void {
  listeners.get(key)?.forEach((listener) => listener());
}

function subscribe(key: string, listener: () => void): () => void {
  let set = listeners.get(key);
  if (!set) {
    set = new Set();
    listeners.set(key, set);
  }
  set.add(listener);
  return () => {
    set.delete(listener);
    if (set.size === 0) {
      listeners.delete(key);
    }
  };
}

export function useAnnotate(key: string): AnnotateSnapshot {
  const subscribeKey = useCallback((listener: () => void) => subscribe(key, listener), [key]);
  return useSyncExternalStore(subscribeKey, () => snapshotOf(key));
}

export function isAnnotating(key: string): boolean {
  return sessions.has(key);
}

/** Only a change of the annotations redraws the marks; the pointer's moves change the rest. */
function change(session: Session, patch: Partial<AnnotateSnapshot>): void {
  session.snapshot = { ...session.snapshot, ...patch };
  if (patch.annotations) {
    requestDraw(session);
  }
  notify(session.key);
}

function clearHover(session: Session): void {
  if (session.snapshot.hover) {
    change(session, { hover: undefined });
  }
}

function onPill(event: Event): boolean {
  return event.target instanceof Element && event.target.closest(PILL_SELECTOR) !== null;
}

/** The pills only move the store when they differ: a redraw follows every write of the program. */
function setPills(session: Session, pills: readonly AnnotationPill[]): void {
  if (JSON.stringify(session.snapshot.pills) === JSON.stringify(pills)) {
    return;
  }
  session.snapshot = { ...session.snapshot, pills };
  notify(session.key);
}

/** An annotation still lies where it was made: the same buffer, and the same text there. */
function isIntact(term: Terminal, annotation: Annotation): boolean {
  return annotation.buffer === term.buffer.active.type && textOfRange(term.buffer.active, annotation.range) === annotation.text;
}

function screenOf(term: Terminal): HTMLElement | undefined {
  const screen = term.element?.querySelector(".xterm-screen");
  return screen instanceof HTMLElement ? screen : undefined;
}

/** The buffer cell under a pointer, undefined outside the screen. */
function cellAt(term: Terminal, event: MouseEvent): { row: number; col: number } | undefined {
  const screen = screenOf(term);
  if (!screen) {
    return undefined;
  }
  const rect = screen.getBoundingClientRect();
  const col = Math.floor((event.clientX - rect.left) / (rect.width / term.cols));
  const viewportRow = Math.floor((event.clientY - rect.top) / (rect.height / term.rows));
  if (col < 0 || col >= term.cols || viewportRow < 0 || viewportRow >= term.rows) {
    return undefined;
  }
  return { row: term.buffer.active.viewportY + viewportRow, col };
}

function annotationUnder(term: Terminal, annotations: readonly Annotation[], event: MouseEvent): Annotation | undefined {
  const cell = cellAt(term, event);
  const found = cell && annotationAt(annotations, cell.row, cell.col);
  return found && isIntact(term, found) ? found : undefined;
}

/**
 * An annotation follows its text: one whose text left its rows is looked for in the buffer. A text
 * that moved by a few rows, as a scrolling program's does, is found at once; one not found is not
 * looked for again before `RELOCATE_INTERVAL_MS` have passed (a draw comes then), shows no more and
 * stays in the list.
 */
function settle(session: Session): void {
  const { term } = session;
  const buffer = term.buffer.active;
  const now = Date.now();
  const moved = new Map<number, CellRange>();
  let wait = Infinity;
  for (const annotation of session.snapshot.annotations) {
    if (annotation.buffer !== buffer.type || isIntact(term, annotation)) {
      session.failedAt.delete(annotation.id);
      continue;
    }
    const remaining = (session.failedAt.get(annotation.id) ?? 0) + RELOCATE_INTERVAL_MS - now;
    if (remaining > 0) {
      wait = Math.min(wait, remaining);
      continue;
    }
    const range = relocateRange(buffer, buffer.length, annotation.range, annotation.text);
    if (range) {
      moved.set(annotation.id, range);
      session.failedAt.delete(annotation.id);
    } else {
      session.failedAt.set(annotation.id, now);
    }
  }
  if (moved.size > 0) {
    const annotations = session.snapshot.annotations.map((annotation) => {
      const range = moved.get(annotation.id);
      return range ? { ...annotation, range } : annotation;
    });
    session.snapshot = { ...session.snapshot, annotations };
    notify(session.key);
  }
  if (wait < Infinity) {
    session.retry ??= setTimeout(() => {
      session.retry = undefined;
      requestDraw(session);
    }, wait);
  }
}

function requestDraw(session: Session): void {
  session.frame ??= requestAnimationFrame(() => {
    session.frame = undefined;
    draw(session);
  });
}

function clearMarks(session: Session): void {
  for (const element of session.marks) {
    element.remove();
  }
  session.marks = [];
}

/**
 * One element per row of each annotation, and where its pill goes (`AnnotateBar` draws it, with its
 * buttons). Not terminal.registerDecoration(): xterm hides decorations on the alternate screen,
 * where an agent's TUI runs (`links/link-provider.ts`). Redrawn whenever the screen changes; an
 * annotation whose text left its place shows no more, and stays in the list.
 */
function draw(session: Session): void {
  settle(session);
  clearMarks(session);
  const { term } = session;
  const screen = screenOf(term);
  if (!screen) {
    return;
  }
  const cellWidth = screen.clientWidth / term.cols;
  const cellHeight = screen.clientHeight / term.rows;
  // The layer covers the terminal's element; the screen may stand inside it.
  const screenBox = screen.getBoundingClientRect();
  const layerBox = (session.snapshot.layer ?? screen).getBoundingClientRect();
  const offsetX = screenBox.left - layerBox.left;
  const offsetY = screenBox.top - layerBox.top;
  const pills: AnnotationPill[] = [];
  session.snapshot.annotations.forEach((annotation, index) => {
    if (!isIntact(term, annotation)) {
      return;
    }
    let last: { top: number; endCol: number } | undefined;
    for (const segment of rowSegments(annotation.range, term.cols)) {
      const viewportRow = segment.row - term.buffer.active.viewportY;
      if (viewportRow < 0 || viewportRow >= term.rows) {
        continue;
      }
      const mark = document.createElement("div");
      mark.className = `annotation-mark annotation-kind-${annotation.kind}`;
      const top = viewportRow * cellHeight;
      mark.style.left = `${segment.startCol * cellWidth}px`;
      mark.style.top = `${top}px`;
      mark.style.width = `${(segment.endCol - segment.startCol) * cellWidth}px`;
      mark.style.height = `${cellHeight}px`;
      screen.appendChild(mark);
      session.marks.push(mark);
      last = { top, endCol: segment.endCol };
    }
    if (last) {
      // Right after the marked text; kept on screen where that ends at the edge.
      pills.push({
        id: annotation.id,
        number: index + 1,
        kind: annotation.kind,
        left: offsetX + Math.min(last.endCol * cellWidth, screen.clientWidth - PILL_ROOM),
        top: offsetY + last.top + cellHeight / 2,
      });
    }
  });
  setPills(session, pills);
}

/**
 * Puts the tab's terminal in the mode. Where a TUI has the mouse, xterm does not select, so a drag
 * is taken from it: the press is held back, and once the pointer has moved the reporting goes off in
 * xterm alone (the pty is told nothing) and the press is made again, which xterm then selects by;
 * the reporting comes back with the release. A press that does not move is a click: it is the
 * program's, made again for it after the release. The wheel is never touched. `edit` is asked for a
 * click on a comment.
 */
export function startAnnotating(key: string, term: Terminal, edit: (annotationId: number) => void, type: (text: string) => void): void {
  const element = term.element;
  if (sessions.has(key) || !element) {
    return;
  }
  const layer = document.createElement("div");
  layer.className = "annotation-layer";
  element.appendChild(layer);
  const session: Session = {
    key,
    term,
    snapshot: { active: true, annotations: [], layer, pills: [] },
    nextId: 1,
    type,
    marks: [],
    failedAt: new Map(),
    stops: [],
  };
  sessions.set(key, session);
  session.stops.push(() => layer.remove());
  const keep = (disposable: { dispose(): void }): void => {
    session.stops.push(() => disposable.dispose());
  };

  const redraw = (): void => requestDraw(session);
  keep(term.onScroll(redraw));
  keep(term.onWriteParsed(redraw));
  keep(term.onResize(redraw));
  keep(term.buffer.onBufferChange(redraw));

  const on = <K extends keyof HTMLElementEventMap>(type: K, listener: (event: HTMLElementEventMap[K]) => void, capture = false): void => {
    element.addEventListener(type, listener, capture);
    session.stops.push(() => element.removeEventListener(type, listener, capture));
  };

  /** A click on a comment asks for its edit, and is no one else's. */
  const editsComment = (event: MouseEvent): boolean => {
    const clicked = annotationUnder(term, session.snapshot.annotations, event);
    if (clicked?.kind !== "comment") {
      return false;
    }
    edit(clicked.id);
    return true;
  };

  // The left press that a program with the mouse is not given yet, until it is a click or a drag:
  // `pending`, then `starting` while xterm is switched to selecting, then `selecting`.
  let press: { target: EventTarget | null; x: number; y: number; phase: "pending" | "starting" | "selecting" } | undefined;
  // Our own presses, which the listeners below let through.
  let remaking = false;
  const remake = (type: "mousedown" | "mouseup", held: NonNullable<typeof press>): void => {
    remaking = true;
    try {
      (held.target ?? element).dispatchEvent(
        new MouseEvent(type, {
          bubbles: true,
          cancelable: true,
          view: window,
          clientX: held.x,
          clientY: held.y,
          // xterm starts a selection only on a single click (`detail` 1), and a made event has 0.
          detail: 1,
          button: 0,
          buttons: type === "mousedown" ? 1 : 0,
        }),
      );
    } finally {
      remaking = false;
    }
  };
  const onMove = (event: MouseEvent): void => {
    const held = press;
    if (!held || held.phase === "selecting") {
      return;
    }
    // Not the program's either: motion without a press.
    event.stopPropagation();
    if (held.phase === "starting" || Math.hypot(event.clientX - held.x, event.clientY - held.y) < CLICK_SLOP) {
      return;
    }
    held.phase = "starting";
    session.suspended = term.modes.mouseTrackingMode;
    // Without the reporting xterm turns the wheel on an alternate screen into arrow keys.
    term.attachCustomWheelEventHandler(() => term.buffer.active.type !== "alternate");
    term.write(MOUSE_TRACKING_OFF, () => {
      // A release before xterm was switched has ended the press already.
      if (press === held) {
        held.phase = "selecting";
        remake("mousedown", held);
      }
    });
  };
  const stopPress = (): void => {
    document.removeEventListener("mousemove", onMove, true);
    document.removeEventListener("mouseup", onRelease, true);
  };
  function onRelease(event: MouseEvent): void {
    const held = press;
    press = undefined;
    stopPress();
    if (!held) {
      return;
    }
    if (held.phase !== "pending") {
      // xterm ends its selection with this release. The reporting stays off while the selection
      // stands: turning it on again clears it (`SelectionService.disable`).
      if (!term.hasSelection()) {
        restoreTracking(session);
      }
      return;
    }
    event.stopPropagation();
    if (!editsComment(event)) {
      remake("mousedown", held);
      remake("mouseup", held);
    }
  }
  session.stops.push(stopPress);
  // The program has the mouse again once the selection is gone: a click, or a mark made of it.
  keep(
    term.onSelectionChange(() => {
      if (!press && !term.hasSelection()) {
        restoreTracking(session);
      }
    }),
  );

  // Before xterm's own: a press on a pill is the pill's, and a left press where a program has the
  // mouse is held back. Elsewhere xterm selects for itself.
  let pressed: { x: number; y: number } | undefined;
  on(
    "mousedown",
    (event) => {
      if (remaking) {
        return;
      }
      if (onPill(event)) {
        event.stopPropagation();
        return;
      }
      clearHover(session);
      pressed = event.button === 0 ? { x: event.clientX, y: event.clientY } : undefined;
      if (event.button !== 0) {
        // The right button opens the mode's menu: a program with the mouse would paste on it.
        if (event.button === 2 && term.modes.mouseTrackingMode !== "none") {
          event.stopPropagation();
        }
        return;
      }
      if (term.modes.mouseTrackingMode === "none") {
        return;
      }
      event.stopPropagation();
      event.preventDefault();
      term.focus();
      press = { target: event.target, x: event.clientX, y: event.clientY, phase: "pending" };
      document.addEventListener("mousemove", onMove, true);
      document.addEventListener("mouseup", onRelease, true);
    },
    true,
  );
  on("mouseup", (event) => {
    const down = pressed;
    pressed = undefined;
    if (
      onPill(event) ||
      !down ||
      event.button !== 0 ||
      Math.hypot(event.clientX - down.x, event.clientY - down.y) >= CLICK_SLOP ||
      term.hasSelection()
    ) {
      return;
    }
    editsComment(event);
  });
  on("mousemove", (event) => {
    // The pill says for itself what it holds (`setHover`).
    if (onPill(event)) {
      return;
    }
    // A drag selects; the pointer resting on a mark says what it holds.
    const found = event.buttons === 0 ? annotationUnder(term, session.snapshot.annotations, event) : undefined;
    if (found?.id !== session.snapshot.hover?.id) {
      change(session, { hover: found && { id: found.id, x: event.clientX, y: event.clientY } });
    }
  });
  on("mouseleave", () => clearHover(session));
  // Before the container's own listener (terminal-views.ts), which copies or pastes: here the right
  // button opens the mode's menu.
  on("contextmenu", (event) => {
    event.preventDefault();
    event.stopPropagation();
    const under = annotationUnder(term, session.snapshot.annotations, event);
    change(session, {
      hover: undefined,
      menu: { x: event.clientX, y: event.clientY, selected: term.hasSelection(), annotationId: under?.id },
    });
  });

  notify(key);
}

/** The program has the mouse again, after a drag took it. */
function restoreTracking(session: Session): void {
  if (session.suspended !== undefined) {
    session.term.write(mouseTrackingOn(session.suspended));
    session.term.attachCustomWheelEventHandler(() => true);
    session.suspended = undefined;
  }
}

/** The pointer came onto an annotation's pill, or left it. */
export function setHover(key: string, hover: AnnotateHover | undefined): void {
  const session = sessions.get(key);
  if (session && session.snapshot.hover?.id !== hover?.id) {
    change(session, { hover });
  }
}

function end(key: string): Session | undefined {
  const session = sessions.get(key);
  if (!session) {
    return undefined;
  }
  sessions.delete(key);
  for (const stop of session.stops) {
    stop();
  }
  if (session.frame !== undefined) {
    cancelAnimationFrame(session.frame);
  }
  clearTimeout(session.retry);
  clearMarks(session);
  notify(key);
  return session;
}

/** Ends the mode: every mark goes, and the mouse reporting comes back if a drag has it. */
export function stopAnnotating(key: string): void {
  const session = end(key);
  if (session) {
    restoreTracking(session);
  }
}

/** Ends the mode of a terminal being disposed: nothing more is written to it. */
export function dropAnnotating(key: string): void {
  end(key);
}

/** What the selection covers, read before a question for the mark made after it: the program may
 *  have switched screens meanwhile. */
export type SelectedText = Pick<Annotation, "range" | "text" | "buffer">;

export function readSelection(key: string): SelectedText | undefined {
  const term = sessions.get(key)?.term;
  const position = term?.getSelectionPosition();
  if (!term || !position) {
    return undefined;
  }
  // 0-based columns and absolute rows, the end column exclusive.
  const range = { startRow: position.start.y, startCol: position.start.x, endRow: position.end.y, endCol: position.end.x };
  const text = textOfRange(term.buffer.active, range);
  return text === "" ? undefined : { range, text, buffer: term.buffer.active.type };
}

export function addAnnotation(key: string, kind: AnnotationKind, selected: SelectedText, comment?: string): void {
  const session = sessions.get(key);
  if (!session) {
    return;
  }
  const annotation: Annotation = { ...selected, id: session.nextId++, kind, comment };
  session.term.clearSelection();
  change(session, { annotations: [...session.snapshot.annotations, annotation] });
}

export function annotationOf(key: string, annotationId: number): Annotation | undefined {
  return sessions.get(key)?.snapshot.annotations.find((annotation) => annotation.id === annotationId);
}

export function setComment(key: string, annotationId: number, comment: string): void {
  const session = sessions.get(key);
  if (session) {
    change(session, { annotations: session.snapshot.annotations.map((a) => (a.id === annotationId ? { ...a, comment } : a)) });
  }
}

export function removeAnnotation(key: string, annotationId: number): void {
  const session = sessions.get(key);
  if (session) {
    change(session, { annotations: session.snapshot.annotations.filter((a) => a.id !== annotationId), hover: undefined });
  }
}

/** Every annotation goes; the mode stays. */
export function clearAnnotations(key: string): void {
  const session = sessions.get(key);
  if (session) {
    change(session, { annotations: [], hover: undefined });
  }
}

export function closeMenu(key: string): void {
  const session = sessions.get(key);
  if (session?.snapshot.menu) {
    change(session, { menu: undefined });
  }
}

/** Types the feedback into the agent's prompt, without Enter, and ends the mode. Typed, not pasted:
 *  an agent may fold a paste into a placeholder the user cannot add to. */
export function sendAnnotations(key: string): void {
  const session = sessions.get(key);
  if (!session || session.snapshot.annotations.length === 0) {
    return;
  }
  const { term } = session;
  const feedback = formatFeedback(session.snapshot.annotations);
  stopAnnotating(key);
  session.type(feedback);
  term.focus();
}
