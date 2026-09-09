import { useCallback, useEffect, useState } from "react";
import type { Requirements } from "../shared/types";
import { App } from "./App";
import { RequirementsDialog } from "./dialogs/RequirementsDialog";

/**
 * The app, once the programs it runs on are there. The main process opens the stored projects
 * only when the check passed, so a machine missing git or every agent gets the dialog and
 * nothing else: nothing watched, nothing spawned, `App` never mounted.
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

  // The window's own background for the moment the version checks take.
  if (!requirements) {
    return null;
  }
  return requirements.met ? (
    <App />
  ) : (
    <RequirementsDialog requirements={requirements} checking={checking} onRecheck={() => void check()} />
  );
}
