import { shellIcon } from "./icon";
import { shellQuotePath } from "./quote-path";
import type { AgentDefinition } from "../agent";

export const shellAgent: AgentDefinition = {
  id: "shell",
  displayName: "Shell",
  icon: shellIcon,
  quotePath: shellQuotePath,
  executable: () => (process.platform === "win32" ? "powershell.exe" : (process.env.SHELL ?? "/bin/bash")),
  /** `-NoProfile` / plain `-c`: independent of the user's profile. */
  runArgs: (command) =>
    process.platform === "win32" ? ["-NoProfile", "-Command", command] : ["-c", command]
};
