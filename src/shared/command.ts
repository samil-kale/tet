import type { ProjectCommand } from "./types";

/**
 * A saved command as program plus arguments, started directly — the same on every machine.
 * Deliberately not a shell: quotes group a word and are dropped, everything else is literal —
 * backslashes too, since `tet.json` holds Windows paths and is read on every platform. No pipes,
 * redirections, `&&`, `$(...)` or `$VAR`; those need `"shell": true`, and an operator surviving as
 * its own word is refused with a notice (session-manager.ts). Shared, so the dialog's environment
 * field splits words the same way.
 */
export function splitCommand(command: string): string[] {
  const tokens: string[] = [];
  let current = "";
  // Not `current === ""`: an empty quoted argument must survive.
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
  // An unclosed quote takes the rest of the line.
  if (started) {
    tokens.push(current);
  }
  return tokens;
}

/** Same line, folder and variables; variable order does not matter. */
export function isSameCommand(one: ProjectCommand, other: ProjectCommand): boolean {
  const envKey = (entry: ProjectCommand): string => JSON.stringify(Object.entries(entry.env ?? {}).sort());
  return one.command === other.command && one.cwd === other.cwd && envKey(one) === envKey(other);
}

/**
 * The inverse of `parseEnv`. A value with whitespace or a quote is quoted with the other quote
 * kind; a value holding both kinds cannot round-trip.
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

/** Parses `NAME=value NAME2="a b"`. A word without `=` is dropped; the first `=` separates. */
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
