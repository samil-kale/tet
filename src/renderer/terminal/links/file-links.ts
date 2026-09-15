import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { createModifierGatedLinkProvider } from "./link-provider";

// A space-free file-path token, either:
//  (A) with a separator: "src/main/main.ts", "./foo/bar.ts", "C:\Users\x\file.txt", "~/.x/y.json"
//  (B) a bare filename: "package.json" — stem >=2 chars, to reject "e.g"/"i.e".
// The extension needs a letter, keeping out IPs and semver. False positives are fine: ipc.ts's
// existence check is the safety net.
const FILE_PATH_REGEX =
  /(?:(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/])(?:[\w@.+-]+[\\/])*|(?:[\w@.+-]+[\\/])+)[\w@+-][\w@.+-]*\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}|[\w@+-]{2,}[\w@.+-]*\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}/;

export function createFileLinkProvider(terminal: Terminal, onOpenFile: (path: string) => void): ILinkProvider {
  return createModifierGatedLinkProvider(terminal, FILE_PATH_REGEX, ".", onOpenFile);
}
