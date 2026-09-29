import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { URL_REGEX } from "../../../shared/urls";
import { createModifierGatedLinkProvider } from "./link-provider";

// Not @xterm/addon-web-links: it underlines on hover regardless of modifier.
export function createUrlLinkProvider(terminal: Terminal, onOpenUrl: (url: string) => void): ILinkProvider {
  return createModifierGatedLinkProvider(terminal, URL_REGEX, "://", onOpenUrl);
}
