/** An agent's id, as its definition names it (src/main/agents/): the registry is the one list of
 *  them, handed to the window and `tet-ctl` (`agents:list`, `list-agents`). */
export type AgentId = string;

/** One shape of an icon: an SVG element and its attributes, under React's names. */
export interface IconShape {
  element: "path" | "circle" | "rect";
  attributes: Record<string, string | number>;
}

/**
 * An agent's icon as data, drawn by the window (agent-icons.tsx) and fitted into the shared box as
 * icons.tsx's hand drawings are: `fill` on its own grid (FillSvg), `stroke` on the 16 grid (Svg).
 */
export type AgentIcon =
  | { kind: "fill"; extent: number; cx: number; cy: number; grid: number; crisp?: boolean; shapes: IconShape[] }
  | { kind: "stroke"; extent: number; cx?: number; cy?: number; stroke?: number; shapes: IconShape[] };

export interface AgentInfo {
  id: AgentId;
  displayName: string;
  icon: AgentIcon;
  /** False for the shell, whose tabs are plain terminals. */
  hasSessions: boolean;
  /** Starts on a first prompt (AgentTerminal.initialPromptArgs), so it can take over another
   *  agent's session. */
  takesPrompt: boolean;
  /** What its tabs send for Shift+Enter (AgentTerminal.shiftEnter); unset: the terminal's own. */
  shiftEnter?: string;
  /** Its tabs offer Clear (AgentBase.clearable). */
  clearable: boolean;
  /** Can run in an sbx sandbox (the agent's `sandbox` group). */
  sandboxed: boolean;
}

/** A program tet needs, and whether the startup check found it. */
export interface Requirement {
  /** Its download name — "Git", "Claude". */
  name: string;
  /** The executable looked for, for the user to try in their own terminal. */
  command: string;
  installed: boolean;
}

/** `met` is git *and* either an agent or sbx, else the app does not open. sbx suffices: a sandboxed
 *  tab runs the agent's CLI in its container (requirements.ts). */
export interface Requirements {
  met: boolean;
  git: Requirement;
  /** One is enough. */
  agents: Requirement[];
  /** Enough without any agent installed here. */
  sbx: Requirement;
  /** git is new enough to create worktrees (worktreesSupported). */
  worktrees: boolean;
}

/** A value an agent suggested for a field, or why there is none — said under that field. */
export interface SuggestionResult {
  value?: string;
  error?: string;
}

/** A model an agent can be asked with: `id` is what its CLI takes, `label` what the user reads. */
export interface AskModel {
  id: string;
  label: string;
}

/** The models an agent lists (`AgentAsk.models`), or why it could not. */
export interface AskModelsResult {
  models: AskModel[];
  error?: string;
}

/** Who answers a suggestion: an agent that can ask, and one of its models — "" for the one its
 *  own configuration picks. */
export interface Suggester {
  agentId: AgentId;
  model: string;
}
