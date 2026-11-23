import { type GitProviderRepository, fetchImageOk } from "../provider";
import { allLabels, sender, allAssignable, readsWithToken, mutate } from "./api";

export const githubRepository: GitProviderRepository = {
  async listLabels({ host, token, path }) {
    return (await allLabels(sender(host, token), path)).map((entry) => entry.name);
  },

  async listPeople({ host, token, path }) {
    return (await allAssignable(sender(host, token), path)).map((entry) => entry.name);
  },

  async readImage({ host, token }, source) {
    return readsWithToken(host, source) ? fetchImageOk(source, { Authorization: `Bearer ${token}`, "User-Agent": "tet" }) : undefined;
  },

  async editComment({ host, token }, id, body) {
    await mutate(sender(host, token), {
      mutation: "updateIssueComment",
      inputType: "UpdateIssueCommentInput",
      input: { id, body },
    });
  },

  async deleteComment({ host, token }, id) {
    await mutate(sender(host, token), { mutation: "deleteIssueComment", inputType: "DeleteIssueCommentInput", input: { id } });
  },
};
