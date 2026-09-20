import { FILE_EXTENSIONS, FILE_NAMES, type FileMark } from "./file-icons";
import { ChevronIcon, TREE_CHEVRON } from "../ui/icons";

/** As VS Code resolves an icon theme: the name, then each extension from the longest (`a.spec.ts`
 *  is `spec.ts`, then `ts`). Tables from scripts/file-icons.js. */
function fileMark(name: string): FileMark | null {
  const lower = name.toLowerCase();
  if (Object.hasOwn(FILE_NAMES, lower)) {
    return FILE_NAMES[lower];
  }
  for (let dot = lower.indexOf("."); dot >= 0; dot = lower.indexOf(".", dot + 1)) {
    const extension = lower.slice(dot + 1);
    if (Object.hasOwn(FILE_EXTENSIONS, extension)) {
      return FILE_EXTENSIONS[extension];
    }
  }
  return null;
}

/** A Seti font glyph, sized by `.file-mark` in styles.css (`Svg`'s extent-cropping reaches only a
 *  path); its color class maps to the theme's terminal colors. Seti gives every file an icon, so
 *  the slot is kept even where tet draws no mark. */
export function FileMarkIcon({ name }: { name: string }) {
  const [glyph, color] = fileMark(name) ?? ["", ""];
  return (
    <span className={`tree-icon file-mark${color ? ` ${color}` : ""}`} aria-hidden="true">
      {glyph}
    </span>
  );
}

/* VS Code's indent: TreeRenderer's DefaultIndent and `workbench.tree.indent` (both 8). The chevron
 * sits as in the branch tree's headers (`.tree-header` in styles.css: 9px in, 4px before the label),
 * not as VS Code's `.monaco-tl-twistie`. A file has no twistie — views.css zeroes it under
 * `align-icons-and-twisties`, which Seti (file icons, no folder icons) turns on — so its mark sits
 * where a sibling folder's chevron does, its label level with the folder's (.file-mark in styles.css). */
export const INDENT_STEP = 8;
export const INDENT_BASE = 9;
/** Holds a folder's chevron: the chevron's own 12px box. */
const TWISTIE_WIDTH = 12;
const TWISTIE_GAP = 4;
/** A match row starts a pixel past its file row's label (`INDENT_BASE` plus the twistie and its
 *  gap): the line it found gets the width the rest of the nesting would have eaten. */
export const MATCH_INDENT = 26;

/** A folder's or a result file's chevron, in the box the labels are measured against. */
export function Twistie({ open }: { open: boolean }) {
  return (
    <span
      style={{
        display: "flex",
        flex: "none",
        width: TWISTIE_WIDTH,
        alignSelf: "stretch",
        alignItems: "center",
        justifyContent: "center",
        marginRight: TWISTIE_GAP
      }}
    >
      <ChevronIcon expanded={open} className="tree-icon" scale={TREE_CHEVRON} />
    </span>
  );
}
