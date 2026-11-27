import { memo } from "react";
import { createPortal } from "react-dom";
import { IconButton } from "../ui/IconButton";
import { CloseIcon } from "../ui/icons";
import { removeAnnotation, setHover, type AnnotationPill } from "./annotate-views";

interface AnnotationPillsProps {
  viewKey: string;
  pills: readonly AnnotationPill[];
  /** Where they are drawn: over the terminal's screen (`annotate-views.ts`). */
  layer: HTMLElement;
}

/** The annotations' pills, each right after its text, with its number and what removes it; the one
 *  under the pointer is the hover the popup shows (`AnnotateOverlay`). The same pills stay the same
 *  list (`setPills`), so a hover or the menu does not draw them again. */
export const AnnotationPills = memo(function AnnotationPills({ viewKey, pills, layer }: AnnotationPillsProps) {
  return createPortal(
    pills.map((pill) => (
      <div
        key={pill.id}
        className={`annotation-pill annotation-kind-${pill.kind}`}
        style={{ left: pill.left, top: pill.top }}
        onMouseEnter={(event) => setHover(viewKey, { id: pill.id, x: event.clientX, y: event.clientY })}
        onMouseLeave={() => setHover(viewKey, undefined)}
      >
        <span className="annotation-number">{pill.number}</span>
        <IconButton title="Remove Annotation" onClick={() => removeAnnotation(viewKey, pill.id)}>
          <CloseIcon />
        </IconButton>
      </div>
    )),
    layer,
  );
});
