import { serveRelay } from "./browser-relay";

/**
 * The browser relay's entry (browser-relay.ts), bundled on its own (esbuild.js) and run by a
 * sandbox's node over `sbx exec -i` (src/main/sbx/sbx-relay.ts).
 */
serveRelay(process.stdin, process.stdout, process.env);
// TET is gone, or let go of this sandbox: nothing is left to carry, nor anyone to tell.
process.stdin.on("end", () => process.exit(0));
process.stdout.on("error", () => process.exit(0));
