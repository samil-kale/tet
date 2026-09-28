import { shellIcon } from "./icon";
import type { AgentDefinition } from "../agent";
import { PLATFORM } from "../../host-platform";

/** The platform's shell (Platform.shellExecutable), run as the user has it. */
export const shellAgent: AgentDefinition = {
  id: "shell",
  displayName: "Shell",
  icon: shellIcon,
  quotePath: (path) => PLATFORM.shellQuotePath(path),
  executable: () => PLATFORM.shellExecutable(process.env),
  runArgs: (command) => PLATFORM.shellCommandArgs(command)
};
