import type { AgentIcon } from "../../../shared/types/agents";

/**
 * Codex's own icon (not OpenAI's mark): a prompt in a circle, redrawn in the shell icon's
 * stroke style since no first-party SVG exists. Drawn two pixels over the shared size: an outline circle reads smaller than
 * the filled marks beside it at the same extent.
 */
export const codexIcon: AgentIcon = {
  kind: "stroke",
  extent: 11.44,
  stroke: 1.6,
  shapes: [
    { element: "circle", attributes: { cx: 8, cy: 8, r: 6 } },
    { element: "path", attributes: { d: "M5.8 5.7L8.3 8l-2.5 2.3" } },
    { element: "path", attributes: { d: "M9 10.5h2.3" } }
  ]
};
