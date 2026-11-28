import { memo, useRef, type CSSProperties, type PointerEvent } from "react";
import { IconButton } from "../ui/IconButton";
import { CloseIcon, EraserIcon, GripIcon, MessageIcon, SendIcon, ThumbsUpIcon } from "../ui/icons";
import { useStoredShare } from "../ui/layout-storage";
import { commentOnSelection } from "./annotate-comment";
import { ACTION_LABELS, COMMENT_ACTION } from "./annotate-feedback";
import { markSelection, sendAnnotations, stopAnnotating } from "./annotate-views";

/** Where the island stands across the terminal, in layout storage, one for every tab: 0 at its left
 *  edge flush with the terminal's left, 1 flush with its right. */
const ISLAND_SHARE_KEY = "annotate-island";

/** `useStoredShare` keeps only what lies between 0 and 1. */
const MIN_SHARE = 0.001;
const MAX_SHARE = 0.999;

interface AnnotateIslandProps {
  viewKey: string;
  /** Text is selected, for the marks to take. */
  selected: boolean;
  /** How many annotations there are to send. */
  count: number;
  /** The agent stands on a question: what is typed would land in a list of answers, so nothing is
   *  sent. */
  waiting: boolean;
  /** The mode has ended: the island slides out. */
  closing: boolean;
  /** The tab is on screen; hidden while it is not. */
  shown: boolean;
}

/**
 * The annotate mode's island, small, at the terminal's top edge and carried sideways by its grip,
 * within the terminal's width, where the user leaves it (`AnnotateOverlay` draws it): what marks the
 * selection, what sends the annotations and what cancels the mode (every annotation goes with it).
 * Its props hold still while the pointer hovers or the menu opens, which it need not draw for.
 */
export const AnnotateIsland = memo(function AnnotateIsland({ viewKey, selected, count, waiting, closing, shown }: AnnotateIslandProps) {
  const [share, setShare] = useStoredShare(ISLAND_SHARE_KEY, 1 / 2);
  const track = useRef<HTMLDivElement>(null);
  const island = useRef<HTMLDivElement>(null);
  const drag = useRef<{ origin: number; share: number; room: number } | undefined>(undefined);
  // The island is carried by its grip; pointer capture keeps the moves coming over the terminal.
  const grab = (event: PointerEvent<HTMLSpanElement>): void => {
    const room = track.current && island.current ? track.current.clientWidth - island.current.offsetWidth : 0;
    if (event.button !== 0 || room <= 0) {
      return;
    }
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { origin: event.clientX, share, room };
  };
  const carry = (event: PointerEvent<HTMLSpanElement>): void => {
    const start = drag.current;
    if (start) {
      setShare(Math.min(MAX_SHARE, Math.max(MIN_SHARE, start.share + (event.clientX - start.origin) / start.room)));
    }
  };
  const drop = (): void => {
    drag.current = undefined;
  };
  return (
    <div ref={track} className="annotate-track">
      <div
        ref={island}
        className={`annotate-island${closing ? " closing" : ""}${shown ? "" : " hidden"}`}
        style={{ "--share": share } as CSSProperties}
      >
        <div className="toolbar editor-bar-actions">
          <span
            className="status-icon annotate-grip"
            title="Move"
            onPointerDown={grab}
            onPointerMove={carry}
            onPointerUp={drop}
            onPointerCancel={drop}
          >
            <GripIcon />
          </span>
          <IconButton title={ACTION_LABELS.good} disabled={!selected} onClick={() => markSelection(viewKey, "good")}>
            <ThumbsUpIcon />
          </IconButton>
          <IconButton title={COMMENT_ACTION} disabled={!selected} onClick={() => void commentOnSelection(viewKey)}>
            <MessageIcon />
          </IconButton>
          <IconButton title={ACTION_LABELS.delete} disabled={!selected} onClick={() => markSelection(viewKey, "delete")}>
            <EraserIcon />
          </IconButton>
          <IconButton
            title={waiting ? "The agent is waiting for an answer" : "Send to Agent"}
            disabled={count === 0 || waiting}
            onClick={() => sendAnnotations(viewKey)}
          >
            <SendIcon />
          </IconButton>
          <IconButton title="Cancel" onClick={() => stopAnnotating(viewKey)}>
            <CloseIcon />
          </IconButton>
        </div>
      </div>
    </div>
  );
});
