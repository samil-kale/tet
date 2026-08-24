import type { ILinkProvider, Terminal } from "@xterm/xterm";
import { createModifierGatedLinkProvider } from "./link-provider";

// Matches a plausible space-free file-path token. Two shapes:
//  (A) a path with at least one path separator, e.g. "src/main/main.ts",
//      "./foo/bar.ts", "C:\Users\x\file.txt", "src\main.ts",
//      "~/.claude/settings.json"
//  (B) a bare filename with no separator, e.g. "package.json" — stem must be
//      >=2 chars to reject 1-letter-stem prose artifacts like "e.g"/"i.e".
// In both shapes the extension must contain at least one letter, which rejects
// purely-numeric "extensions" — this is what keeps IPs (192.168.1.1) and semver
// (1.0.0) out, since their final dot-segment is all digits.
//
// This intentionally accepts some false positives (e.g. "Node.js" in prose) —
// the host-side existence check (see ipc.ts) is the real safety net, a bogus
// match just fails to open with a notice.
const FILE_PATH_REGEX =
  /(?:(?:[A-Za-z]:[\\/]|\.{1,2}[\\/]|~[\\/])(?:[\w@.+-]+[\\/])*|(?:[\w@.+-]+[\\/])+)[\w@+-][\w@.+-]*\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}|[\w@+-]{2,}[\w@.+-]*\.(?=[A-Za-z0-9]*[A-Za-z])[A-Za-z0-9]{1,10}/;

export function createFileLinkProvider(terminal: Terminal, onOpenFile: (path: string) => void): ILinkProvider {
  return createModifierGatedLinkProvider(terminal, FILE_PATH_REGEX, ".", onOpenFile);
}
