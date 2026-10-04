import * as explorerRead from "./explorer-read";
import { serveModule } from "../util/utility-host";

/**
 * The Explorer's process: its walk and the SEARCH section's search (explorer-read.ts) read every file
 * or folder of a repository, in their own `utilityProcess` (explorer-client.ts) — not the git
 * process, so neither holds a git command back. Nothing here or in explorer-read.ts may import
 * electron.
 */
serveModule(explorerRead);
