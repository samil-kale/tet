import type { RemoteRepository } from "../../../shared/types/providers";
import { type GitProviderAccount, allNodes, type GraphqlPage } from "../provider";
import { sender } from "./api";

export const githubAccount: GitProviderAccount = {
  /** The names most tools take, gh among them: for github.com its token, for GitHub Enterprise the
   *  token and which host it is. */
  tokenEnv: (host, token): Record<string, string> =>
    host === "github.com" ? { GITHUB_TOKEN: token } : { GITHUB_ENTERPRISE_TOKEN: token, GH_HOST: host },

  async validate(host, token) {
    const data = (await sender(host, token)("{ viewer { login } }", {})) as { viewer: { login?: unknown } | null };
    const login = data.viewer?.login;
    if (typeof login !== "string" || login === "") {
      throw new Error("The API answered without a login");
    }
    return login;
  },

  async listRepositories(host, token) {
    // Both affiliations, or it leaves out the organizations' repositories.
    const query = `query($cursor: String) {
      viewer {
        repositories(
          first: 100
          after: $cursor
          orderBy: { field: PUSHED_AT, direction: DESC }
          affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
          ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]
        ) {
          pageInfo { hasNextPage endCursor }
          nodes { nameWithOwner name url }
        }
      }
    }`;
    type Repository = { nameWithOwner: string; name: string; url: string };
    const entries = await allNodes<Repository>(
      sender(host, token),
      query,
      {},
      (data) => (data as { viewer: { repositories: GraphqlPage<Repository> } }).viewer.repositories,
    );
    return entries.map((entry): RemoteRepository => ({
      fullName: entry.nameWithOwner,
      name: entry.name,
      cloneUrl: `${entry.url}.git`,
    }));
  },
};
