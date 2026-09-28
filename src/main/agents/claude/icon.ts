import type { AgentIcon } from "../../../shared/types";

/** Claude Code's own extension icon, drawn larger to grow the glyph in the shared box. */
export const claudeIcon: AgentIcon = {
  kind: "fill",
  extent: 22.15,
  cx: 12,
  cy: 12.14 - 1.85,
  grid: 24,
  larger: true,
  shapes: [
    {
      element: "path",
      attributes: {
        fill: "currentColor",
        fillRule: "evenodd",
        clipRule: "evenodd",
        d: "M 20.998,9.8869806 H 24 V 13.0718 h -3 v 4.563866 h -1.487001 v 3.506747 h -1.513 v -3.506747 h -1.486998 v 3.506747 H 15 V 17.635666 H 9.0000006 v 3.506747 H 7.488 V 17.635666 H 6 v 3.506747 H 4.487 V 17.635666 H 2.9999999 V 13.070599 H 0 V 9.8881806 H 2.9999999 V 3.1344694 H 20.998 Z m -14.998,0 H 7.488 V 6.4690722 H 6 Z m 10.51,0 h 1.489999 V 6.4690722 H 16.51 Z"
      }
    }
  ]
};
