import { gitlabAccount } from "./account";
import { gitlabChangeRequests } from "./change-requests";
import { gitlabIssues } from "./issues";
import { gitlabRepository } from "./repository";
import type { GitProvider } from "../provider";

export const gitlab: GitProvider = {
  account: gitlabAccount,
  repository: gitlabRepository,
  issues: gitlabIssues,
  changeRequests: gitlabChangeRequests,
};
