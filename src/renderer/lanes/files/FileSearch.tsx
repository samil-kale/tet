import { memo, useEffect, useImperativeHandle, useState } from "react";
import type { FileSearchMatch, FileSearchQuery, FileSearchResult } from "../../../shared/types/files";
import { baseName, parentOf } from "../../paths";
import { FileIconView } from "./file-icon";
import { INDENT_BASE, MATCH_INDENT, TreeRow, ChevronBox } from "../../ui/tree-row";
import { FilterField } from "../../ui/FilterField";
import type { CollapseExpandAll } from "../../ui/CollapseExpandAllButton";
import { IconButton } from "../../ui/IconButton";
import { CaseSensitiveIcon, type IconProps, RegexIcon, WholeWordIcon } from "../../ui/icons";

/** An empty search field: nothing typed, every toggle off. */
const EMPTY_SEARCH: FileSearchQuery = { text: "", matchCase: false, wholeWord: false, regex: false };

/** VS Code's three toggles inside the search box, in its order and under its titles. */
const SEARCH_TOGGLES: { key: "matchCase" | "wholeWord" | "regex"; title: string; Icon: (props: IconProps) => React.ReactNode }[] = [
  { key: "matchCase", title: "Match Case", Icon: CaseSensitiveIcon },
  { key: "wholeWord", title: "Match Whole Word", Icon: WholeWordIcon },
  { key: "regex", title: "Use Regular Expression", Icon: RegexIcon }
];

/** VS Code's line above its results, the section's header here, and what stands in for it when there
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
export interface FileSearchHandle extends CollapseExpandAll {
  clear(): void;
}

interface FileSearchProps {
  /** What the field last asked for, undefined while it is empty (`useFileSearch`). */
  result: FileSearchResult | undefined;
  /** The field asks for a search here, or for none; the section runs it and shows it running. */
  runSearch: (query: FileSearchQuery | null) => void;
  onOpenMatch: (path: string, match: FileSearchMatch) => void;
  /** What the header's collapse/expand button does next, reported as it changes: collapse while a
   *  file is expanded, else expand. */
  onExpanded: (expanded: boolean) => void;
  ref?: React.Ref<FileSearchHandle>;
}

/**
 * The SEARCH section: VS Code's search box, its own query, over what that query finds in the files'
 * lines. Listed as VS Code's search view does — a row per file, collapsed until it is expanded,
 * and under it a row per match with the match marked; the summary is the section's header. Rows of the
 * Explorer's shape, so its class carries the styles they share.
 */
export const FileSearch = memo(function FileSearch({ result, runSearch, onOpenMatch, onExpanded, ref }: FileSearchProps) {
  const [search, setSearch] = useState<FileSearchQuery>(EMPTY_SEARCH);
  // Nothing but whitespace asks for nothing.
  const asked = search.text.trim() ? search : null;
  useEffect(() => runSearch(asked), [asked, runSearch]);

  const [expandedFiles, setExpandedFiles] = useState<Record<string, boolean>>({});
  // Every search lists its files collapsed again; the previous one's expanded ones are gone.
  const [listed, setListed] = useState(result);
  if (listed !== result) {
    setListed(result);
    setExpandedFiles({});
  }
  const files = result?.files ?? [];
  const anyExpanded = files.some((file) => expandedFiles[file.path]);
  useEffect(() => onExpanded(anyExpanded), [anyExpanded, onExpanded]);

  useImperativeHandle(ref, () => ({
    // The text alone: the toggles are the field's own, as VS Code keeps them.
    clear: () => setSearch((current) => ({ ...current, text: "" })),
    expandAll: () => setExpandedFiles(Object.fromEntries(files.map((file) => [file.path, true]))),
    collapseAll: () => setExpandedFiles({})
  }));

  return (
    <div className="explorer-tree">
      <div className="filter-row">
        <FilterField placeholder="Search" value={search.text} onChange={(text) => setSearch({ ...search, text })}>
          <span className="filter-toggles">
            {SEARCH_TOGGLES.map(({ key, title, Icon }) => (
              <IconButton key={key} active={search[key]} title={title} onClick={() => setSearch({ ...search, [key]: !search[key] })}>
                <Icon />
              </IconButton>
            ))}
          </span>
        </FilterField>
      </div>
      <div className="tree">
        {files.map((file) => {
          const expanded = expandedFiles[file.path] ?? false;
          const name = baseName(file.path);
          const dir = parentOf(file.path);
          return (
            <div key={file.path}>
              <TreeRow
                indent={INDENT_BASE}
                title={file.path}
                onClick={() => setExpandedFiles((current) => ({ ...current, [file.path]: !expanded }))}
                icon={
                  <>
                    <ChevronBox expanded={expanded} />
                    <FileIconView name={name} />
                  </>
                }
                label={name}
              >
                {dir && <span className="tree-dir">{dir}</span>}
                <span className="count-badge search-count">{file.matches.length}</span>
              </TreeRow>
              {expanded &&
                file.matches.map((match) => (
                  <TreeRow
                    key={`${match.line}:${match.column}`}
                    className="search-match"
                    indent={MATCH_INDENT}
                    title={`${file.path}:${match.line}`}
                    onClick={() => onOpenMatch(file.path, match)}
                    label={
                      <>
                        {match.text.slice(0, match.textColumn)}
                        <span className="search-hit">{match.text.slice(match.textColumn, match.textColumn + match.length)}</span>
                        {match.text.slice(match.textColumn + match.length)}
                      </>
                    }
                  />
                ))}
            </div>
          );
        })}
      </div>
    </div>
  );
});
