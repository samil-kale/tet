import * as crypto from "node:crypto";
import { canBind } from "../util/can-bind";

const DYNAMIC_PORT_START = 49152;
const DYNAMIC_PORT_RANGE = 65535 - DYNAMIC_PORT_START;

/** The preferred port for this data folder, before checking it is free. */
function hashPort(dataRoot: string): number {
  const hash = crypto.createHash("sha1").update(dataRoot).digest("hex");
  return DYNAMIC_PORT_START + (parseInt(hash.slice(0, 8), 16) % DYNAMIC_PORT_RANGE);
}

/**
 * Derived from the data folder (data-root.ts), so two accounts, or a test profile beside the tet it
 * runs in, get ports of their own. Probed by binding: Windows excludes pieces of the dynamic range,
 * failing with `EACCES`, and keeps them long enough to reuse the probed port. Not OS-assigned: the
 * port must be in every terminal's environment (setControlEnv) before the server starts.
 */
export async function findControlPort(dataRoot: string): Promise<number> {
  const start = hashPort(dataRoot);
  for (let offset = 0; offset < DYNAMIC_PORT_RANGE; offset += 1) {
    const port = DYNAMIC_PORT_START + ((start - DYNAMIC_PORT_START + offset) % DYNAMIC_PORT_RANGE);
    if (await canBind(port)) {
      return port;
    }
  }
  throw new Error("no free loopback port in the dynamic range");
}

