import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { createModifierGatedLinkProvider } from "./link-provider";

/**
 * A url: `<scheme>://` up to whitespace, `"` or `'`. Adapted from @xterm/addon-web-links with a
 * generic RFC 3986 scheme, so deep links (`msteams://`, `vscode://`) match. For terminal rows.
 */
const URL_REGEX = /[A-Za-z][A-Za-z0-9+.-]*:[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

// Not @xterm/addon-web-links: it underlines on hover regardless of modifier.
export function createUrlLinkProvider(terminal: Terminal, onOpenUrl: (url: string) => void): ILinkProvider {
  return createModifierGatedLinkProvider(terminal, URL_REGEX, "://", onOpenUrl);
}
