import { githubAccount } from "./account";
import { githubChangeRequests } from "./change-requests";
import { githubIssues } from "./issues";
import { githubRepository } from "./repository";
import type { GitProvider } from "../provider";

export const github: GitProvider = {
  account: githubAccount,
  repository: githubRepository,
  issues: githubIssues,
  changeRequests: githubChangeRequests,
};
