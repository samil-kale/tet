import { errorMessage } from "../../shared/errors";
import { addProblems, keptValues, sbxProblemNotices, withoutProblems } from "../../shared/sbx-rules";
import { projectRef, projectRefName } from "../../shared/types/project";
import type { NoticeSeverity } from "../../shared/types/app";
import type { Project, ProjectRef } from "../../shared/types/project";
import type { SbxKnowledgeSettings, SbxLocalSave, SbxProblems, SbxProjectSettings, SbxSaveResult, SbxStatus } from "../../shared/types/sbx";
import { getAgent, SANDBOXED_AGENTS } from "../agents";
import { logFailure } from "../util/json-file";
import { inTurn } from "../util/async";
import { readSbxProblems } from "./sbx";
import { saveSbxSettings, type SbxSaveTarget } from "./sbx-save";
import { listSandboxes, readPolicy, type SandboxList, type SbxReading } from "./sbx-status";
import type { SbxLocalStore } from "./sbx-local";

/** What the caller read of sbx already: its status's organization, and with tet-ctl's reading the
 *  sandboxes and rules read on the way (sbx-status.ts's readSbxReading). Read now what it lacks. */
type Known = Omit<SbxReading, "status"> & { status: Pick<SbxStatus, "organization"> };

/** What a Save takes of it: the organization alone, as the sandboxes and rules it must read in its
 *  own turn — a Save queued behind another would work from what that one changed. */
type KnownOrganization = Pick<Known, "status">;

/** The env names holding a value, per list. */
interface ValueNames {
  secrets: Iterable<string>;
  variables: Iterable<string>;
}

/** A Save's check, for every agent's sandbox: all of it is applied now. */
function checkProject(
  project: Project,
  settings: SbxProjectSettings,
  knowledge: SbxKnowledgeSettings,
  values: ValueNames,
  organization: string | undefined,
  sandboxes?: SandboxList,
  rules?: Known["rules"],
): Promise<SbxProblems> {
  return readSbxProblems({
    projectId: project.id,
    settings,
    knowledge,
    values: { secrets: new Set(values.secrets), variables: new Set(values.variables) },
    agents: SANDBOXED_AGENTS,
    organization,
    ports: true,
    sandboxes,
    rules,
  });
}

/** The organization managing sbx's policy: as the caller's status read it, else read now. */
async function organizationOf(known: KnownOrganization | undefined): Promise<string | undefined> {
  return known ? known.status.organization : (await readPolicy())?.organization;
}

/**
 * What of a project's SBX Settings a Save would leave out (sbx.ts's readSbxProblems), for the
 * dialog's live marks and `tet-ctl sbx-get`. `values`: the env names holding a value, as the rows
 * have them — stored, or typed and not saved yet.
 */
export async function readProjectSbxProblems(
  project: Project,
  settings: SbxProjectSettings,
  knowledge: SbxKnowledgeSettings,
  values: ValueNames,
  known?: Known,
): Promise<SbxProblems> {
  return checkProject(project, settings, knowledge, values, await organizationOf(known), known?.sandboxes, known?.rules);
}

/** The Save underway per project (saveProjectSbx). */
const saves = new Map<string, Promise<unknown>>();

/**
 * The SBX Settings' Save, for both transports: the dialog (ipc/sbx.ts) and `tet-ctl`'s `sbx-set-*`
 * verbs. Stores the typed values first, so a machine without a keyring changes nothing. A row that
 * cannot be applied here (readSbxProblems) is neither saved nor applied, the rest is; what sbx then
 * refuses is left out too (saveSbxSettings), so tet.json holds what was applied, and only its rows
 * keep a value here. `problems` says what was left out; sbx's refusals are the error as well, as
 * nothing marked them before. Notices for the sandboxes it removed. The project's worktrees take its tet.json (tet-json.ts's configRoot), so their
 * sandboxes are saved along. One Save at a time per project, each after the last however that one
 * ended: two at once would apply their rows to the same sandboxes interleaved, and leave them
 * matching neither's tet.json.
 */
export function saveProjectSbx(
  deps: { sbxLocal: SbxLocalStore; notice: (severity: NoticeSeverity, message: string) => void },
  project: Project,
  request: SbxProjectSettings,
  local: SbxLocalSave,
  known?: KnownOrganization,
): Promise<SbxSaveResult> {
  return inTurn(saves, project.id, () => saveNow(deps, project, request, local, known));
}

async function saveNow(
  { sbxLocal, notice }: { sbxLocal: SbxLocalStore; notice: (severity: NoticeSeverity, message: string) => void },
  project: Project,
  request: SbxProjectSettings,
  local: SbxLocalSave,
  known?: KnownOrganization,
): Promise<SbxSaveResult> {
  const worktrees = project.worktrees.flatMap((worktree): SbxSaveTarget[] =>
    worktree.key === undefined ? [] : [{ ref: projectRef(project.id, worktree.key), path: worktree.path }],
  );
  const nameOf = (ref: ProjectRef): string => projectRefName(project, ref);
  const stored = sbxLocal.encrypted(project.id);
  const previous = sbxLocal.knowledge(project.id);
  try {
    sbxLocal.update(project.id, local);
    const secretValues = sbxLocal.values(project.id, "secrets");
    const knowledge = sbxLocal.knowledge(project.id);
    // Listed once for the check and the Save, in this turn.
    const [organization, sandboxes] = await Promise.all([organizationOf(known), listSandboxes()]);
    if (!sandboxes) {
      throw new Error("SBX could not list the sandboxes. Nothing was saved; try again.");
    }
    // Off, nothing is applied, so nothing is left out. What sbx cannot say stops the Save: a row
    // it could not be asked about is no refusal.
    const problems = request.enabled
      ? await checkProject(project, request, knowledge, sbxLocal.stored(project.id), organization, sandboxes).catch((error: unknown) => {
          throw new Error(`${errorMessage(error)} Nothing was saved; try again.`);
        })
      : {};
    const wanted = withoutProblems(request, knowledge, problems);
    const {
      removed,
      orphans,
      refused,
      failures,
      settings,
      knowledge: applied,
    } = await saveSbxSettings(
      { ref: { projectId: project.id }, path: project.path },
      worktrees,
      wanted.settings,
      { previous, current: wanted.knowledge },
      secretValues,
      new Set(Object.keys(local.secrets.values)),
      organization,
      sandboxes,
    );
    sbxLocal.update(project.id, { secrets: keptValues(settings.secrets), variables: keptValues(settings.variables), knowledge: applied });
    for (const { ref, agentId } of removed) {
      const message = request.enabled
        ? `The ${getAgent(agentId).displayName} sandbox of ${nameOf(ref)} was removed and is rebuilt when its next tab starts.`
        : `The ${getAgent(agentId).displayName} sandbox of ${nameOf(ref)} was removed.`;
      notice("info", message);
    }
    for (const { ref, agentId } of orphans) {
      notice("info", `An earlier ${getAgent(agentId).displayName} sandbox of ${nameOf(ref)} was removed.`);
    }
    const left: SbxProblems = { ...problems };
    for (const [option, rows] of Object.entries(refused) as [keyof SbxProblems, Record<string, string>][]) {
      addProblems(left, option, rows);
    }
    const unexpected = [...sbxProblemNotices(refused), ...failures];
    return unexpected.length > 0 ? { ok: false, error: unexpected.join("\n\n"), problems: left } : { ok: true, problems: left };
  } catch (error) {
    // What was stored before; failing that too, the first failure is still the one to tell.
    logFailure("restore the SBX settings", () => sbxLocal.restore(project.id, stored));
    return { ok: false, error: errorMessage(error) };
  }
}
