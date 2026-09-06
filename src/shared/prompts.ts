import type { PromptId, PromptSettings } from "./types";

/**
 * The two questions tet puts to an agent in the background, one text each. Here rather than
 * beside their callers in src/main/git because the settings dialog shows and edits them, and
 * the renderer may import nothing from src/main. What is *appended* to a question — the diff
 * under the commit prompt — is the caller's, so a user's own text keeps the same shape.
 */

/**
 * The question, with everything it needs already in it. Telling the agent to go and look was
 * the first version and cost several times as long — see `readCommitContext`.
 * Nothing here asks it to run a command, so it answers in one round trip.
 */
const COMMIT_MESSAGE_PROMPT = [
  "Below are a repository's recent commit subjects and every change `git add --all` would",
  "commit. Suggest the commit message for those changes.",
  "",
  "Follow the recent subjects' language, capitalization, prefixes, and usual length. Say what",
  "the change accomplishes, not what the diff does line by line. Do not mention an agent or add",
  "attribution.",
  "",
  "Answer with exactly one concise subject line: no quotes, Markdown, explanation, or body."
].join("\n");

/**
 * What an agent is asked when the wand is pressed. Deliberately concrete about where commands
 * hide — a model told only "find the commands" answers with what it would type in a generic
 * project of that kind rather than with what this one declares. It also has to stay
 * unambiguous about *judgement*: "prefer what's run by hand" and "list all of them" at once let
 * a model pick either. `"shell": true` is deliberately not mentioned — such an entry only works
 * where it was written, and what an agent writes into a repository should run everywhere.
 */
const COMMANDS_PROMPT = [
  "List the commands this project can actually run.",
  "Look at what is really in the repository: scripts in package.json, Maven or Gradle goals,",
  "cargo commands, make targets, composer or dotnet commands, task runners, CI workflows —",
  "whatever this project declares. Prefer the ones a developer runs by hand: build, test, lint,",
  "start, deploy.",
  "",
  "Include how the project is *started*, even where nobody wrote that command down. A class",
  "with a main method, a `func main`, a `__main__.py`, a binary target — each of those is a",
  "runnable program, and the project's own tooling already knows how to run it:",
  '  mvn compile exec:java -Dexec.mainClass=com.example.Application',
  "  cargo run --bin server",
  "  go run ./cmd/api",
  "  dotnet run --project src/App",
  "  python -m package",
  "Those are examples, not the list — whatever this project is written in, if it has something",
  "to start, name the command that starts it.",
  "Where the project depends on a framework with a runner of its own, that one wins:",
  "spring-boot:run rather than exec:java, quarkus:dev rather than a plain main.",
  "Launch configurations count as well (.vscode/launch.json, .idea/runConfigurations,",
  "nbactions.xml): give the shell command that does what they do, not the IDE's own wrapper.",
  "",
  "Leave out what nobody types: lifecycle hooks (prepare, postinstall), scripts that only exist",
  "for another script or for CI to call, and the internal steps of a build. If a project really",
  "does offer twenty commands worth running by hand, name all twenty — the number is not the",
  "point, being able to use each one is.",
  "",
  'Leave out anything that only works with a value nobody but its caller could know — a user',
  'id, a date range, an environment name — and has no sensible default. A placeholder like',
  '"<year>" or "{ticketId}" is not a command: nothing here can fill it in, and no one reads',
  "this list before running a row. If a command only makes sense with such a value supplied,",
  "skip it rather than name it with a placeholder in place of the value.",
  "",
  "Write every command the way it would be typed in the folder that declares it — plain",
  '"npm run build", not "npm run build --prefix web". Where that folder is not the repository',
  'root, say so with "cwd", relative to the root. A command that runs in the root is a plain',
  "string.",
  "",
  "Each command is started as a program with arguments, with no shell in between, so that the",
  "same entry works on Windows and on Unix. Nothing in it is interpreted: no pipes, no",
  '"&&" or "||", no ">" redirection, no "$(...)", no backticks, no "$VAR", and no',
  '"VAR=value cmd" prefix. Quotes group one argument and are the only way to put a space in',
  "one.",
  'Environment variables go in an "env" object instead, and tet sets them:',
  '  {"command": "java -jar target/app.jar", "env": {"PROFILE": "DEVELOPMENT"}}',
  "Two things that have to run one after the other are two entries, not one line.",
  "",
  "Answer with nothing but a JSON array. The command that starts the project comes first — it",
  "is the one reached for most. After it, keep the ones that use the same tool next to each",
  "other.",
  'Example: ["mvn spring-boot:run", "mvn test", {"command": "npm run build", "cwd": "web"}]'
].join("\n");

/** tet's own text per question — what an empty setting means. */
export const DEFAULT_PROMPTS: Readonly<Record<PromptId, string>> = {
  commitMessage: COMMIT_MESSAGE_PROMPT,
  commands: COMMANDS_PROMPT
};

/**
 * The text actually put to the agent: the user's own, or tet's where none is set. Read at the
 * moment of asking, so a change applies to the next press — the one setting that needs no
 * restart, since nothing keeps a copy.
 */
export function effectivePrompt(prompts: PromptSettings, id: PromptId): string {
  return prompts[id] || DEFAULT_PROMPTS[id];
}
