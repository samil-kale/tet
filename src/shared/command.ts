import type { ProjectCommand } from "./types/project";

/**
 * The words of the dialog's environment field. Deliberately not a shell: quotes group a word and
 * are dropped, everything else is literal — backslashes too, since `tet.json` holds Windows paths
 * and is read on every platform.
 */
export function splitWords(command: string): string[] {
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

/** Saved alike: every field the same, variable order aside — a name or a color makes another row. */
export function isSameCommand(one: ProjectCommand, other: ProjectCommand): boolean {
  const envKey = (entry: ProjectCommand): string => JSON.stringify(Object.entries(entry.env ?? {}).sort());
  return (
    one.command === other.command &&
    one.name === other.name &&
    one.color === other.color &&
    one.cwd === other.cwd &&
    envKey(one) === envKey(other) &&
    one.os === other.os
  );
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
  for (const token of splitWords(text)) {
    const separator = token.indexOf("=");
    if (separator > 0) {
      env[token.slice(0, separator)] = token.slice(separator + 1);
    }
  }
  return Object.keys(env).length > 0 ? env : undefined;
}
