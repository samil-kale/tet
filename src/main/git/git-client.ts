import { utilityClient } from "../util/utility-client";

/** `git.ts` as seen from the main process, in the git process (git-host.ts). */
const client = utilityClient<typeof import("./git")>("git");

export const git = client.api;

/** Starts the process up front, so the first repository doesn't wait for it to boot. */
export const startGitProcess = client.start;

export const stopGitProcess = client.stop;
