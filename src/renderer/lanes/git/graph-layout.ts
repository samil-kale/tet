import { refName } from "../../../shared/types/git";
import type { GraphCommit, GraphRef, RepositoryState } from "../../../shared/types/git";

/** A lane's color: a name of the `--tet-scmGraph-*` variables, VS Code's `scmGraph.*` colors. */
export type GraphColor =
  | "foreground1"
  | "foreground2"
  | "foreground3"
  | "foreground4"
  | "foreground5"
  | "historyItemRefColor"
  | "historyItemRemoteRefColor"
  | "historyItemBaseRefColor";

/** The colors lanes take in turn when no ref colors them. */
const FOREGROUNDS: GraphColor[] = ["foreground1", "foreground2", "foreground3", "foreground4", "foreground5"];

/** A lane, left to right: the commit its line leads to next. */
export interface Swimlane {
  id: string;
  color: GraphColor;
}

/** A commit's row of the GRAPH: the lanes entering it from the row above, and leaving it below. */
export interface GraphRow {
  commit: GraphCommit;
  input: Swimlane[];
  output: Swimlane[];
}

const refKey = (ref: Pick<GraphRef, "kind" | "name">): string => `${ref.kind}:${ref.name}`;

/**
 * The colors of the refs VS Code colors — the current branch, its upstream and the default branch,
 * which stands for the branch it was made from — by `refKey`. Any other ref has none and lets its
 * lane keep the color it has.
 */
export function graphRefColors(state: RepositoryState): Map<string, GraphColor> {
  const colors = new Map<string, GraphColor>();
  if (state.defaultBranch) {
    colors.set(
      refKey({ kind: state.defaultBranch.remote === undefined ? "local" : "remote", name: refName(state.defaultBranch) }),
      "historyItemBaseRefColor",
    );
  }
  if (state.upstream) {
    colors.set(refKey({ kind: "remote", name: state.upstream }), "historyItemRemoteRefColor");
  }
  if (!state.detached) {
    colors.set(refKey({ kind: "local", name: state.head }), "historyItemRefColor");
  }
  return colors;
}

/**
 * Lanes for commits in topological order, a child before its parents (`readLog`), as VS Code's
 * graph lays them out: each row's `input` is the row above's `output`. A commit takes the first
 * lane waiting for it, which continues with its first parent; the other lanes waiting for it end
 * here, and every further parent opens a lane at the right. A lane ending shifts the ones right of
 * it left. A lane takes the color of the ref at the commit starting it (`graphRefColors`), else the
 * next of `FOREGROUNDS`.
 */
export function layoutGraph(commits: GraphCommit[], refColors: Map<string, GraphColor>): GraphRow[] {
  const bySha = new Map(commits.map((commit) => [commit.sha, commit]));
  const refColor = (commit: GraphCommit | undefined): GraphColor | undefined => {
    for (const ref of commit?.refs ?? []) {
      const color = refColors.get(refKey(ref));
      if (color !== undefined) {
        return color;
      }
    }
    return undefined;
  };
  let colorIndex = -1;
  const rows: GraphRow[] = [];
  for (const commit of commits) {
    const input = (rows.at(-1)?.output ?? []).map((lane) => ({ ...lane }));
    const output: Swimlane[] = [];
    let firstParentAdded = false;
    for (const lane of input) {
      if (lane.id !== commit.sha) {
        output.push({ ...lane });
      } else if (!firstParentAdded && commit.parents.length > 0) {
        output.push({ id: commit.parents[0], color: refColor(commit) ?? lane.color });
        firstParentAdded = true;
      }
    }
    for (let at = firstParentAdded ? 1 : 0; at < commit.parents.length; at++) {
      let color = refColor(at === 0 ? commit : bySha.get(commit.parents[at]));
      if (color === undefined) {
        colorIndex = (colorIndex + 1) % FOREGROUNDS.length;
        color = FOREGROUNDS[colorIndex];
      }
      output.push({ id: commit.parents[at], color });
    }
    rows.push({ commit, input, output });
  }
  return rows;
}

/** The lane a commit's node stands in: the first one waiting for it, else a new one at the right. */
export function nodeLane({ commit, input }: GraphRow): number {
  const waiting = input.findIndex((lane) => lane.id === commit.sha);
  return waiting === -1 ? input.length : waiting;
}
