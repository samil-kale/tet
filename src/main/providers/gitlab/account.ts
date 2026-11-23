import type { RemoteRepository } from "../../../shared/types/providers";
import { type GitProviderAccount, allNodes, type GraphqlPage } from "../provider";
import { sender } from "./api";

export const gitlabAccount: GitProviderAccount = {
  /** glab's names, which scripts for GitLab take too; glab takes the host as a url. */
  tokenEnv: (host, token) => ({ GITLAB_TOKEN: token, GITLAB_HOST: `https://${host}` }),

  async validate(host, token) {
    const data = (await sender(host, token)("{ currentUser { username } }", {})) as { currentUser: { username?: unknown } | null };
    const username = data.currentUser?.username;
    if (typeof username !== "string" || username === "") {
      throw new Error("The API answered without a username");
    }
    return username;
  },

  async listRepositories(host, token) {
    // membership: without it a self-hosted instance answers with everything it can see.
    const query = `query($cursor: String) {
      projects(membership: true, first: 100, after: $cursor, sort: "latest_activity_desc") {
        pageInfo { hasNextPage endCursor }
        nodes { fullPath path httpUrlToRepo }
      }
    }`;
    const entries = await allNodes<{ fullPath: string; path: string; httpUrlToRepo: string }>(
      sender(host, token),
      query,
      {},
      (data) => (data as { projects: GraphqlPage<{ fullPath: string; path: string; httpUrlToRepo: string }> }).projects,
    );
    return entries.map((entry): RemoteRepository => ({
      fullName: entry.fullPath,
      name: entry.path,
      cloneUrl: entry.httpUrlToRepo,
    }));
  },
};
