import { type GitProviderRepository, fetchImageOk } from "../provider";
import { allLabels, sender, allPeople, uploadOf, projectUrl, headers, mutate } from "./api";

export const gitlabRepository: GitProviderRepository = {
  async listLabels({ host, token, path }) {
    return (await allLabels(sender(host, token), path)).map((entry) => entry.name);
  },

  async listPeople({ host, token, path }) {
    return (await allPeople(sender(host, token), path)).map((entry) => entry.name);
  },

  async readImage({ host, token, path }, source) {
    const upload = uploadOf(host, source);
    return upload && fetchImageOk(`${projectUrl(host, path)}/uploads/${upload.secret}/${upload.file}`, headers(token));
  },

  async editComment({ host, token }, id, body) {
    await mutate(sender(host, token), { mutation: "updateNote", inputType: "UpdateNoteInput", input: { id, body } });
  },

  async deleteComment({ host, token }, id) {
    await mutate(sender(host, token), { mutation: "destroyNote", inputType: "DestroyNoteInput", input: { id } });
  },
};
