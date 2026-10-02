import { utilityClient } from "../util/utility-client";

/** explorer-read.ts in the Explorer's process (explorer-host.ts), as seen from the main process;
 *  started by the first listing or search. */
const client = utilityClient<typeof import("./explorer-read")>("explorer");

export const explorerRead = client.api;

export const stopExplorerProcess = client.stop;
