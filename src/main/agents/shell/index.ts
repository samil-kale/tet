import type { AgentDefinition } from "../agent";

export const shellAgent: AgentDefinition = {
  id: "shell",
  displayName: "Shell",
  executable: () => (process.platform === "win32" ? "powershell.exe" : (process.env.SHELL ?? "/bin/bash")),
  /**
   * How one command is run in a terminal that ends with it. Saved commands normally need no
   * shell — they are started as the program they name — so this is for the one that asked for
   * a shell because it needs a pipe or a redirection. `-NoProfile` and a plain `-c`, so it
   * still does not depend on what someone has in their profile.
   */
  runArgs: (command) =>
    process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command]
};
