import * as crypto from "node:crypto";
import * as http from "node:http";
import { errorMessage } from "../../shared/errors";
import { CONTROL_HOST, CONTROL_VERBS, HELP_VERB } from "../../shared/control";
import type { ControlErrorCode, ControlRequest, ControlResponse } from "../../shared/control";
import { sameProjectRef } from "../../shared/types";
import type { ProjectRef } from "../../shared/types";
import { CALLER_SIDES, HOST_CALLER } from "./caller-side";
import { tabControlToken } from "../terminals/control-token";
import { verbs } from "./control-verbs";
import { callerRef, ControlError, resolveCallerRef, type ControlDeps, type Handler } from "./control-verb";
import { isRecord } from "../util/json-file";

function reject(code: ControlErrorCode, message: string): ControlResponse {
  return { ok: false, error: { code, message } };
}

/** A tet-ctl writes its request at once. */
const REQUEST_TIMEOUT_MS = 30_000;

/** How long a request may be, checked while it arrives — see the read in `startControlServer`. */
const MAX_REQUEST_CHARS = 1024 * 1024;

/**
 * The server `tet-ctl` talks to: one POST per connection on 127.0.0.1. HTTP, not raw TCP, because
 * a sandbox reaches `host.docker.internal` through sbx's HTTP-only proxy. Every request must
 * carry this run's token from
 * main.ts, or its tab's token for the caller ids it names (control-token.ts), else `unauthorized`.
 */
