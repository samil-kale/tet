import { useMemo, useState, type ReactNode, type UIEvent } from "react";
import type { CommitSearch, FileChange, GraphCommit, RepositoryState } from "../../../shared/types/git";
import type { OpenEditor } from "../../editor/editor-tab";
import { baseName, parentOf } from "../../paths";
import type { ResolvedRef } from "../../resolved-ref";
import { FilterField } from "../../ui/FilterField";
import { IconButton } from "../../ui/IconButton";
import { CommitIcon, MessageIcon, PathIcon, UserIcon, type IconProps } from "../../ui/icons";
import { COLUMN_STEP, INDENT_BASE, TreeRow } from "../../ui/tree-row";
import { STATUS_LETTER } from "./ChangesList";
import { graphRefColors, layoutGraph, nodeLane, type GraphColor, type GraphRow } from "./graph-layout";

/*
 * The lanes are drawn as VS Code's graph draws them (`renderSCMHistoryItemGraph`), in its geometry
 * at the height of every tree row that draws (`--tree-row-height` in styles.css): a lane is as wide
 * as half a row is high, so an arc from one lane to the next is a quarter circle.
 */
const ROW_HEIGHT = 24;
const LANE_WIDTH = ROW_HEIGHT / 2;
const CURVE_RADIUS = 5;
const CIRCLE_RADIUS = 4;
const CIRCLE_STROKE_WIDTH = 2;
/** Lane `index`'s line, one lane in from the left so a node never touches the edge. */
const laneX = (index: number): number => LANE_WIDTH * (index + 1);
const colorOf = (color: GraphColor): string => `var(--tet-scmGraph-${color})`;

/** What the search field's toggles pick between, one at a time. */
const SEARCH_FIELDS: { field: CommitSearch["field"]; title: string; Icon: (props: IconProps) => ReactNode }[] = [
  { field: "message", title: "Search Messages", Icon: MessageIcon },
  { field: "author", title: "Search Authors", Icon: UserIcon },
  { field: "path", title: "Search Paths", Icon: PathIcon },
];

interface CommitGraphProps {
  resolved: ResolvedRef;
  state: RepositoryState;
  commits: GraphCommit[];
  /** `commits` are a search's finds: listed flat, since the commits between them are missing. */
  searched: boolean;
  search: CommitSearch;
  onSearch: (search: CommitSearch) => void;
  hasMore: boolean;
  loading: boolean;
  onMore: () => void;
  /** A commit's file against its first parent opens as a diff (`OpenEditor.commit`). */
  onOpenDiff: (path: string, how?: OpenEditor) => void;
}

function Path({ d, color, width = 1 }: { d: string; color: GraphColor; width?: number }) {
  return <path d={d} fill="none" stroke={colorOf(color)} strokeWidth={width} strokeLinecap="round" />;
}

function Circle({ lane, radius, strokeWidth, color }: { lane: number; radius: number; strokeWidth: number; color?: GraphColor }) {
  return <circle cx={laneX(lane)} cy={ROW_HEIGHT / 2} r={radius} strokeWidth={strokeWidth} fill={color && colorOf(color)} />;
}

/** The width of a row's drawing: every lane it has either side, and one more of margin. */
const widthOf = ({ input, output }: GraphRow): number => LANE_WIDTH * (Math.max(input.length, output.length, 1) + 1);

/** A commit's row: the lanes passing, ending and starting at its node, then the node. `expanded`
 *  thickens the line running on to the files under it. */
