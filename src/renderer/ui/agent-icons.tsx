import type { AgentId } from "../../shared/types";
import { FillSvg, LARGER, Svg } from "./icons";

/**
 * Which icon belongs to which agent — the one agent-specific thing outside `src/main/agents/`: an
 * icon on `AgentDefinition` would pull JSX into the main bundle and agent setup into this one. A
 * new agent is a folder, an entry in `src/main/agents/index.ts`, and a case below.
 */
interface AgentIconProps {
  agentId: AgentId;
  className?: string;
}

/**
 * Claude Code's own extension icon (sbc-claude-code/media/icon.svg). Drawn `LARGER`: dividing the
 * measured extent tightens the crop, growing the glyph in the shared box.
 */
function ClaudeIcon({ className }: { className?: string }) {
  return (
    <FillSvg className={className} extent={22.15 / LARGER} cx={12} cy={12.14 - 1.85} grid={24}>
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M 20.998,9.8869806 H 24 V 13.0718 h -3 v 4.563866 h -1.487001 v 3.506747 h -1.513 v -3.506747 h -1.486998 v 3.506747 H 15 V 17.635666 H 9.0000006 v 3.506747 H 7.488 V 17.635666 H 6 v 3.506747 H 4.487 V 17.635666 H 2.9999999 V 13.070599 H 0 V 9.8881806 H 2.9999999 V 3.1344694 H 20.998 Z m -14.998,0 H 7.488 V 6.4690722 H 6 Z m 10.51,0 h 1.489999 V 6.4690722 H 16.51 Z"
      />
    </FillSvg>
  );
}

/** opencode's own extension icon (sbc-open-code/media/icon.svg). */
function OpencodeIcon({ className }: { className?: string }) {
  return (
    <FillSvg className={className} extent={256.27} cx={255.15} cy={255.72} grid={320}>
      <path d="M320 224V352H192V224H320Z" fill="currentColor" opacity="0.6" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M 365.35922,394.53486 H 144.94616 V 116.90026 H 365.35922 Z M 320,160 H 192 v 192 h 128 z"
        fill="currentColor"
      />
    </FillSvg>
  );
}

/**
 * Codex CLI's own icon (not OpenAI's mark): a prompt in a circle, as terminaltrove.com lists it,
 * redrawn in `ShellIcon`'s stroke style since no first-party SVG exists. Measured: the bbox is the
 * r=6 circle at (8, 8), so extent 13.6 (diameter plus the 1.6 stroke). Drawn `LARGER`: an outline
 * circle reads smaller than the filled marks beside it at the same extent.
 */
function CodexIcon({ className }: { className?: string }) {
  return (
    <Svg className={className} extent={13.6} scale={LARGER} stroke={1.6}>
      <circle cx="8" cy="8" r="6" />
      <path d="M5.8 5.7L8.3 8l-2.5 2.3" />
      <path d="M9 10.5h2.3" />
    </Svg>
  );
}

/**
 * pi's mark is a 4×4 grid; at TARGET_EXTENT (10.4px in the 13px box) a cell is 2.6px and blurs.
 * `crispEdges` snaps edges to pixels, and at exactly 10px that comes out even: cells of 2, 3, 2, 3,
 * the hole a square 2×2. 8px reads too small, 11px too heavy — verified by reading the rendered
 * pixels at 13px.
 */
const PI_PIXEL_CELLS = 10 / 10.4;

/**
 * pi's own mark (pi.dev/logo-auto.svg) on its native 800 grid, fill only. Measured: both axes run
 * 165.29–634.72, so the extent is 469.43 square about (400, 400).
 */
function PiIcon({ className }: { className?: string }) {
  return (
    <FillSvg
      className={className}
      extent={469.43 / PI_PIXEL_CELLS}
      cx={400}
      cy={400}
      grid={800}
      shapeRendering="crispEdges"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M165.29 165.29H517.36V400H400V517.36H282.65V634.72H165.29ZM282.65 282.65V400H400V282.65Z"
      />
      <path fill="currentColor" d="M517.36 400H634.72V634.72H517.36Z" />
    </FillSvg>
  );
}

/** The shell has no upstream icon: a plain prompt glyph. Measured: extent 13.4, centred 1.29
 *  above the grid's middle. */
function ShellIcon({ className }: { className?: string }) {
  return (
    <Svg className={className} extent={13.4} cy={8 - 1.29}>
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6.5L6.9 8l-2.4 1.5" />
      <path d="M8.6 10.5h3" />
    </Svg>
  );
}

export function AgentIcon({ agentId, className }: AgentIconProps) {
  switch (agentId) {
    case "claude":
      return <ClaudeIcon className={className} />;
    case "opencode":
      return <OpencodeIcon className={className} />;
    case "codex":
      return <CodexIcon className={className} />;
    case "pi":
      return <PiIcon className={className} />;
    case "shell":
      return <ShellIcon className={className} />;
  }
}
