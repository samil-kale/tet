import type { ControlVerbName } from "../../shared/ctl";
import { errorMessage } from "../../shared/errors";
import type { ProjectRef } from "../../shared/types/project";
import { browserUrl, type BrowserSandbox, type BrowserScope } from "../browser/browser-tabs";
import { writeDropFile } from "../store/drops";
import {
  bringToFront,
  callerTab,
  ControlError,
  count,
  optionalText,
  seenPath,
  text,
  type Caller,
  type ControlDeps,
  type Handler,
  type RefFrom,
} from "./ctl-verb";

/** How often `browser-open --wait` asks again while no server answers. */
const OPEN_RETRY_MS = 500;

/**
 * The browser verbs: open a page in the repository's or worktree's browser tab, read it, act on it
 * through Playwright (browser/browser-automation.ts). Without `--tab` a verb acts on the tab the
 * window last showed, or the last one opened. What a page says is someone else's: every answer
 * carrying its content says so (`untrustedContent`).
 *
 * A caller in a sandbox (CallerSide.browsesInSandbox) opens its tabs in its sandbox, loading
 * through it, and sees no others; one on this machine sees no sandbox's.
 */
export function browserVerbs(deps: ControlDeps, refFrom: RefFrom): Record<Extract<ControlVerbName, `browser-${string}`>, Handler> {
  const { tabs, automation } = deps.browser;

  /** The caller's sandbox, whose tabs alone it sees; none on this machine. Never this machine's for
   *  a caller in a sandbox: one whose tab names none is refused. */
  const sandboxOf = (caller: Caller): BrowserSandbox | undefined => {
    if (!caller.side.browsesInSandbox) {
      return undefined;
    }
    const own = callerTab(deps, caller);
    const sandbox = own?.terminals.browserSandbox(own.tabId);
    if (!sandbox) {
      throw new ControlError("unauthorized", "this tab runs in no sandbox its browser tabs could load through");
    }
    return sandbox;
  };

  const scopeOf = (caller: Caller): BrowserScope => ({ sandbox: sandboxOf(caller)?.name });

  /** The tab `--tab` names within `scope`, else the active one; `optional` answers none rather than
   *  refusing. */
  function pageOf(args: Record<string, unknown>, caller: Caller): { ref: ProjectRef; tabId: string };
  function pageOf(args: Record<string, unknown>, caller: Caller, optional: true, scope: BrowserScope): { ref: ProjectRef; tabId?: string };
  function pageOf(
    args: Record<string, unknown>,
    caller: Caller,
    optional = false,
    scope = scopeOf(caller),
  ): { ref: ProjectRef; tabId?: string } {
    const { ref } = refFrom(args, caller);
    const wanted = optionalText(args, "tab");
    const page = tabs.page(ref, wanted, scope);
    if (!page && optional && wanted === undefined) {
      return { ref };
    }
    if (!page) {
      throw new ControlError(
        "not_found",
        wanted === undefined ? "no browser tab: open one with browser-open" : `unknown browser tab: ${wanted} (see browser-list)`,
      );
    }
    return { ref, tabId: page.tabId };
  }

  /**
   * `browser-open --wait`: until a server answers `url` in the tab, asked over and over without
   * loading it (BrowserTabs.answers); one notice when it gives up, not one per try.
   */
  const answered = async (ref: ProjectRef, tabId: string, url: string, seconds: number, gone: AbortSignal): Promise<void> => {
    const deadline = Date.now() + seconds * 1000;
    for (;;) {
      try {
        await tabs.answers(ref, tabId, url);
        return;
      } catch (error) {
        if (gone.aborted) {
          throw new ControlError("timeout", `stopped waiting for ${url}: the caller is gone`);
        }
        if (Date.now() >= deadline) {
          const message = `${url} did not answer within ${seconds} s: ${errorMessage(error)}`;
          deps.notice("warning", message);
          throw new ControlError("timeout", message);
        }
      }
      await new Promise((resolve) => setTimeout(resolve, OPEN_RETRY_MS));
    }
  };

  /** A `[ref=eN]` of the last browser-snapshot: an element, not a repository or worktree. */
  const element = (args: Record<string, unknown>): string => text(args, "ref", "ref: pass one of browser-snapshot's [ref=…]");

  /** Playwright's own words for what it could not do: a ref gone stale, a wait run out. */
  const acting = async <T>(run: () => Promise<T>): Promise<T> => {
    try {
      return await run();
    } catch (error) {
      throw new ControlError("bad_args", errorMessage(error));
    }
  };

  return {
    "browser-open": async (args, caller, _at, gone) => {
      const url = text(args, "url", "url");
      const seconds = args.wait === undefined ? undefined : count(args, "wait", 0);
      const sandbox = sandboxOf(caller);
      const scope = { sandbox: sandbox?.name };
      const { ref, tabId: existing } = pageOf(args, caller, true, scope);
      let tabId = existing;
      try {
        if (seconds !== undefined) {
          // A mistyped address fails now, not once the wait ran out.
          browserUrl(url);
          // An empty tab first: its profile, and a sandbox's way out, ask for the page.
          if (tabId === undefined) {
            const blank = tabs.create(ref, "", sandbox);
            tabId = blank.tab.tabId;
            await blank.loaded;
          }
          await answered(ref, tabId, url, seconds, gone);
        }
        let loaded: Promise<void>;
        if (tabId === undefined) {
          const created = tabs.create(ref, url, sandbox);
          tabId = created.tab.tabId;
          loaded = created.loaded;
        } else {
          loaded = tabs.navigate(ref, tabId, url);
        }
        bringToFront(deps, args, ref, tabId);
        await loaded;
      } catch (error) {
        if (error instanceof ControlError) {
          throw error;
        }
        throw new ControlError("not_found", `could not load ${url}: ${errorMessage(error)}`);
      }
      const page = tabs.page(ref, tabId, scope);
      return { result: { tabId, url: page?.url, title: page?.title, untrustedContent: true } };
    },

    "browser-list": (args, caller) => {
      const { ref } = refFrom(args, caller);
      const scope = scopeOf(caller);
      const active = tabs.page(ref, undefined, scope)?.tabId;
      const listed = tabs
        .list(ref, scope)
        .map(({ tabId, url, title, loading }) => ({ tabId, url, title, loading, active: tabId === active }));
      // The titles are the pages' own.
      return { result: { tabs: listed, untrustedContent: true } };
    },

    "browser-snapshot": async (args, caller) => {
      const { tabId } = pageOf(args, caller);
      return { result: { tabId, ...(await acting(() => automation.snapshot(tabId))), untrustedContent: true } };
    },

    "browser-click": async (args, caller) => {
      const { tabId } = pageOf(args, caller);
      const clicked = element(args);
      await acting(() => automation.click(tabId, clicked));
      return { result: { clicked } };
    },

    "browser-fill": async (args, caller) => {
      const { tabId } = pageOf(args, caller);
      const filled = element(args);
      // Required, but may be empty: "" clears the field.
      if (typeof args.text !== "string") {
        throw new ControlError("bad_args", 'missing <text>: pass the text to type, "" to clear the field');
      }
      const value = args.text;
      await acting(() => automation.fill(tabId, filled, value));
      return { result: { filled } };
    },

    "browser-press": async (args, caller) => {
      const { tabId } = pageOf(args, caller);
      const key = text(args, "key", "key");
      await acting(() => automation.press(tabId, key));
      return { result: { pressed: key } };
    },

    "browser-wait": async (args, caller) => {
      const { tabId } = pageOf(args, caller);
      const waitedText = optionalText(args, "text");
      const url = optionalText(args, "url");
      if (waitedText === undefined && url === undefined) {
        throw new ControlError("bad_args", "nothing to wait for: pass --text or --url");
      }
      await acting(() => automation.waitFor(tabId, waitedText, url));
      return { result: { tabId } };
    },

    // Chromium's own capture, which a page out of sight answers too.
    "browser-screenshot": async (args, caller) => {
      const { ref, tabId } = pageOf(args, caller);
      const own = callerTab(deps, caller);
      if (!own) {
        throw new ControlError("bad_args", "only from a tab, whose drops folder takes the file");
      }
      const png = await tabs.capture(ref, tabId);
      if (!png) {
        throw new ControlError("bad_args", "the page has drawn nothing yet");
      }
      const file = await writeDropFile(own.terminals.dropsDir(own.tabId), "browser.png", png);
      return { result: { path: await seenPath(deps, caller, file) } };
    },

    "browser-console": async (args, caller) => {
      const { tabId } = pageOf(args, caller);
      return { result: { messages: await automation.consoleMessages(tabId), untrustedContent: true } };
    },

    // The file names are the servers' own.
    "browser-downloads": async (args, caller) => {
      const { ref } = refFrom(args, caller);
      const downloads = await Promise.all(
        tabs.downloads(ref, scopeOf(caller)).map(async ({ path, url, state, receivedBytes, totalBytes }) => ({
          path: await seenPath(deps, caller, path),
          url,
          state,
          receivedBytes,
          totalBytes,
        })),
      );
      return { result: { downloads, untrustedContent: true } };
    },

    "browser-close": (args, caller) => {
      const { ref, tabId } = pageOf(args, caller);
      tabs.close(ref, tabId);
      return { result: { closed: tabId } };
    },
  };
}
