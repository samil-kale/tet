import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ProjectRef } from "../../shared/types/project";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { IconButton } from "../ui/IconButton";
import { CloseIcon, SendIcon } from "../ui/icons";
import { CLOSE_MS } from "../ui/use-closing";
import { commentOnSelection } from "./annotate-comment";
import { KIND_LABELS, type AnnotationKind } from "./annotate-feedback";
import {
  addAnnotation,
  clearAnnotations,
  closeMenu,
  readSelection,
  removeAnnotation,
  sendAnnotations,
  setHover,
  stopAnnotating,
  useAnnotate,
  type AnnotateMenu,
  type AnnotateSnapshot,
} from "./annotate-views";
import { viewKey } from "./terminal-views";

/** How far the popup stands off the pointer. */
const POPUP_OFFSET = 14;

function menuEntries(key: string, menu: AnnotateMenu, count: number): ContextMenuEntry[] {
  const mark = (kind: AnnotationKind) =>
    menu.selected
      ? () => {
          const selected = readSelection(key);
          if (selected) {
            addAnnotation(key, kind, selected);
          }
        }
      : undefined;
  const { annotationId } = menu;
  return [
    { label: KIND_LABELS.good, run: mark("good") },
    { label: `${KIND_LABELS.comment}...`, run: menu.selected ? () => void commentOnSelection(key) : undefined },
    { label: KIND_LABELS.delete, run: mark("delete") },
    SEPARATOR,
    { label: "Remove Annotation", run: annotationId === undefined ? undefined : () => removeAnnotation(key, annotationId) },
    { label: "Remove All Annotations", run: count > 0 ? () => clearAnnotations(key) : undefined },
    SEPARATOR,
    { label: "Send to Agent", run: count > 0 ? () => sendAnnotations(key) : undefined },
    { label: "Cancel", run: () => stopAnnotating(key) },
  ];
}

/** Below and right of the pointer, on its other side where the window has no room: placed on the
 *  node before it paints, as `ContextMenu` places itself. */
function AnnotatePopup({ x, y, children }: { x: number; y: number; children: ReactNode }) {
  const popup = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const element = popup.current;
    if (!element) {
      return;
    }
    const { width, height } = element.getBoundingClientRect();
    const left = x + POPUP_OFFSET + width > window.innerWidth ? x - POPUP_OFFSET - width : x + POPUP_OFFSET;
    const top = y + POPUP_OFFSET + height > window.innerHeight ? y - POPUP_OFFSET - height : y + POPUP_OFFSET;
    element.style.left = `${Math.max(0, left)}px`;
    element.style.top = `${Math.max(0, top)}px`;
  });
  return (
    <div ref={popup} className="annotate-popup">
      {children}
    </div>
  );
}

interface AnnotateBarProps {
  at: ProjectRef;
  tabId: string;
  /** The tab is on screen. The bar stays mounted while it is not, hidden, so that coming back to it
   *  does not slide it in again. */
  shown: boolean;
}

/**
 * The annotate mode's bar over a terminal on screen, as the editor tab's (`TerminalHost` mounts it):
 * what sends the annotations, what cancels the mode (every annotation goes with it) and how many
 * there are. What marks the selection is the terminal's right-click menu, drawn here too, as are the
 * annotations' pills over the text and the popup of the one under the pointer.
 *
 * Slides in as a pane's new-tab menu does, and out for `CLOSE_MS` once the mode has ended, showing
 * what it showed last.
 */
export function AnnotateBar({ at, tabId, shown }: AnnotateBarProps) {
  const key = viewKey(at, tabId);
  const snapshot = useAnnotate(key);
  const lastActive = useRef<AnnotateSnapshot | undefined>(undefined);
  const [, leave] = useState(0);
  if (snapshot.active) {
    lastActive.current = snapshot;
  }
  const closing = !snapshot.active && lastActive.current !== undefined;
  useEffect(() => {
    if (!closing) {
      return;
    }
    const timer = setTimeout(() => {
      lastActive.current = undefined;
      leave((left) => left + 1);
    }, CLOSE_MS);
    return () => clearTimeout(timer);
  }, [closing]);
  const view = snapshot.active ? snapshot : lastActive.current;
  if (!view) {
    return null;
  }
  const { annotations, hover, menu, pills, layer } = view;
  const count = annotations.length;
  // The pills, the menu and the popup only where the bar is on screen and not on its way out.
  const live = shown && !closing;
  const hovered = hover && annotations.find((annotation) => annotation.id === hover.id);
  return (
    <>
      <div className={`editor-bar annotate-bar${closing ? " closing" : ""}${shown ? "" : " hidden"}`}>
        <div className="toolbar editor-bar-actions">
          <IconButton title="Send to Agent" disabled={count === 0} onClick={() => sendAnnotations(key)}>
            <SendIcon />
          </IconButton>
          <IconButton title="Cancel" onClick={() => stopAnnotating(key)}>
            <CloseIcon />
          </IconButton>
        </div>
        <span className="label-pill">{count === 1 ? "1 annotation" : `${count} annotations`}</span>
      </div>
      {live &&
        layer &&
        createPortal(
          pills.map((pill) => (
            <div
              key={pill.id}
              className={`annotation-pill annotation-kind-${pill.kind}`}
              style={{ left: pill.left, top: pill.top }}
              onMouseEnter={(event) => setHover(key, { id: pill.id, x: event.clientX, y: event.clientY })}
              onMouseLeave={() => setHover(key, undefined)}
            >
              <span className="annotation-number">{pill.number}</span>
              <IconButton title="Remove Annotation" onClick={() => removeAnnotation(key, pill.id)}>
                <CloseIcon />
              </IconButton>
            </div>
          )),
          layer,
        )}
      {live && menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(key, menu, count)} onClose={() => closeMenu(key)} />}
      {/* Only a comment has something to say; a looks good or a delete says it by its colour. */}
      {live && hover && hovered?.kind === "comment" && (
        <AnnotatePopup x={hover.x} y={hover.y}>
          {hovered.comment}
        </AnnotatePopup>
      )}
    </>
  );
}
