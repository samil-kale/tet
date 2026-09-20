import * as hooks from "node:async_hooks";
import * as util from "node:util";

/** TEMPORARY: which stream a write-completion fault came from. */
export function describeSource(): string {
  try {
    const resource = hooks.executionAsyncResource() as Record<string, unknown> | null;
    const handle = (resource?.handle ?? resource) as Record<string, unknown> | undefined;
    const owner = handle?._parent ?? handle;
    return [
      "[diag]",
      `resource=${String(resource?.constructor?.name)}`,
      `handle=${String(handle?.constructor?.name)}`,
      `fd=${String(handle?.fd)}`,
      `keys=${util.inspect(Object.keys(handle ?? {}))}`,
      `owner=${util.inspect(owner, { depth: 0 }).slice(0, 300)}`
    ].join(" ");
  } catch (error) {
    return `[diag] failed: ${String(error)}`;
  }
}
