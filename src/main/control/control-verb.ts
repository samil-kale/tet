import type { ControlErrorCode, ControlRequest } from "../../shared/control";

/** What a verb's handler is made of, shared by control-server.ts and the verb files beside it. */

export class ControlError extends Error {
  constructor(
    readonly code: ControlErrorCode,
    message: string
  ) {
    super(message);
  }
}

/** `after` runs once the response reached the CLI: a verb ending the caller's process must reply
 *  first, or the CLI dies with an empty stdout. */
export interface Answer {
  result: unknown;
  after?: () => void;
}

/** The request's caller, and whether its tab runs in a sandbox (ControlVerb.sandbox). */
export type Caller = ControlRequest["caller"] & { sandboxed: boolean };

export type Handler = (
  args: Record<string, unknown>,
  caller: Caller,
  /** See ControlRequest.at. */
  at: number | undefined,
  /** Aborted once the CLI is gone (Ctrl+C) before its answer: nothing waits for it any more. */
  gone: AbortSignal
) => Promise<Answer> | Answer;

export function text(args: Record<string, unknown>, name: string, what: string): string {
  const value = args[name];
  if (typeof value !== "string" || value === "") {
    throw new ControlError("bad_args", `missing ${what}`);
  }
  return value;
}

/** A positive integer flag, or `fallback` when absent. */
export function count(args: Record<string, unknown>, name: string, fallback: number): number {
  if (args[name] === undefined) {
    return fallback;
  }
  const value = Number(args[name]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new ControlError("bad_args", `--${name} takes a positive whole number`);
  }
  return value;
}

/** A variadic positional's arguments; none is an empty list. */
export function list(args: Record<string, unknown>, name: string): string[] {
  const value = args[name];
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
}
