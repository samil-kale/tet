import type { AgentDefinition } from "../agents/agent";
import type { NoticeSeverity } from "../../shared/types/app";
import type { ResolvedRef } from "../store/resolved-ref";
import type { SettingsStore } from "../store/settings";
import { readSbxSettings } from "../store/tet-json";
import { currentTheme } from "../store/theme";
import { ensureRunning } from "../sbx/sbx-mounts";
import type { SbxLocalStore } from "../sbx/sbx-local";
import { checkSbxReady, sbxListed } from "../sbx/sbx-status";
import { CommandPlace, type HostPlace, type PlaceContext, type SandboxPlace, type StartingPlace } from "./tab-place";
import { isSavedCommandTab, type TabState } from "./tab-state";

/** Where one agent's tabs of a repository or worktree can run, as its runtime in the session
 *  manager holds it. */
export interface AgentPlaces {
  agent: AgentDefinition;
  executable: string;
  /**
   * No host executable — startable only through the repository's or worktree's sandbox, with
   * nothing to fall back to. Decided with the project's SBX settings; whether the sandbox is *reachable*
   * is resolvePlace's question, per spawn.
   */
  sbxOnly: boolean;
  /** Where its tabs run on this machine (HostPlace). */
  host: HostPlace;
  /** Its sandbox of this repository or worktree; only for an agent that runs in one. */
  sandbox?: SandboxPlace;
}

/** What resolvePlace asks of tet.json and sbx: a parameter, so the tests run it without sbx. */
export interface PlaceReads {
  readSbxSettings: typeof readSbxSettings;
  checkSbxReady: typeof checkSbxReady;
  sbxListed: typeof sbxListed;
  ensureRunning: typeof ensureRunning;
}

const SBX_READS: PlaceReads = { readSbxSettings, checkSbxReady, sbxListed, ensureRunning };

/** What a resolver runs on, handed in by the session manager. */
export interface PlaceTarget {
  /** What a place of this agent's tabs is built from. */
  placeContext(agent: AgentDefinition, executable: string): PlaceContext;
  onNotice(severity: NoticeSeverity, message: string): void;
}

/** Decides at each start where a tab of one repository or worktree runs, and says so where it
 *  cannot run. */
export class PlaceResolver {
  /** Said once per repository or worktree — see resolvePlace's host-session branch. */
  private sbxPreexistingSaid = false;

  constructor(
    private readonly at: ResolvedRef,
    private readonly settings: SettingsStore,
    private readonly sbxLocal: SbxLocalStore,
    private readonly target: PlaceTarget,
    private readonly reads: PlaceReads = SBX_READS,
  ) {}

  /**
   * Where this start runs the tab: the repository's or worktree's sandbox, or this machine; tet.json
   * is read fresh per spawn. Only plain tabs of an agent with a sandbox (AgentPlaces.sandbox); a
   * saved command runs on this machine as it is (CommandPlace).
   *
   * A session runs where it lives: a host session fails to resume in a sandbox. A tab with no
   * `sessionId` yet is sandboxed.
   *
   * Sbx not ready starts nothing and says so, leaving `error` for Restart: a project with SBX enabled
   * never runs an agent on this machine behind the user's back (past an organization's policy).
   * Nor is `enabled: false` written back: `sbx ls` fails the same way while the daemon restarts.
   * And never `sbx run` regardless: it prints its interactive sign-in and policy setup.
   *
   * "stranded" runs it nowhere, its notice already said.
   */
  async resolvePlace(tab: TabState, places: AgentPlaces): Promise<StartingPlace | "stranded"> {
    if (isSavedCommandTab(tab)) {
      return new CommandPlace(this.target.placeContext(places.agent, places.executable), {
        executable: places.executable,
        args: tab.runArgs ?? [],
        env: tab.env,
      });
    }
    const onHost = places.host;
    const { agent, sandbox } = places;
    if (!sandbox) {
      return onHost;
    }
    const sbxSettings = await this.reads.readSbxSettings(this.at.path);
    if (!sbxSettings.enabled) {
      // A notice only for a tab that cannot run on this machine.
      return this.sbxStranded(tab, places, "SBX is disabled for the project") ? "stranded" : onHost;
    }
    // Started before it is known whether it may be used, as the slowest step (why that is safe:
    // ensureRunning), but only once the check's `sbx ls` has answered (sbxListed), or the two would
    // each start sbx's daemon and one fail on its lock. Not for a tab about to run on this machine,
    // which would start a sandbox nobody asked for.
    const warm = tab.sessionId && !tab.sandbox ? undefined : this.reads.sbxListed().then(() => this.reads.ensureRunning(sandbox.name));
    const ready = await this.reads.checkSbxReady(this.at.path, this.at.ref);
    if ("notReady" in ready) {
      if (!this.sbxStranded(tab, places, ready.notReady)) {
        this.target.onNotice(
          "warning",
          `SBX is not available for ${this.at.name()}: ${ready.notReady}. The tab does not start on this machine instead; the tab menu's Restart tries again once that has changed.`,
        );
      }
      return "stranded";
    }
    if (tab.sessionId && !tab.sandbox) {
      if (tab.sandboxOnly) {
        this.sbxStranded(tab, places, "its session was found on this machine");
        return "stranded";
      }
      // A host session resumes only on the host, gone for an sbx-only agent. Not `sbxStranded`,
      // whose "Restart tries again" could never come true here.
      if (places.sbxOnly) {
        this.target.onNotice(
          "warning",
          `${agent.displayName} is not installed on this machine any more, and a session made here cannot be resumed in ${this.at.name()}'s SBX sandbox. A new tab runs in the sandbox; this one cannot.`,
        );
        return "stranded";
      }
      if (!this.sbxPreexistingSaid) {
        this.sbxPreexistingSaid = true;
        this.target.onNotice(
          "info",
          `${agent.displayName} tabs started while SBX was disabled for ${this.at.name()} keep running on this machine; only new tabs run in its sandbox.`,
        );
      }
      return onHost;
    }
    const { projectId } = this.at.ref;
    return sandbox.starting({
      settings: sbxSettings,
      ready,
      warm,
      idleReminder: this.settings.get().notifications.idleReminder,
      theme: currentTheme(this.settings),
      skills: this.sbxLocal.skills(projectId),
      environmentValues: await this.sbxLocal.environmentValues(projectId),
    });
  }

  /**
   * The notice for a tab that cannot run on this machine — its session lives in the sandbox, or
   * the agent is sbx-only (AgentPlaces.sbxOnly). Returns whether it applied, so the caller skips
   * its own. Per tab, not per project: it is about the tab just opened.
   */
  private sbxStranded(tab: TabState, { agent, sbxOnly }: AgentPlaces, reason: string): boolean {
    if (!tab.sandbox && !sbxOnly && !tab.sandboxOnly) {
      return false;
    }
    const what = tab.sandbox
      ? `This ${agent.displayName} session lives in ${this.at.name()}'s SBX sandbox and cannot run on this machine`
      : tab.sandboxOnly
        ? `This ${agent.displayName} tab was opened from ${this.at.name()}'s SBX sandbox and cannot run on this machine`
        : `${agent.displayName} is not installed on this machine and only runs in ${this.at.name()}'s SBX sandbox`;
    this.target.onNotice("warning", `${what}: ${reason}. The tab menu's Restart tries again once that has changed.`);
    return true;
  }
}
