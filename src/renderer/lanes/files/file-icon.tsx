import { FILE_EXTENSIONS, FILE_NAMES, type FileIcon } from "./file-icons";

/** As VS Code resolves an icon theme: the name, then each extension from the longest (`a.spec.ts`
 *  is `spec.ts`, then `ts`). Tables from scripts/file-icons.js. */
function fileIcon(name: string): FileIcon | null {
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

/** A Seti font glyph, sized by `.file-icon` in styles.css (`Svg`'s extent-cropping reaches only a
 *  path); its color class maps to the theme's terminal colors. Seti gives every file an icon, so
 *  the slot is kept even where TET draws none. */
export function FileIconView({ name }: { name: string }) {
  const [glyph, color] = fileIcon(name) ?? ["", ""];
  return (
    <span className={`tree-icon file-icon${color ? ` ${color}` : ""}`} aria-hidden="true">
      {glyph}
    </span>
  );
}
