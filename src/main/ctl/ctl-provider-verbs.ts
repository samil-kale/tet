import { API_METHODS, type ControlVerbName } from "../../shared/ctl";
import { errorMessage } from "../../shared/errors";
import { appendLog } from "../util/error-log";
import { ControlError, oneOf, optionalText, refusable, text, type ControlDeps, type Handler, type RefFrom } from "./ctl-verb";

/**
 * The verb for the rest of the project's tracker (GitHub, GitLab) that the issue verbs leave out:
 * pull and merge requests, branches, pipelines. It reaches the host the project's issues are read
 * from with the account's token, which the caller never sees, and nothing else.
 */
export function providerVerbs(deps: ControlDeps, refFrom: RefFrom): Record<Extract<ControlVerbName, `provider-${string}`>, Handler> {
  return {
    "provider-api": (args, caller) => {
      const { project } = refFrom(args, caller);
      const method = oneOf(args, "method", "method", API_METHODS);
      const path = text(args, "path", "path");
      const body = optionalText(args, "data");
      if (method === "GET" && body !== undefined) {
        throw new ControlError("bad_args", "a GET takes no body");
      }
      /** Every request is kept, as the user's token acts for the caller. */
      const log = (outcome: string) =>
        appendLog(
          `[TET] provider-api ${method} ${path} (project ${project.id}, tab ${caller.tabId ?? "none"}): ${outcome} ${new Date().toISOString()}\n`,
        );
      return refusable(async () => {
        try {
          const answer = await deps.providerRequest(project.id, { method, path, body });
          log(String(answer.status));
          return { result: answer };
        } catch (error) {
          log(errorMessage(error));
          throw error;
        }
      });
    },
  };
}
