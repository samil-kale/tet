import type { AgentIcon } from "../../../shared/types/agents";

/** The shell has no upstream icon: a plain prompt glyph. */
export const shellIcon: AgentIcon = {
  kind: "stroke",
  extent: 13.4,
  cy: 8 - 1.29,
  shapes: [
    { element: "rect", attributes: { x: 1.5, y: 2.5, width: 13, height: 11, rx: 1.5 } },
    { element: "path", attributes: { d: "M4.5 6.5L6.9 8l-2.4 1.5" } },
    { element: "path", attributes: { d: "M8.6 10.5h3" } },
  ],
};
