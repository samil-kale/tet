import { urlOrigin } from "../../shared/git-url";
import { askpassEnv } from "../git/askpass";
import type { TabAccount } from "../providers/issues";
import { machineName, machineSets } from "../store/env-names";

/**
 * What a host tab gets of its project's account (TerminalEnv.account), in two sets: the variables
 * the host's CLI reads (GitProvider.tokenEnv), and git's login for that host alone, as TET's own
 * git runs have it (git.ts's loginEnv): the user's credential helper answers first, Git Credential
 * Manager told not to open a window of its own there (it reads `credential.<url>.interactive`), then
 * askpass with the account's token, which git stores in the helper once it worked. A set is given
 * whole or not at all: one of whose names the machine or TET's `stored` variables set already is
 * left out.
 */
export function accountEnv(account: TabAccount, askpass: string, stored: Record<string, string>): Record<string, string> {
  const origin = urlOrigin(`https://${account.host}`);
  const storedNames = new Set(Object.keys(stored).map(machineName));
  const taken = (name: string): boolean => machineSets(name) || storedNames.has(machineName(name));
  const sets = [
    account.provider.tokenEnv(account.host, account.token),
    {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `credential.${origin}.interactive`,
      GIT_CONFIG_VALUE_0: "false",
      ...askpassEnv(askpass, { origin, username: account.user, password: account.token }),
    },
  ];
  return Object.assign({}, ...sets.filter((set) => !Object.keys(set).some(taken))) as Record<string, string>;
}
