import { memo, useEffect, useImperativeHandle, useState } from "react";
import type { FileSearchMatch, FileSearchQuery, FileSearchResult } from "../../shared/types";
import { parentOf } from "./explorer-tree";
import { FileMarkIcon, INDENT_BASE, MATCH_INDENT, Twistie } from "./tree-rows";
import { FilterField } from "../ui/FilterField";
import { CaseSensitiveIcon, type IconProps, RegexIcon, WholeWordIcon } from "../ui/icons";

/** An empty search field: nothing typed, every toggle off. */
const EMPTY_SEARCH: FileSearchQuery = { text: "", matchCase: false, wholeWord: false, regex: false };

/** VS Code's three toggles inside the search box, in its order and under its titles. */
const SEARCH_TOGGLES: { key: "matchCase" | "wholeWord" | "regex"; title: string; Icon: (props: IconProps) => React.ReactNode }[] = [
  { key: "matchCase", title: "Match Case", Icon: CaseSensitiveIcon },
  { key: "wholeWord", title: "Match Whole Word", Icon: WholeWordIcon },
  { key: "regex", title: "Use Regular Expression", Icon: RegexIcon }
];

/** VS Code's line above its results, the pane's header here, and what stands in for it when there
 *  are none. */
export function searchSummary(result: FileSearchResult): string {
  const plural = (count: number, noun: string): string => `${count} ${noun}${count === 1 ? "" : "s"}`;
  const matches = result.files.reduce((count, file) => count + file.matches.length, 0);
  if (result.error) {
    return result.error;
  }
  if (matches === 0) {
    return "No results in files";
  }
  const found = `${plural(matches, "result")} in ${plural(result.files.length, "file")}`;
  return result.truncated ? `${found}, more left out` : found;
}

/** For the SEARCH header's title-bar buttons. */
export interface FileSearchHandle {
  clear(): void;
  toggleAll(): void;
}

interface FileSearchProps {
  /** What the field last asked for, undefined while it is empty (`useFileSearch`). */
  result: FileSearchResult | undefined;
  /** The field asks for a search here, or for none; the pane runs it and shows it running. */
  runSearch: (query: FileSearchQuery | null) => void;
  /** What the header's fold button stands for, reported as it changes. */
  onAllFolded: (allFolded: boolean) => void;
  onOpenMatch: (path: string, match: FileSearchMatch) => void;
  ref?: React.Ref<FileSearchHandle>;
}

/**
 * The SEARCH pane: VS Code's search box, its own query, over what that query finds in the files'
 * lines. Listed as VS Code's search view does — a row per file, folded away until it is opened,
 * and under it a row per match with the match marked; the summary is the pane's header. Rows of the
 * Explorer's shape, so its class carries the styles they share.
 */
export const FileSearch = memo(function FileSearch({ result, runSearch, onAllFolded, onOpenMatch, ref }: FileSearchProps) {
  const [search, setSearch] = useState<FileSearchQuery>(EMPTY_SEARCH);
  // Nothing but whitespace asks for nothing.
  const asked = search.text.trim() ? search : null;
  useEffect(() => runSearch(asked), [asked, runSearch]);

  const [opened, setOpened] = useState<Record<string, boolean>>({});
  // Every search lists its files folded away again; the previous one's opened ones are gone.
  const [listed, setListed] = useState(result);
  if (listed !== result) {
    setListed(result);
    setOpened({});
  }
  const files = result?.files ?? [];
  const allFolded = files.length > 0 && files.every((file) => !opened[file.path]);
  useEffect(() => onAllFolded(allFolded), [allFolded, onAllFolded]);

  useImperativeHandle(ref, () => ({
    // The text alone: the toggles are the field's own, as VS Code keeps them.
    clear: () => setSearch((current) => ({ ...current, text: "" })),
    // VS Code's one button for both: every file listed open, or all of them folded away again.
    toggleAll: () => setOpened(allFolded ? Object.fromEntries(files.map((file) => [file.path, true])) : {})
  }));

  return (
    <div className="explorer-tree">
      <div className="filter-row">
        <FilterField placeholder="Search" value={search.text} onChange={(text) => setSearch({ ...search, text })}>
          <span className="filter-toggles">
            {SEARCH_TOGGLES.map(({ key, title, Icon }) => (
              <button
                key={key}
                className={`icon-button${search[key] ? " active" : ""}`}
                title={title}
                onClick={() => setSearch({ ...search, [key]: !search[key] })}
              >
                <Icon />
              </button>
            ))}
          </span>
        </FilterField>
      </div>
      <div className="tree">
        {files.map((file) => {
          const open = opened[file.path] ?? false;
          const name = file.path.slice(file.path.lastIndexOf("/") + 1);
          const dir = parentOf(file.path);
          return (
            <div key={file.path}>
              <button
                className="tree-item"
                style={{ paddingLeft: INDENT_BASE }}
                title={file.path}
                onClick={() => setOpened((current) => ({ ...current, [file.path]: !open }))}
              >
                <Twistie open={open} />
                <FileMarkIcon name={name} />
                <span className="tree-label">{name}</span>
                {dir && <span className="search-dir">{dir}</span>}
                <span className="count-badge search-count">{file.matches.length}</span>
              </button>
              {open &&
                file.matches.map((match) => (
                  <button
                    key={`${match.line}:${match.column}`}
                    className="tree-item search-match"
                    style={{ paddingLeft: MATCH_INDENT }}
                    title={`${file.path}:${match.line}`}
                    onClick={() => onOpenMatch(file.path, match)}
                  >
                    <span className="tree-label">
                      {match.text.slice(0, match.textColumn)}
                      <span className="search-hit">{match.text.slice(match.textColumn, match.textColumn + match.length)}</span>
                      {match.text.slice(match.textColumn + match.length)}
                    </span>
                  </button>
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
});
