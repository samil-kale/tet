import { createRoot } from "react-dom/client";
import "./themes/dark-dracula.css";
import "./themes/dark-github.css";
import "./themes/dark-intellij.css";
import "./themes/dark-modern.css";
import "./themes/dark-slate.css";
import "./themes/light-gameboy.css";
import "./themes/light-github.css";
import "./themes/light-intellij.css";
import "./themes/light-modern.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Startup } from "./Startup";
import { rethemeTerminals } from "./terminal/terminal-views";
import { switchEditorTheme } from "./diff/editor";

/**
 * A file dropped outside a terminal would navigate the window to it, replacing the app. Files only:
 * text dragged into a field must still reach it.
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

// Before any render: xterm, shiki and monaco read the variables once, when built. Synchronous (the
// preload reads it off main.ts's additionalArguments), so the first frame is right.
document.documentElement.dataset.theme = window.tet.initialTheme;

// A runtime theme change (main.ts's applyTheme): the stylesheet first, since the others re-read it.
// Subscribed before any render: main repeats the theme after each page load, which a reloaded
// window's arguments may no longer match.
window.tet.onTheme((themeId) => {
  if (themeId === document.documentElement.dataset.theme) {
    return;
  }
  document.documentElement.dataset.theme = themeId;
  rethemeTerminals();
  void switchEditorTheme(themeId);
});

createRoot(container).render(<Startup />);
