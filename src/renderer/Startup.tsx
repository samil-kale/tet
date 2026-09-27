import { useCallback, useEffect, useState } from "react";
import type { Requirements } from "../shared/types";
import { App } from "./App";
import { RequirementsDialog } from "./dialogs/RequirementsDialog";
import { useRunning } from "./ui/use-running";

/**
 * The app, once its requirements are met. Main opens the stored projects only after the check
 * passes, so a failing machine gets the dialog alone: nothing watched, spawned, or mounted.
 */
export function Startup() {
  const [requirements, setRequirements] = useState<Requirements | null>(null);
  const { running: checking, run } = useRunning(true);

  const check = useCallback(
    () => run(async () => setRequirements(await window.tet.startup.check())),
    [run]
  );

  useEffect(() => {
    void check();
  }, [check]);

  // The window's background while the version checks run.
  if (!requirements) {
    return null;
  }
  return requirements.met ? (
    <App worktreesSupported={requirements.worktrees} />
  ) : (
    // In `.app` for its shared sizes (styles.css); the overlay is fixed, so the box adds no layout.
    <div className="app">
      <RequirementsDialog requirements={requirements} checking={checking} onRecheck={() => void check()} />
    </div>
  );
}
