import { createRoot } from "react-dom/client";
import "./themes/dark-modern.css";
import "./themes/dark-slate.css";
import "./themes/light-modern.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Startup } from "./Startup";

/**
 * A file dropped anywhere but on a terminal would be handled by the browser, and in Electron
 * that means navigating the window to it — the app replaced by the file, with no way back. The
 * terminals prevent this themselves and act on the drop; here it is only swallowed. Files
 * alone: text dragged into a field is a drop the field itself still has to get.
 */
function swallowStrayDrop(event: DragEvent): void {
  if (event.dataTransfer?.types.includes("Files")) {
    event.preventDefault();
  }
}

document.addEventListener("dragover", swallowStrayDrop);
document.addEventListener("drop", swallowStrayDrop);

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container not found");
}

// Which of themes/'s value sets applies, set before anything is rendered: every
// reader of those variables (xterm, shiki, monaco) reads them once and keeps the result.
document.documentElement.dataset.theme = window.tet.initialTheme;

createRoot(container).render(<Startup />);
