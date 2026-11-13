import * as fs from "node:fs";
import * as path from "node:path";
import { SbxLocalStore } from "../../src/main/sbx/sbx-local";
import { SettingsStore } from "../../src/main/store/settings";
import { HostSetups } from "../../src/main/terminals/host-setup";
import type { spawnAgentProcess, TerminalEnv } from "../../src/main/terminals/pty";
import { type SessionManagerCallbacks, TabSessionManager } from "../../src/main/terminals/session-manager";
import { tempDir, withEnvAsync } from ".";

/** A process that leaves when asked to quit or killed, or with `hang` only when the test says so. */
export class FakeProcess {
  exited = false;
  private readonly exitListeners: ((exit: { exitCode: number }) => void)[] = [];

  constructor(private readonly hang: boolean) {}

  onData(): { dispose(): void } {
    return { dispose: () => undefined };
  }

  onExit(listener: (exit: { exitCode: number }) => void): { dispose(): void } {
    this.exitListeners.push(listener);
    return { dispose: () => undefined };
  }

  resize(): void {
    return undefined;
  }

  write(data: string): void {
    if (data === "\x03") {
      this.leaveUnlessHanging();
    }
  }

  kill(): void {
    this.leaveUnlessHanging();
  }

  exit(): void {
    if (this.exited) {
      return;
    }
    this.exited = true;
    for (const listener of [...this.exitListeners]) {
      listener({ exitCode: 0 });
    }
  }

  private leaveUnlessHanging(): void {
    if (!this.hang) {
      setTimeout(() => this.exit(), 5);
    }
  }
}

/** No control channel, nothing kept. */
export const NO_TERMINAL_ENV: TerminalEnv = { control: () => undefined, stored: () => ({}), account: async () => ({}) };

export const NO_CALLBACKS: SessionManagerCallbacks = {
  onTabs: () => undefined,
  onArchived: () => undefined,
  onOutput: () => undefined,
  onStatus: () => undefined,
  onStartupProgress: () => undefined,
  onIssueSessions: () => undefined,
  onNotice: () => undefined,
};

/**
 * Runs `use` on project "p" in a folder of its own with PATH empty: no agent's version check
 * passes and sbx is missing, so nothing is set up, listed or spawned. Everything goes after.
 */
export async function withEmptyPath(
  callbacks: Partial<SessionManagerCallbacks>,
  use: (manager: TabSessionManager, project: string) => Promise<void> | void,
  spawnProcess?: typeof spawnAgentProcess,
): Promise<void> {
  const root = tempDir("tet-empty-path-");
  const project = path.join(root, "repo");
  fs.mkdirSync(project);
  const settings = new SettingsStore(root);
  await withEnvAsync({ PATH: path.join(root, "empty") }, async () => {
    const manager = new TabSessionManager(
      { ref: { projectId: "p" }, path: project, name: () => "repo" },
      root,
      settings,
      new SbxLocalStore(root, async () => ({})),
      new HostSetups(root, settings, () => undefined),
      NO_TERMINAL_ENV,
      {
        ...NO_CALLBACKS,
        ...callbacks,
      },
      spawnProcess,
    );
    try {
      await use(manager, project);
    } finally {
      await manager.dispose();
    }
  });
}
