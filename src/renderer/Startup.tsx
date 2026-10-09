import { useCallback, useEffect, useState } from "react";
import { errorMessage } from "../shared/errors";
import type { Requirements } from "../shared/types/agents";
import type { LaneSettings } from "../shared/types/settings";
import { App } from "./App";
import { RequirementsDialog } from "./dialogs/RequirementsDialog";
import { useBusy } from "./ui/use-busy";

/**
 * The app, once its requirements are met. Main opens the stored projects only after the check
 * passes, so a failing machine gets the dialog alone: nothing watched, spawned, or mounted. The
 * lanes are read first, so the app draws them as stored from its first frame.
 */
export function Startup() {
  const [requirements, setRequirements] = useState<Requirements | null>(null);
  /** Why the last check failed (opening the stored projects threw): "Check again" runs it anew. */
  const [failure, setFailure] = useState<string | undefined>();
  const [lanes, setLanes] = useState<LaneSettings | null>(null);
  const { busy, run } = useBusy(true);

  const check = useCallback(
    () =>
      run(async () => {
        try {
          setRequirements(await window.tet.startup.check());
          setFailure(undefined);
        } catch (error) {
          setFailure(errorMessage(error));
        }
      }),
    [run],
  );

  useEffect(() => {
    void check();
  }, [check]);
  useEffect(() => {
    void window.tet.settings.get().then((settings) => setLanes(settings.appearance.lanes));
  }, []);

  if (lanes && failure !== undefined) {
    return (
      <div className="app">
        <RequirementsDialog failure={failure} busy={busy} onRecheck={() => void check()} />
      </div>
    );
  }
  // The window's background while the version checks run.
  if (!requirements || !lanes) {
    return null;
  }
  return requirements.met ? (
    <App worktreesSupported={requirements.worktrees} lanes={lanes} />
  ) : (
    // In `.app` for its shared sizes (styles.css); the overlay is fixed, so the box adds no layout.
    <div className="app">
      <RequirementsDialog requirements={requirements} busy={busy} onRecheck={() => void check()} />
    </div>
  );
}