function Lanes({ row, expanded }: { row: GraphRow; expanded: boolean }) {
  const { commit, input, output } = row;
  const circleLane = nodeLane(row);
  const circleColor: GraphColor =
    circleLane < output.length ? output[circleLane].color : circleLane < input.length ? input[circleLane].color : "historyItemRefColor";
  const half = ROW_HEIGHT / 2;
  const paths: ReactNode[] = [];

  let outputIndex = 0;
  input.forEach((lane, index) => {
    if (lane.id === commit.sha) {
      if (index !== circleLane) {
        // A lane ending here, bending in to the node.
        paths.push(
          <Path
            key={`in${index}`}
            color={lane.color}
            d={`M ${laneX(index)} 0 A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 1 ${LANE_WIDTH * index} ${half} H ${laneX(circleLane)}`}
          />,
        );
      } else {
        outputIndex++;
      }
    } else if (outputIndex < output.length && lane.id === output[outputIndex].id) {
      paths.push(
        index === outputIndex ? (
          <Path key={`through${index}`} color={lane.color} d={`M ${laneX(index)} 0 V ${ROW_HEIGHT}`} />
        ) : (
          // A lane right of an ended one moves over: down, round the corner, across, round again, down.
          <Path
            key={`through${index}`}
            color={lane.color}
            d={[
              `M ${laneX(index)} 0`,
              `V ${half - CURVE_RADIUS}`,
              `A ${CURVE_RADIUS} ${CURVE_RADIUS} 0 0 1 ${laneX(index) - CURVE_RADIUS} ${half}`,
              `H ${laneX(outputIndex) + CURVE_RADIUS}`,
              `A ${CURVE_RADIUS} ${CURVE_RADIUS} 0 0 0 ${laneX(outputIndex)} ${half + CURVE_RADIUS}`,
              `V ${ROW_HEIGHT}`,
            ].join(" ")}
          />
        ),
      );
      outputIndex++;
    }
  });

  // A merge's further parents: across from the node to the lane each opens.
  for (let at = 1; at < commit.parents.length; at++) {
    const lane = output.map((candidate) => candidate.id).lastIndexOf(commit.parents[at]);
    if (lane === -1) {
      continue;
    }
    paths.push(
      <Path
        key={`parent${at}`}
        color={output[lane].color}
        d={`M ${LANE_WIDTH * lane} ${half} A ${LANE_WIDTH} ${LANE_WIDTH} 0 0 1 ${LANE_WIDTH * (lane + 1)} ${ROW_HEIGHT} M ${LANE_WIDTH * lane} ${half} H ${laneX(circleLane)}`}
      />,
    );
  }

  // The node stands in a lane coming from above only where one was waiting for it (`nodeLane`).
  if (circleLane < input.length) {
    paths.push(<Path key="to" color={input[circleLane].color} d={`M ${laneX(circleLane)} 0 V ${half}`} />);
  }
  if (commit.parents.length > 0) {
    paths.push(<Path key="from" color={circleColor} width={expanded ? 3 : 1} d={`M ${laneX(circleLane)} ${half} V ${ROW_HEIGHT}`} />);
  }

  // The circles' strokes are the row's background (styles.css), which cuts a gap round each.
  let node: ReactNode;
  if (commit.head) {
    node = (
      <>
        <Circle lane={circleLane} radius={CIRCLE_RADIUS + 3} strokeWidth={CIRCLE_STROKE_WIDTH} color={circleColor} />
        <Circle lane={circleLane} radius={CIRCLE_STROKE_WIDTH} strokeWidth={CIRCLE_RADIUS} />
      </>
    );
  } else if (commit.parents.length > 1) {
    node = (
      <>
        <Circle lane={circleLane} radius={CIRCLE_RADIUS + 2} strokeWidth={CIRCLE_STROKE_WIDTH} color={circleColor} />
        <Circle lane={circleLane} radius={CIRCLE_RADIUS - 1} strokeWidth={CIRCLE_STROKE_WIDTH} color={circleColor} />
      </>
    );
  } else {
    node = <Circle lane={circleLane} radius={CIRCLE_RADIUS + 1} strokeWidth={CIRCLE_STROKE_WIDTH} color={circleColor} />;
  }

  return (
    <svg className={`graph-lanes${commit.head ? " head" : ""}`} width={widthOf(row)} height={ROW_HEIGHT} aria-hidden>
      {paths}
      {node}
    </svg>
  );
}

/** What a file row of the open commit draws in its place: the lanes running on, the commit's own
 *  thicker. */
