import { FILE_EXTENSIONS, FILE_NAMES, type FileMark } from "./file-icons";

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
