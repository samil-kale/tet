import type { ProjectCommand } from "./types";

/**
 * A saved command as the program and the arguments it is started with. Deliberately not a
 * shell: quotes group a word and are dropped, everything else is literal — a backslash
 * included, because a Windows path is full of them and `tet.json` is read on every
 * platform. So a space in an argument means quoting it, and a pipe, a redirection or a
 * variable cannot be smuggled in. A command that really needs one says `"shell": true`.
 *
 * Shared rather than owned by the main process: the dialog that saves a command reads its
 * environment field the same way, and two spellings of "what counts as one word" would drift.
 */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  // Told apart from `current === ""` so that an empty quoted argument survives as one.
  let started = false;
  let quote: string | undefined;

  for (const char of command) {
    if (quote !== undefined) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      started = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (started) {
        tokens.push(current);
        current = "";
        started = false;
      }
      continue;
    }
    current += char;
    started = true;
  }
  // A quote nobody closed takes the rest of the line with it, which is what the user typed.
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/**
 * Whether two saved commands are the same one: the same line, in the same folder, with the same
 * variables — while the same line run differently (another folder, another profile) is a
 * command of its own. Environments are compared sorted, so the same variables in a different
 * order match.
 */
export function isSameCommand(one: ProjectCommand, other: ProjectCommand): boolean {
  const envKey = (entry: ProjectCommand): string => JSON.stringify(Object.entries(entry.env ?? {}).sort());
  return one.command === other.command && one.cwd === other.cwd && envKey(one) === envKey(other);
}

/**
 * An environment written the way the dialog's field takes it — the inverse of `parseEnv`, and
 * here for the same reason: the row that shows one and the dialog that opens with one in it
 * have to spell it the way the parser reads it back. A value holding a space is quoted, since
 * that is what makes it one word again — and one holding a quote too, in the other kind,
 * since a bare quote is what the parser drops. (One holding both kinds cannot be written
 * for it at all; the double-quoted form then loses the double quotes, the least it can lose.)
 */
export function formatEnv(env: Record<string, string> | undefined): string {
  return Object.entries(env ?? {})
    .map(([name, value]) => {
      if (!/[\s"']/.test(value)) {
        return `${name}=${value}`;
      }
      const quote = value.includes('"') && !value.includes("'") ? "'" : '"';
      return `${name}=${quote}${value}${quote}`;
    })
    .join(" ");
}

/**
 * `NAME=value NAME2="a b"` as an environment, for the one field a dialog has room for. A word
 * without an `=` names nothing and is dropped; the first `=` separates, so a value may hold
 * more of them.
 */
export function parseEnv(text: string): Record<string, string> | undefined {
  const env: Record<string, string> = {};
  for (const token of splitCommand(text)) {
    const separator = token.indexOf("=");
    if (separator > 0) {
      env[token.slice(0, separator)] = token.slice(separator + 1);
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}
