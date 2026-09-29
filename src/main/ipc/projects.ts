import * as os from "node:os";
import * as path from "node:path";
import { dialog } from "electron";
import { handle } from "./channels";
import { errorMessage } from "../../shared/errors";
import type {
  AddAccountResult,
  AddRepositoryResult,
  GitActionResult,
  GitLogin,
  ListRepositoriesResult,
  Project,
  ProviderAccount,
  ProjectRef,
  ProviderId
} from "../../shared/types";
import { urlOrigin } from "../../shared/git-url";
import { git } from "../git/git-client";
import { logFailure } from "../util/json-file";
import { addProject, addWorktree, deleteWorktree, removeProject } from "../projects";
import { PROVIDERS } from "../providers";
import type { IpcDeps } from "./deps";

/** Opening, cloning and creating repositories, their worktrees, and the provider accounts a
 *  clone authenticates with. */
export function registerProjectsIpc({
  store,
  accounts,
  logins,
  projectDeps
}: Pick<IpcDeps, "store" | "accounts" | "logins" | "projectDeps">): void {
  handle("projects:list", (): Project[] => store.list());

  handle(
    "projects:pick-directory",
    async (_event, title: string, defaultPath?: string): Promise<string | null> => {
      // An empty defaultPath is a path too, opening wherever it resolves to.
      const result = await dialog.showOpenDialog({
        title,
        defaultPath: defaultPath === "" ? undefined : defaultPath,
        properties: ["openDirectory"]
      });
      return result.canceled ? null : (result.filePaths[0] ?? null);
    }
  );

  // Separate handler: ["openFile", "openDirectory"] together works only on macOS; Windows and Linux
  // silently show the directory selector. Hence two buttons in the sbx dialog.
  handle("projects:pick-file", async (_event, title: string): Promise<string | null> => {
    const result = await dialog.showOpenDialog({ title, properties: ["openFile"] });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  });

  handle(
    "projects:directory-to-remember",
    async (_event, directory: string): Promise<string> => {
      // A picked repository root remembers its parent, or the next picker opens inside it.
      const root = await git.resolveRoot(directory).catch(() => undefined);
      if (root !== undefined && path.relative(root, directory) === "") {
        const parent = path.dirname(directory);
        if (parent !== directory) {
          return parent;
        }
      }
      return directory;
    }
  );

  handle("projects:open", (_event, directory: string): Promise<AddRepositoryResult> =>
    addProject(projectDeps, directory)
  );

  /** Clone and create both end with the new folder added as a project, as `projects:open` does. */
  const addRepository = async (
    action: Promise<GitActionResult>,
    directory: string,
    label: string
  ): Promise<AddRepositoryResult> => {
    try {
      const result = await action;
      if (!result.ok) {
        // Kept apart from the message: the dialog asks for a login on it.
        return { error: result.error || `${label} failed`, loginUrl: result.loginUrl };
      }
    } catch (error) {
      // The git process died mid-command.
      return { error: errorMessage(error) };
    }
    return addProject(projectDeps, directory);
  };

  handle(
    "projects:clone",
    (_event, url: string, directory: string, name: string, accountId?: string, login?: GitLogin) => {
      const target = path.join(directory, name);
      // With an account, its token authenticates the clone, independent of any credential helper;
      // refused (revoked, expired), it asks for a login too, typed in the token's stead. Else as
      // any command reaching a remote — from the home folder, there being no repository yet to
      // read a credential helper from.
      const account = accountId !== undefined ? accounts.get(accountId) : undefined;
      const token = accountId !== undefined ? accounts.token(accountId) : undefined;
      const action =
        account && token !== undefined
          ? git
              .cloneWithToken(url, target, account.user, token, logins.askpassDir)
              .then((result) => (result.authRequired && urlOrigin(url) ? { ...result, loginUrl: url } : result))
          : logins.run(os.homedir(), url, login, (networkLogin) => git.clone(url, target, networkLogin));
      return addRepository(action, target, "Clone");
    }
  );

  handle("projects:create", (_event, directory: string, name: string) => {
    const target = path.join(directory, name);
    return addRepository(git.init(target), target, "Create");
  });

  handle("providers:accounts", (): ProviderAccount[] => accounts.list());

  handle(
    "providers:add-account",
    async (_event, provider: ProviderId, host: string, token: string): Promise<AddAccountResult> => {
      // A pasted "https://gitlab.company.com/" means its host.
      const bare = host
        .trim()
        .replace(/^[a-z]+:\/\//i, "")
        .replace(/\/.*$/, "");
      try {
        const user = await PROVIDERS[provider].validate(bare, token);
        return { account: accounts.add(provider, bare, user, token) };
      } catch (error) {
        return { error: errorMessage(error) };
      }
    }
  );

  // Why it could not be removed, for the dialog to tell; nothing once it went.
  handle("providers:remove-account", (_event, accountId: string): string | undefined => {
    try {
      accounts.remove(accountId);
      return undefined;
    } catch (error) {
      return errorMessage(error);
    }
  });

  // A convenience remembered for the next opening: not kept, the tab only opens unfiltered.
  handle("providers:set-namespace", (_event, accountId: string, namespace: string): void =>
    logFailure("remember the namespace", () => accounts.setNamespace(accountId, namespace))
  );

  handle("providers:repos", async (_event, accountId: string): Promise<ListRepositoriesResult> => {
    const account = accounts.get(accountId);
    const token = accounts.token(accountId);
    if (!account || token === undefined) {
      return { error: "The account's token could not be read — add the account again" };
    }
    try {
      return { repos: await PROVIDERS[account.provider].listRepositories(account.host, token) };
    } catch (error) {
      return { error: errorMessage(error) };
    }
  });

  // The sidebar's order, kept for the next start: not kept, only the order is lost.
  handle("projects:reorder", (_event, projectIds: string[]): void =>
    logFailure("keep the projects' order", () => store.reorder(projectIds))
  );

  handle("projects:remove", (_event, projectId: string): Promise<GitActionResult> => removeProject(projectDeps, projectId));

  // Each announces its outcome as `projects:changed`, as the control channel's verbs do.
  handle(
    "projects:add-worktree",
    (_event, projectId: string, branch: string): Promise<AddRepositoryResult> =>
      addWorktree(projectDeps, projectId, branch)
  );
  handle(
    "projects:delete-worktree",
    (_event, worktree: ProjectRef, options: { force: boolean; onRemote: boolean }): Promise<GitActionResult> =>
      deleteWorktree(projectDeps, worktree, options)
  );
}
