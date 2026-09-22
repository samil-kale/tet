/**
 * `npm start -- --simulate=git,claude`: commands reported missing regardless, to reach the
 * requirements dialog on a full machine. `sbx-mode` is every command but git and sbx — a machine
 * that runs its agents in sbx alone, where no agent's own knowledge exists either (sbx.ts's
 * sandboxKnowledgeFor).
 */
const SIMULATED = (process.argv.find((arg) => arg.startsWith("--simulate=")) ?? "")
  .slice("--simulate=".length)
  .split(",")
  .map((entry) => entry.trim())
  .filter((entry) => entry !== "");

export function isSimulatedMissing(command: string): boolean {
  return SIMULATED.includes(command) || (SIMULATED.includes("sbx-mode") && command !== "sbx" && command !== "git");
}
