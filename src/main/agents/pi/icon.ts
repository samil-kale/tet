import type { AgentIcon } from "../../../shared/types/agents";

/**
 * pi's mark is a 4×4 grid, which blurs at the shared box's extent. Crisp edges snap it to pixels,
 * and at 10px of the box the cells come out even.
 */
const PIXEL_CELLS = 10 / 10.4;

/** pi's own mark on its native 800 grid, fill only. */
export const piIcon: AgentIcon = {
  kind: "fill",
  extent: 469.43 / PIXEL_CELLS,
  cx: 400,
  cy: 400,
  grid: 800,
  crisp: true,
  shapes: [
    {
      element: "path",
      attributes: {
        fill: "currentColor",
        fillRule: "evenodd",
        clipRule: "evenodd",
        d: "M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z",
      },
    },
    { element: "path", attributes: { fill: "currentColor", d: "M517.36 400H634.72V634.72H517.36Z" } },
  ],
};
