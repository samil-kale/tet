import type { AgentDefinition } from "../agent";

export const shellAgent: AgentDefinition = {
  id: "shell",
  displayName: "Shell",
  executable: () => (process.platform === "win32" ? "powershell.exe" : (process.env.SHELL ?? "/bin/bash")),
  /** For a saved command with `"shell": true`. `-NoProfile` / plain `-c`: independent of the user's profile. */
  runArgs: (command) =>
    process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command]
};
