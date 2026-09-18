import { useCallback, useEffect, useState } from "react";
import type { Requirements } from "../shared/types";
import { App } from "./App";
import { RequirementsDialog } from "./dialogs/RequirementsDialog";

/**
 * The app, once its requirements are met. Main opens the stored projects only after the check
 * passes, so a failing machine gets the dialog alone: nothing watched, spawned, or mounted.
 */
export function Startup() {
  const [requirements, setRequirements] = useState<Requirements | null>(null);
  const [checking, setChecking] = useState(true);

  const check = useCallback(async (): Promise<void> => {
    setChecking(true);
    setRequirements(await window.tet.startup.check());
    setChecking(false);
  }, []);

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
    <RequirementsDialog requirements={requirements} checking={checking} onRecheck={() => void check()} />
  );
}