function LanesBeside({ row }: { row: GraphRow }) {
  const circleLane = nodeLane(row);
  return (
    <svg className="graph-lanes" width={widthOf(row)} height={ROW_HEIGHT} aria-hidden>
      {row.output.map((lane, index) => (
        <Path
          key={index}
          color={lane.color}
          width={index === circleLane && row.commit.parents.length > 0 ? 3 : 1}
          d={`M ${laneX(index)} 0 V ${ROW_HEIGHT}`}
        />
      ))}
    </svg>
  );
}

/**
 * The GRAPH section's commits, newest first, laid out and drawn as VS Code's graph is, under the
 * field searching them. A commit opens to the files it changed, and a file to its diff against the
 * commit's first parent. The log is read by `useCommitGraph`, which the section's header and bar
 * belong to.
 */
export function CommitGraph({
  resolved,
  state,
  commits,
  searched,
  search,
  onSearch,
  hasMore,
  loading,
  onMore,
  onOpenDiff,
}: CommitGraphProps) {
  const rows = useMemo(() => (searched ? undefined : layoutGraph(commits, graphRefColors(state))), [searched, commits, state]);
  const [open, setOpen] = useState<string | undefined>();
  const [files, setFiles] = useState<Record<string, FileChange[]>>({});

  const toggle = (commit: GraphCommit): void => {
    setOpen(open === commit.sha ? undefined : commit.sha);
    if (open !== commit.sha && files[commit.sha] === undefined) {
      void window.tet.repository.commitFiles(resolved.ref, commit.sha, commit.parents[0]).then((list) => {
        setFiles((current) => ({ ...current, [commit.sha]: list }));
      });
    }
  };

  const openFile = (commit: GraphCommit, file: FileChange, keep: boolean): void => {
    onOpenDiff(file.path, { keep, commit: { sha: commit.sha, parent: commit.parents[0], origPath: file.origPath } });
  };

  const scrolled = (event: UIEvent<HTMLDivElement>): void => {
    const list = event.currentTarget;
    if (hasMore && !loading && list.scrollHeight - list.scrollTop - list.clientHeight < 200) {
      onMore();
    }
  };

  return (
    <div className="commit-graph">
      <FilterField placeholder="Search commits..." value={search.text} onChange={(text) => onSearch({ ...search, text })}>
        <span className="filter-toggles">
          {SEARCH_FIELDS.map(({ field, title, Icon }) => (
            <IconButton key={field} active={search.field === field} title={title} onClick={() => onSearch({ ...search, field })}>
              <Icon />
            </IconButton>
          ))}
        </span>
      </FilterField>
      <div className="graph-tree tree" onScroll={scrolled}>
        {commits.map((commit, index) => {
          const row = rows?.[index];
          return (
            <div key={commit.sha}>
              <TreeRow
                className={open === commit.sha ? "selected" : undefined}
                title={`${commit.sha.slice(0, 7)} ${commit.subject}\n${commit.author}, ${new Date(commit.date * 1000).toLocaleString()}`}
                onClick={() => toggle(commit)}
                icon={row ? <Lanes row={row} expanded={open === commit.sha} /> : <CommitIcon className="tree-icon" />}
                label={
                  <>
                    {commit.subject} <span className="tree-dir">{commit.author}</span>
                  </>
                }
              />
              {open === commit.sha &&
                (files[commit.sha] ?? []).map((file) => (
                  <TreeRow
                    key={file.path}
                    // A search's find has no lanes to run beside: its files start a column in, under its subject.
                    indent={row ? undefined : INDENT_BASE + COLUMN_STEP}
                    title={file.origPath ? `${file.origPath} → ${file.path}` : file.path}
                    onClick={() => openFile(commit, file, false)}
                    // As the Explorer: a single click previews, a double click keeps.
                    onDoubleClick={() => openFile(commit, file, true)}
                    icon={
                      <>
                        {row && <LanesBeside row={row} />}
                        <span className={`tree-icon change-status ${file.status}`}>{STATUS_LETTER[file.status]}</span>
                      </>
                    }
                    label={baseName(file.path)}
                  >
                    {parentOf(file.path) && <span className="tree-dir">{parentOf(file.path)}</span>}
                  </TreeRow>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
}
