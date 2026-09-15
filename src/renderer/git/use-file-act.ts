import { useState } from "react";
import type { FileAct } from "./ChangesList";
import { notify } from "../ui/Notices";

/**
 * Runs a file action, notifying on failure. The running mark is per project, since one side pane
 * serves all; called once per section, each with its own bar.
 */
export function useFileAct(projectId: string): { acting: boolean; act: FileAct } {
  const [actingIn, setActingIn] = useState<ReadonlySet<string>>(() => new Set());
  const act: FileAct = (action) => {
    setActingIn((current) => new Set(current).add(projectId));
    void action()
      .then((result) => {
        if (!result.ok) {
          notify("error", result.error ?? "Git command failed");
        }
      })
      .finally(() =>
        setActingIn((current) => {
          const next = new Set(current);
          next.delete(projectId);
          return next;
        })
      );
  };
  return { acting: actingIn.has(projectId), act };
}
