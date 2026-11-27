import { useLayoutEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { ProjectRef } from "../../shared/types/project";
import { ContextMenu, SEPARATOR, type ContextMenuEntry } from "../ui/ContextMenu";
import { IconButton } from "../ui/IconButton";
import { CloseIcon, SendIcon } from "../ui/icons";
import { commentOnSelection } from "./annotate-comment";
import { KIND_LABELS, type AnnotationKind } from "./annotate-feedback";
import {
  addAnnotation,
  clearAnnotations,
  closeMenu,
  copySelectedText,
  readSelection,
  removeAnnotation,
  sendAnnotations,
  setHover,
  stopAnnotating,
  useAnnotate,
  type AnnotateMenu,
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
    SEPARATOR,
    { label: "Copy", run: menu.selected ? () => copySelectedText(key) : undefined },
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
}

/**
 * The annotate mode's bar over a terminal on screen, as the editor tab's (`TerminalHost` mounts it):
 * what sends the annotations, what cancels the mode (every annotation goes with it) and how many
 * there are. What marks the selection is the terminal's right-click menu, drawn here too, as are the
 * annotations' pills over the text and the popup of the one under the pointer.
 */
export function AnnotateBar({ at, tabId }: AnnotateBarProps) {
  const key = viewKey(at, tabId);
  const { annotations, hover, menu, pills, layer } = useAnnotate(key);
  const count = annotations.length;
  const hovered = hover && annotations.find((annotation) => annotation.id === hover.id);
  return (
    <>
      <div className="editor-bar annotate-bar">
        <div className="toolbar editor-bar-actions">
          <IconButton title="Send to Agent" disabled={count === 0} onClick={() => sendAnnotations(key)}>
            <SendIcon />
          </IconButton>
          <IconButton title="Cancel Annotating" onClick={() => stopAnnotating(key)}>
            <CloseIcon />
          </IconButton>
        </div>
        <span className="label-pill">{count === 1 ? "1 annotation" : `${count} annotations`}</span>
      </div>
      {layer &&
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
      {menu && <ContextMenu x={menu.x} y={menu.y} entries={menuEntries(key, menu, count)} onClose={() => closeMenu(key)} />}
      {hover && hovered && (
        <AnnotatePopup x={hover.x} y={hover.y}>
          <div className="annotate-popup-title">
            {KIND_LABELS[hovered.kind]} {annotations.indexOf(hovered) + 1}
          </div>
          {hovered.comment}
        </AnnotatePopup>
      )}
    </>
  );
}
