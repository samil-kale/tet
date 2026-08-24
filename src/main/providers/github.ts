import type { RemoteRepository } from "../../shared/types";
import { getJson, getPaged, type GitProvider } from "./provider";

/** github.com's API lives on its own subdomain; GitHub Enterprise serves it under /api/v3. */
function apiBase(host: string): string {
  return host === "github.com" ? "https://api.github.com" : `https://${host}/api/v3`;
}

/** GitHub rejects requests without a User-Agent, and Node's fetch does not send one. */
function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "tet"
  };
}

interface GitHubRepository {
  full_name: string;
  name: string;
  private: boolean;
  clone_url: string;
}

export const github: GitProvider = {
  async validate(host, token) {
    const user = (await getJson(`${apiBase(host)}/user`, headers(token))) as { login?: unknown };
    if (typeof user.login !== "string" || user.login === "") {
      throw new Error("The API answered without a login");
    }
    return user.login;
  },

  async listRepositories(host, token) {
    // The default affiliation already covers owned repositories, collaborations and the
    // user's organizations — the same set the web's "Your repositories" shows.
    const url = `${apiBase(host)}/user/repos?per_page=100&sort=pushed`;
    const entries = (await getPaged(url, headers(token))) as GitHubRepository[];
    return entries.map(
      (entry): RemoteRepository => ({
        fullName: entry.full_name,
        name: entry.name,
        private: entry.private,
        cloneUrl: entry.clone_url
      })
    );
  }
};
