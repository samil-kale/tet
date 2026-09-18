import { createRoot } from "react-dom/client";
import "./themes/dark-dracula.css";
import "./themes/dark-github.css";
import "./themes/dark-intellij.css";
import "./themes/dark-modern.css";
import "./themes/dark-slate.css";
import "./themes/light-github.css";
import "./themes/light-intellij.css";
import "./themes/light-modern.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Startup } from "./Startup";
import { rethemeTerminals, takeOutputStats } from "./terminal/terminal-views";
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

// The renderer's half of event-loop.log (src/main/event-loop-monitor.ts), whose sampler cannot see
// this thread. Chromium reports tasks past 50ms. Each report carries the terminals' recent output
// (takeOutputStats), over the window this sweep sets.
const OUTPUT_STATS_WINDOW_MS = 2000;

/** Chromium's non-standard heap usage, so a long task that is a major GC shows as one. */
function rendererHeap(): string {
  const { memory } = performance as Performance & { memory?: { usedJSHeapSize: number; totalJSHeapSize: number } };
  return memory ? `${Math.round(memory.usedJSHeapSize / 1_048_576)}/${Math.round(memory.totalJSHeapSize / 1_048_576)}MB` : "?";
}

try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const { writes, tabs, hidden, largest } = takeOutputStats();
      window.tet.app.reportLongTask(
        entry.duration,
        `${tabs} tabs writing, ${hidden} hidden, ${writes} writes, largest ${largest} chars, heap ${rendererHeap()}`
      );
    }
  }).observe({ entryTypes: ["longtask"] });
  setInterval(takeOutputStats, OUTPUT_STATS_WINDOW_MS);
} catch {
  // A Chromium without the entry type still starts.
}

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
