import type { AgentSessionInfo, SessionProvider } from "../agent";
import { ensureServer } from "./server";

/**
 * Every operation here goes through the one `opencode serve` instance tet runs per
 * repository — see server.ts for why talking to opencode any other way is a dead end.
 */
export const opencodeSessionProvider: SessionProvider = {
  async list(executable: string, cwd: string): Promise<AgentSessionInfo[]> {
    try {
      const server = await ensureServer(executable, cwd);
      // `roots`: only conversations, not the child sessions a subagent (the task tool) ran in
      // — those share the directory and would each become a tab of their own; opencode's own
      // `session list` and picker ask the same. And a limit well above its default of 100,
      // which silently dropped the oldest sessions from the tabs. Both verified in the binary
      // (`Session.list`, the `GET /session` query schema).
      const entries = (await (await server.request("/session?roots=true&limit=10000", cwd)).json()) as {
        id?: unknown;
        title?: unknown;
        time?: { updated?: unknown; created?: unknown };
      }[];
      return entries
        .flatMap((entry) =>
          typeof entry.id === "string"
            ? [
                {
                  id: entry.id,
                  title: typeof entry.title === "string" ? entry.title : "",
                  updatedAt: typeof entry.time?.updated === "number" ? entry.time.updated : 0,
                  createdAt: typeof entry.time?.created === "number" ? entry.time.created : 0
                }
              ]
            : []
        )
        .sort((a, b) => a.createdAt - b.createdAt);
    } catch (error) {
      console.error("[tet] opencode session listing failed:", error);
      return [];
    }
  },

  resumeArgs(sessionId: string): string[] {
    return ["--session", sessionId];
  },

  async remove(executable: string, cwd: string, sessionId: string): Promise<void> {
    const server = await ensureServer(executable, cwd);
    await server.request(`/session/${encodeURIComponent(sessionId)}`, cwd, { method: "DELETE" });
  },

  /** opencode has no `session rename` command; `PATCH /session/{id}` sets the title. */
  async rename(executable: string, cwd: string, sessionId: string, title: string): Promise<void> {
    const trimmed = title.trim();
    if (!trimmed) {
      throw new Error("title must be non-empty");
    }
    const server = await ensureServer(executable, cwd);
    await server.request(`/session/${encodeURIComponent(sessionId)}`, cwd, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title: trimmed })
    });
  },

  watch(executable: string, cwd: string, onChange: () => void): () => void {
    let unsubscribe: (() => void) | undefined;
    let stopped = false;
    void ensureServer(executable, cwd)
      .then((server) => {
        if (!stopped) {
          unsubscribe = server.subscribe(cwd, (event) => {
            if (event.type.startsWith("session.")) {
              onChange();
            }
          });
        }
      })
      .catch((error) => console.error("[tet] opencode event stream unavailable:", error));
    return () => {
      stopped = true;
      unsubscribe?.();
    };
  }
};
