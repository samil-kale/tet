import { errorMessage } from "../shared/errors";
import type { GitActionResult, Project, SbxLocalSave, SbxProjectConfig } from "../shared/types";
import { getAgent } from "./agents";
import { saveSbxConfig } from "./sbx";
import type { SbxLocalStore } from "./sbx-local";

/**
 * The SBX Settings' Save, for both transports: the dialog (ipc/sbx.ts) and `tet-ctl`'s `sbx-set-*`
 * verbs. Stores the typed values first, so a machine without a keyring changes nothing; then
 * applies them all or nothing (saveSbxConfig) — when sbx refused any, the values are put back too,
 * and the error says what it refused. Notices for the sandboxes it removed.
 */
export async function saveProjectSbx(
  { sbxLocal, send }: { sbxLocal: SbxLocalStore; send: (channel: string, payload: unknown) => void },
  project: Project,
  request: SbxProjectConfig,
  local: SbxLocalSave
): Promise<GitActionResult> {
  const stored = sbxLocal.encrypted(project.id);
  const previous = sbxLocal.knowledge(project.id);
  const previousSecrets = sbxLocal.values(project.id, "secrets");
  try {
    sbxLocal.update(project.id, local);
    const { removed, failures } = await saveSbxConfig(
      project.path,
      project.id,
      request,
      { previous, current: sbxLocal.knowledge(project.id) },
      { previous: previousSecrets, current: sbxLocal.values(project.id, "secrets") },
      new Set(Object.keys(local.secrets.values))
    );
    for (const agentId of removed) {
      const message = request.enabled
        ? `The ${getAgent(agentId).displayName} sandbox of ${project.name} was removed and is rebuilt when its next tab starts.`
        : `The ${getAgent(agentId).displayName} sandbox of ${project.name} was removed.`;
      send("app:notice", { severity: "info", message });
    }
    if (failures.length > 0) {
      sbxLocal.restore(project.id, stored);
      return { ok: false, error: `Not saved: ${failures.join(" ")}` };
    }
    return { ok: true };
  } catch (error) {
    sbxLocal.restore(project.id, stored);
    return { ok: false, error: errorMessage(error) };
  }
}
