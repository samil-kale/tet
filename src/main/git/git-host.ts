import * as git from "./git";
import { serveModule } from "../util/utility-host";

/**
 * The git process: all of `git.ts` runs here, in its own `utilityProcess` (git-client.ts). Nothing
 * here or in `git.ts` may import electron, so git may block as long as it does.
 */
serveModule(git);
