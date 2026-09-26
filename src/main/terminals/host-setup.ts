import * as fs from "node:fs";
import { errorMessage } from "../../shared/errors";
import type { AgentId, NoticeSeverity } from "../../shared/types";
import type { AgentDefinition, SpawnPreparation } from "../agents/agent";
import { agentConfigDir } from "../data-root";
import { markStartup } from "../event-loop-monitor";
import type { SettingsStore } from "../settings";
import { currentTheme } from "../theme";

interface HostSetup {
  agent: AgentDefinition;
  preparation?: SpawnPreparation;
  /** The theme and idle reminder `preparation` was written with — see themeChanged. */
  theme?: string;
  idleReminder?: boolean;
  /** Failed with no earlier setup to fall back to: the agent never starts on the host. */
  failed: boolean;
  /** One setup at a time: two tabs opened at once must not write it twice. */
  running?: Promise<boolean>;
  /** A rerun was asked for while `running` ran, which read the settings before they changed. */
  again?: boolean;
}

/**
 * Each agent's setup for host tabs (AgentDefinition.prepareSpawn): the same for every repository
 * and worktree (data-root.ts's agentConfigDir), so run once and shared by every TabSessionManager.
 */
export class HostSetups {
  private readonly setups = new Map<AgentId, HostSetup>();

  constructor(
    private readonly dataRoot: string,
    private readonly settings: SettingsStore,
    private readonly onNotice: (severity: NoticeSeverity, message: string) => void
  ) {}

  /** The agent's setup, run once unless `again`; false when it failed with none to fall back to.
   *  `again` during a run reruns it once that one is done. */
  prepare(agent: AgentDefinition, again = false): Promise<boolean> {
    const setup = this.setupOf(agent);
    if (setup.running) {
      setup.again ||= again;
      return setup.running;
    }
    setup.running = this.run(agent, setup, again).finally(() => {
      setup.running = undefined;
      if (setup.again) {
        setup.again = false;
        void this.prepare(agent, true);
      }
    });
    return setup.running;
  }

  /** What a host spawn of the agent is started with; undefined before its setup or without one. */
  preparation(agentId: AgentId): SpawnPreparation | undefined {
    return this.setups.get(agentId)?.preparation;
  }

  failed(agentId: AgentId): boolean {
    return this.setups.get(agentId)?.failed ?? false;
  }

  /** Redoes every setup written for another theme (AgentPaths.theme — Codex's win32 launcher
   *  carries the colors). */
  themeChanged(): void {
    const { id } = currentTheme(this.settings);
    this.redoStale((setup) => setup.theme !== id);
  }

  /** Redoes every setup written with the other idle reminder (AgentPaths.idleReminder — Claude
   *  Code's hooks carry it). */
  idleReminderChanged(): void {
    const { idleReminder } = this.settings.get().notifications;
    this.redoStale((setup) => setup.idleReminder !== idleReminder);
  }

  /** The old setup stands until replaced, so a tab spawned meanwhile gets one. */
  private redoStale(stale: (setup: HostSetup) => boolean): void {
    for (const setup of this.setups.values()) {
      // A setup underway counts too: it read the settings before the change.
      if ((setup.preparation || setup.running) && stale(setup)) {
        void this.prepare(setup.agent, true);
      }
    }
  }

  private setupOf(agent: AgentDefinition): HostSetup {
    let setup = this.setups.get(agent.id);
    if (!setup) {
      setup = { agent, failed: false };
      this.setups.set(agent.id, setup);
    }
    return setup;
  }

  private async run(agent: AgentDefinition, setup: HostSetup, again: boolean): Promise<boolean> {
    if (!agent.prepareSpawn || (setup.preparation && !again)) {
      return !setup.failed;
    }
    try {
      const agentDir = agentConfigDir(this.dataRoot, agent.id);
      fs.mkdirSync(agentDir, { recursive: true });
      const theme = currentTheme(this.settings);
      const { idleReminder } = this.settings.get().notifications;
      setup.preparation = await markStartup(`prepare ${agent.id}`, () =>
        agent.prepareSpawn!(agent.executable(), { agentDir, idleReminder, theme })
      );
      setup.theme = theme.id;
      setup.idleReminder = idleReminder;
      // Nothing else clears an earlier failure.
      setup.failed = false;
      return true;
    } catch (error) {
      console.error("[tet] spawn preparation failed:", error);
      this.onNotice("error", `${agent.displayName} could not be started: ${errorMessage(error)}`);
      // A rerun keeps the earlier setup, which still starts the agent (themeChanged).
      setup.failed = setup.preparation === undefined;
      return false;
    }
  }
}
