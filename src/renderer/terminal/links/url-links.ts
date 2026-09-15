import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { URL_REGEX } from "../../../shared/urls";
import { createModifierGatedLinkProvider, type WrappedUrlResolver } from "./link-provider";

// Not @xterm/addon-web-links: it underlines on hover regardless of modifier. URL_REGEX is shared
// with the main process, which matches the same urls in an agent's output for resolveWrapped.
export function createUrlLinkProvider(
  terminal: Terminal,
  onOpenUrl: (url: string) => void,
  resolveWrapped?: WrappedUrlResolver
): ILinkProvider {
  return createModifierGatedLinkProvider(terminal, URL_REGEX, "://", onOpenUrl, resolveWrapped);
}
