import { urlOrigin } from "../../shared/git-url";
import { askpassEnv } from "../git/askpass";
import type { TabAccount } from "../providers/issues";
import { machineName, machineSets } from "../store/env-names";

/** The sets given whole or not at all: one of whose names `taken` holds already is left out, so no
 *  token goes beside another one's host. */
function wholeSets(sets: Record<string, string>[], taken: (name: string) => boolean): Record<string, string> {
  return Object.assign({}, ...sets.filter((set) => !Object.keys(set).some(taken))) as Record<string, string>;
}

/** Whether `stored` (TET's variables, environment.ts) has the name, as this machine compares names. */
function storedHas(stored: Record<string, string>): (name: string) => boolean {
  const names = new Set(Object.keys(stored).map(machineName));
  return (name) => names.has(machineName(name));
}

/**
 * What a host tab gets of its project's account (TerminalEnv.account), in two sets: the variables
 * the host's CLI reads (GitProvider.tokenEnv), and git's login for that host alone, as TET's own
 * git runs have it (git.ts's loginEnv): the user's credential helper answers first, Git Credential
 * Manager told not to open a window of its own there (it reads `credential.<url>.interactive`), then
 * askpass with the account's token, which git stores in the helper once it worked. A set one of whose
 * names the machine or TET's `stored` variables set already is left out (wholeSets).
 */
export function accountEnv(account: TabAccount, askpass: string, stored: Record<string, string>): Record<string, string> {
  const origin = urlOrigin(`https://${account.host}`);
  const inStored = storedHas(stored);
  return wholeSets(
    [
      account.provider.tokenEnv(account.host, account.token),
      {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `credential.${origin}.interactive`,
        GIT_CONFIG_VALUE_0: "false",
        ...askpassEnv(askpass, { origin, username: account.user, password: account.token }),
      },
    ],
    (name) => machineSets(name) || inStored(name),
  );
}

/** TET's variables a sandbox's Environment rows take (SbxLocalStore's `tetValues`): `stored` over the
 *  host CLI's variables of the account, by the same rule as a host tab's, the machine aside — a
 *  sandbox gets none of its variables. */
export function sandboxTetValues(account: TabAccount | undefined, stored: Record<string, string>): Record<string, string> {
  const fromAccount = account ? wholeSets([account.provider.tokenEnv(account.host, account.token)], storedHas(stored)) : {};
  return { ...fromAccount, ...stored };
}