export async function startControlServer(
  deps: ControlDeps,
  token: string,
  port: number
): Promise<{ close: () => Promise<void> }> {
  const handlers = verbs(deps);

  const handle = async (
    request: ControlRequest,
    gone: AbortSignal
  ): Promise<{ response: ControlResponse; after?: () => void }> => {
    const caller: ControlRequest["caller"] = {
      projectId: typeof request.caller?.projectId === "string" ? request.caller.projectId : undefined,
      worktree: typeof request.caller?.worktree === "string" && request.caller.worktree ? request.caller.worktree : undefined,
      tabId: typeof request.caller?.tabId === "string" ? request.caller.tabId : undefined
    };
    // A caller's ids count only with the token made for them; the run's own token speaks for no
    // tab, and no terminal has it (control-token.ts).
    const given = Buffer.from(typeof request.token === "string" ? request.token : "");
    const matches = (expected: string): boolean => {
      const want = Buffer.from(expected);
      return given.length === want.length && crypto.timingSafeEqual(given, want);
    };
    // A caller naming no tab is the run itself, on this machine. For a tab, which side's token
    // matches says where it runs: read off the token, not looked up, so a tab closed with its
    // repository or worktree is still answered by the rules it started under (control-token.ts).
    const ofTab = caller.projectId !== undefined || caller.worktree !== undefined || caller.tabId !== undefined;
    const side = ofTab
      ? CALLER_SIDES.find((candidate) =>
          matches(tabControlToken(token, { projectId: caller.projectId ?? "", worktree: caller.worktree }, caller.tabId ?? "", candidate))
        )
      : matches(token)
        ? HOST_CALLER
        : undefined;
    if (!side) {
      return { response: reject("unauthorized", "not a terminal of this TET") };
    }
    const entry = request.verb === HELP_VERB ? undefined : CONTROL_VERBS.find((candidate) => candidate.verb === request.verb);
    // Widened to look up by the request's name: every listed verb has its handler (Handlers).
    const handler = entry && (handlers as Record<string, Handler | undefined>)[entry.verb];
    if (!entry || !handler) {
      return { response: reject("unknown_verb", `unknown verb: ${String(request.verb)} (see tet-ctl help)`) };
    }
    if (!side.admits(entry)) {
      return { response: reject("unauthorized", `${request.verb} ${side.refusal}`) };
    }
    // A host tab reaches every repository and worktree of its project (a worktree belongs to it); a
    // sandboxed one only its own, the one its sandbox mounts — but for an `ownProject` verb.
    const own = callerRef(caller);
    const reach = side.reach(entry);
    if (reach !== "any") {
      const ownOnly = reach === "ownRef";
      let target: ProjectRef | undefined;
      try {
        target = own && resolveCallerRef(deps.store, request.args ?? {}, caller).ref;
      } catch (error) {
        return { response: error instanceof ControlError ? reject(error.code, error.message) : reject("internal", errorMessage(error)) };
      }
      const allowed = own !== undefined && target !== undefined && (ownOnly ? sameProjectRef(target, own) : target.projectId === own.projectId);
      if (!allowed) {
        const whose = ownOnly ? "the caller's own repository or worktree" : "the caller's own project";
        return { response: reject("unauthorized", `${request.verb} only answers for ${whose}`) };
      }
    }
    try {
      const answer = await handler(request.args ?? {}, { ...caller, side }, request.at, gone);
      await side.checkAnswer(entry, answer.result, own && deps.projectRefPath(own));
      return { response: { ok: true, result: answer.result }, after: answer.after };
    } catch (error) {
      if (error instanceof ControlError) {
        return { response: reject(error.code, error.message) };
      }
      return { response: reject("internal", errorMessage(error)) };
    }
  };

  const respond = (res: http.ServerResponse, response: ControlResponse, after?: () => void): void => {
    res.writeHead(200, { "Content-Type": "application/json", Connection: "close" });
    if (after) {
      // `close` means flushed and disconnected, not merely handed to the OS.
      res.once("close", after);
    }
    res.end(JSON.stringify(response) + "\n");
  };

  const server = http.createServer({ requestTimeout: REQUEST_TIMEOUT_MS }, (req, res) => {
    if (req.method !== "POST") {
      res.writeHead(405, { Connection: "close" }).end();
      return;
    }
    req.setEncoding("utf8");
    let body = "";
    let tooLarge = false;
    req.on("data", (chunk: string) => {
      if (tooLarge) {
        return;
      }
      body += chunk;
      // The token is only checked once the body is whole, so an unauthenticated caller would
      // otherwise decide how much of this process's memory to take. Well past the longest real
      // request (`tabs-create`'s prompt) and nowhere near what would hurt.
      //
      // Nothing is kept from here on, but the rest is still read and dropped, and the answer waits
      // for `end` like any other: closing the connection early (`req.destroy()`, or answering while
      // the caller still writes) reaches it as ECONNRESET instead of the refusal.
      if (body.length > MAX_REQUEST_CHARS) {
        tooLarge = true;
        body = "";
      }
    });
    req.on("end", () => {
      if (tooLarge) {
        respond(res, reject("bad_args", `the request is longer than ${MAX_REQUEST_CHARS} characters`));
        return;
      }
      let request: ControlRequest;
      try {
        request = JSON.parse(body) as ControlRequest;
      } catch {
        respond(res, reject("bad_args", "not a JSON request"));
        return;
      }
      // A non-object would throw inside `handle`, leaving the connection unanswered.
      if (!isRecord(request)) {
        respond(res, reject("bad_args", "not a JSON request"));
        return;
      }
      // A response closed before it ended is a caller gone mid-answer (Ctrl+C on a waiting CLI).
      const gone = new AbortController();
      res.once("close", () => {
        if (!res.writableEnded) {
          gone.abort();
        }
      });
      void handle(request, gone.signal).then(({ response, after }) => respond(res, response, after));
    });
    req.on("error", () => undefined);
    // A response write failing after hand-over (CLI gone, reset, or this process exiting) is
    // otherwise an uncaught exception, e.g. `write EAGAIN`.
    res.on("error", () => undefined);
  });

  // The OS reclaims a killed run's port, so EADDRINUSE means another tet is listening: let it surface.
  await bind(server, port);

  return {
    // closeAllConnections: else an unfinished request holds server.close() open forever.
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      })
  };
}

function bind(server: http.Server, port: number): Promise<void> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, CONTROL_HOST, () => {
      server.off("error", reject);
      resolve();
    });
  });
}
