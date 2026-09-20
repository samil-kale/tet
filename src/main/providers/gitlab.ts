import type { RemoteRepository } from "../../shared/types";
import { getJson, getPaged, type GitProvider } from "./provider";

function apiBase(host: string): string {
  return `https://${host}/api/v4`;
}

function headers(token: string): Record<string, string> {
  return { "PRIVATE-TOKEN": token };
}

interface GitLabProject {
  path_with_namespace: string;
  path: string;
  http_url_to_repo: string;
}

export const gitlab: GitProvider = {
  async validate(host, token) {
    const user = (await getJson(`${apiBase(host)}/user`, headers(token))) as { username?: unknown };
    if (typeof user.username !== "string" || user.username === "") {
      throw new Error("The API answered without a username");
    }
    return user.username;
  },

  async listRepositories(host, token) {
    // membership=true: without it a self-hosted instance answers with everything it can see.
    // simple=true: the full record adds permissions, statistics, owner and _links — measured on a
    // real instance, several times the bytes and wait, for none of the fields below.
    const url = `${apiBase(host)}/projects?membership=true&per_page=100&order_by=last_activity_at&simple=true`;
    const entries = (await getPaged(url, headers(token))) as GitLabProject[];
    return entries.map(
      (entry): RemoteRepository => ({
        fullName: entry.path_with_namespace,
        name: entry.path,
        cloneUrl: entry.http_url_to_repo
      })
    );
  }
};
