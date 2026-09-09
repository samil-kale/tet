import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { URL_REGEX } from "../../../shared/urls";
import { createModifierGatedLinkProvider, type WrappedUrlResolver } from "./link-provider";

// Not @xterm/addon-web-links directly: that addon always shows its underline and pointer cursor
// on hover, regardless of any modifier key. URL_REGEX is shared with the main process
// (shared/urls.ts), which recognizes the same urls in an agent's output for resolveWrapped.
export function createUrlLinkProvider(
  terminal: Terminal,
  onOpenUrl: (url: string) => void,
  resolveWrapped?: WrappedUrlResolver
): ILinkProvider {
  return createModifierGatedLinkProvider(terminal, URL_REGEX, "://", onOpenUrl, resolveWrapped);
}
