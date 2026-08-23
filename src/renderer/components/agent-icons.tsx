import type { AgentId } from "../../shared/types";
import { LARGER, fitIcon, fitStroke } from "./icons";

/**
 * Which icon belongs to which agent. The one piece of agent-specific knowledge outside
 * `src/agents/`, and it is here because that folder is the main process's: an `AgentDefinition`
 * reaches node's fs and child_process, so an icon on it would pull JSX into that bundle and
 * the agent's own setup code into this one.
 *
 * Adding an agent therefore means a folder, an entry in `src/agents/index.ts`, and a case
 * below. A tab icon's size is `.tab-icon`'s to state, for these and for the git
 * toggle's own icon alike.
 */
interface AgentIconProps {
  agentId: AgentId;
  className?: string;
}

/**
 * Claude Code's own extension icon (sbc-claude-code/media/icon.svg). Drawn `LARGER` than the
 * rest: dividing the measured extent tightens the crop, so the glyph grows inside a box that
 * stays the shared one and nothing beside it moves.
 */
function ClaudeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="13"
      height="13"
      viewBox={fitIcon(22.15 / LARGER, 12, 12.14 - 1.85, 24)}
      aria-hidden="true"
    >
      <path
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M 20.998,9.8869806 H 24 V 13.0718 h -3 v 4.563866 h -1.487001 v 3.506747 h -1.513 v -3.506747 h -1.486998 v 3.506747 H 15 V 17.635666 H 9.0000006 v 3.506747 H 7.488 V 17.635666 H 6 v 3.506747 H 4.487 V 17.635666 H 2.9999999 V 13.070599 H 0 V 9.8881806 H 2.9999999 V 3.1344694 H 20.998 Z m -14.998,0 H 7.488 V 6.4690722 H 6 Z m 10.51,0 h 1.489999 V 6.4690722 H 16.51 Z"
      />
    </svg>
  );
}

/** opencode's own extension icon (sbc-open-code/media/icon.svg). */
function OpencodeIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="13"
      height="13"
      viewBox={fitIcon(256.27, 255.15, 255.72, 320)}
      fill="none"
      aria-hidden="true"
    >
      <path d="M320 224V352H192V224H320Z" fill="currentColor" opacity="0.6" />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M 365.35922,394.53486 H 144.94616 V 116.90026 H 365.35922 Z M 320,160 H 192 v 192 h 128 z"
        fill="currentColor"
      />
    </svg>
  );
}

/**
 * Codex CLI's own icon, not OpenAI's company mark: a terminal prompt inside a circle, the way
 * terminaltrove.com lists it. No first-party SVG exists for it — the npm package, the GitHub
 * repo and the VS Code extension carry only the plain OpenAI logo or no graphic at all — so this
 * redraws that listing's glyph in the same stroke style as `ShellIcon` rather than embedding a
 * rasterised copy. Measured, not estimated: a circle of r=6 centered at (8, 8) is the bbox this
 * is built from, so extent 13.6 (diameter plus the 1.6 stroke) and center (8, 8) both fall out of
 * that directly — the chevron and underscore sit well inside the circle and add nothing to it.
 * Drawn `LARGER`, like Claude's mark: a plain outline circle reads smaller than the filled marks
 * beside it at the same measured extent.
 */
function CodexIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="13"
      height="13"
      viewBox={fitIcon(13.6 / LARGER, 8, 8, 16)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(13.6 / LARGER, 16, 1.6)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <circle cx="8" cy="8" r="6" />
      <path d="M5.8 5.7L8.3 8l-2.5 2.3" />
      <path d="M9 10.5h2.3" />
    </svg>
  );
}

/** No upstream icon exists for the plain shell, so this is the familiar prompt glyph. */
function ShellIcon({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width="13"
      height="13"
      viewBox={fitIcon(13.4, 8, 8 - 1.29, 16)}
      fill="none"
      stroke="currentColor"
      strokeWidth={fitStroke(13.4, 16, 1.5)}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <rect x="1.5" y="2.5" width="13" height="11" rx="1.5" />
      <path d="M4.5 6.5L6.9 8l-2.4 1.5" />
      <path d="M8.6 10.5h3" />
    </svg>
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
    case "shell":
      return <ShellIcon className={className} />;
  }
}
