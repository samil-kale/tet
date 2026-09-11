import { createRoot } from "react-dom/client";
import "./themes/dark-modern.css";
import "./themes/dark-slate.css";
import "./themes/light-modern.css";
import "@xterm/xterm/css/xterm.css";
import "./styles.css";
import { Startup } from "./Startup";
import { takeOutputStats } from "./terminal/terminal-views";

/**
 * A file dropped anywhere but on a terminal navigates the Electron window to it, replacing the
 * app with no way back. The terminals act on their own drops; here it is only swallowed. Files
 * alone: text dragged into a field is a drop the field itself still has to get.
 */
function swallowStrayDrop(event: DragEvent): void {
  if (event.dataTransfer?.types.includes("Files")) {
    event.preventDefault();
  }
}

document.addEventListener("dragover", swallowStrayDrop);
document.addEventListener("drop", swallowStrayDrop);

// This process's half of event-loop.log (src/main/event-loop-monitor.ts): stalls on this thread
// are invisible to the main process's sampler. Chromium reports every task past 50ms; the
// threshold for a line of its own is the monitor's. Each report carries what the terminals were
// doing just before it (takeOutputStats), whose window is the sweep below, since the stats are
// only ever taken here.
const OUTPUT_STATS_WINDOW_MS = 2000;

/** Chromium's own, non-standard: how full this thread's heap is, so a long task that is a major
 *  garbage collection shows as one on a heap near its size. */
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
  // An older Chromium without the entry type is no reason not to start.
}

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root container not found");
}

// Set before anything is rendered: xterm, shiki and monaco read those variables once and keep
// the result.
document.documentElement.dataset.theme = window.tet.initialTheme;

createRoot(container).render(<Startup />);
