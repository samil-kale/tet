import { useCallback, useEffect, useRef, useState } from "react";
import type { Project } from "../../../shared/types/project";
import { forget } from "../../identity";

/** Which projects run their agent tabs sandboxed, and how a removed project's entry goes. */
interface SandboxedProjects {
  sandboxed: Record<string, boolean>;
  forgetSandboxed: (projectId: string) => void;
}

/**
 * Each tet.json's `sbx.enabled`, by project id — a worktree runs as its project does. Replaced
 * only where it changed (the memoized list re-renders otherwise). Any writer of that file
 * (dialog, agent, editor, repository or worktree) arrives as `commands:changed`.
 */
export function useSandboxedProjects(projects: Project[]): SandboxedProjects {
  const [sandboxed, setSandboxed] = useState<Record<string, boolean>>({});
  /** Projects whose flag was read on arrival — not `sandboxed`, which holds no entry for "off".
   *  Forgotten with the project, so one added again is read again. */
  const sandboxedRead = useRef(new Set<string>());

  /** Whether SBX is enabled for a project goes with the project, not with a repository or worktree of it. */
  const forgetSandboxed = useCallback((projectId: string) => {
    setSandboxed((current) => forget(current, projectId));
    sandboxedRead.current.delete(projectId);
  }, []);

  const applySandboxed = useCallback((projectId: string, enabled: boolean) => {
    setSandboxed((current) => ((current[projectId] ?? false) === enabled ? current : { ...current, [projectId]: enabled }));
  }, []);

  // Read once per project; after that every tet.json write is one `commands:changed`, shared with
  // the saved commands, carrying the switch.
  useEffect(() => {
    for (const project of projects) {
      if (!sandboxedRead.current.has(project.id)) {
        sandboxedRead.current.add(project.id);
        void window.tet.sbx.getSettings(project.id).then((config) => applySandboxed(project.id, config.enabled));
      }
    }
  }, [projects, applySandboxed]);
  useEffect(
    () => window.tet.commands.onChanged(({ projectId, sbxEnabled }) => applySandboxed(projectId, sbxEnabled)),
    [applySandboxed]
  );

  return { sandboxed, forgetSandboxed };
}
