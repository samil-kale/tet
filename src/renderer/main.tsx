import { createRoot } from "react-dom/client";
import "./themes/dark-modern.css";
import "./themes/dark-slate.css";
import "./themes/light-modern.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Startup } from "./Startup";
import { takeOutputStats } from "./terminal/terminal-views";

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

// This process's half of event-loop.log (src/main/event-loop-monitor.ts): a keystroke on its
// way to xterm waits behind whatever holds this thread — a busy TUI's repaint being parsed, the
// git pane re-rendering — none of which the main process's sampler can see. Chromium reports
// every task past 50ms; the threshold for a line of its own is the monitor's. Each report
// carries what the terminals were doing just before it (takeOutputStats), so the line says
// whether several sessions were writing at the time — the window is the sweep below, since
// the stats are only ever taken here.
const OUTPUT_STATS_WINDOW_MS = 2000;
try {
  new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      const { writes, tabs, hidden } = takeOutputStats();
      window.tet.app.reportLongTask(entry.duration, `${tabs} tabs writing, ${hidden} hidden, ${writes} writes`);
    }
  }).observe({ entryTypes: ["longtask"] });
  setInterval(takeOutputStats, OUTPUT_STATS_WINDOW_MS);
} catch {
  // An older Chromium without the entry type is no reason not to start.
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container not found");
}

// Which of themes/'s value sets applies, set before anything is rendered: every
// reader of those variables (xterm, shiki, monaco) reads them once and keeps the result.
document.documentElement.dataset.theme = window.tet.initialTheme;

createRoot(container).render(<Startup />);
