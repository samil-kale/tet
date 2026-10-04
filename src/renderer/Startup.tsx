import { useCallback, useEffect, useState } from "react";
import type { Requirements } from "../shared/types/agents";
import type { LaneSettings } from "../shared/types/settings";
import { App } from "./App";
import { RequirementsDialog } from "./dialogs/RequirementsDialog";
import { useRunning } from "./ui/use-running";

/**
 * The app, once its requirements are met. Main opens the stored projects only after the check
 * passes, so a failing machine gets the dialog alone: nothing watched, spawned, or mounted. The
 * lanes are read first, so the app draws them as stored from its first frame.
 */
export function Startup() {
  const [requirements, setRequirements] = useState<Requirements | null>(null);
  const [lanes, setLanes] = useState<LaneSettings | null>(null);
  const { running: checking, run } = useRunning(true);

  const check = useCallback(
    () => run(async () => setRequirements(await window.tet.startup.check())),
    [run]
  );

  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => {
    void window.tet.settings.get().then((settings) => setLanes(settings.appearance.lanes));
  }, []);

  // The window's background while the version checks run.
  if (!requirements || !lanes) {
    return null;
  }
  return requirements.met ? (
    <App worktreesSupported={requirements.worktrees} lanes={lanes} />
  ) : (
    // In `.app` for its shared sizes (styles.css); the overlay is fixed, so the box adds no layout.
    <div className="app">
      <RequirementsDialog requirements={requirements} checking={checking} onRecheck={() => void check()} />
    </div>
  );
}
