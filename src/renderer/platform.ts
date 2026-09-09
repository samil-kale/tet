export function isMac(): boolean {
  return navigator.platform.toLowerCase().includes("mac");
}

function isWindows(): boolean {
  return navigator.platform.toLowerCase().includes("win");
}

/** The key that gates link activation and paste: Cmd on macOS, Ctrl everywhere else. */
export function isModifierHeld(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

export function isModifierKey(event: KeyboardEvent): boolean {
  return isMac() ? event.key === "Meta" : event.key === "Control";
}

/** What each platform calls its own file manager. */
export function revealLabel(): string {
  if (isMac()) {
    return "Reveal in Finder";
  }
  return isWindows() ? "Show in Explorer" : "Show in your file manager";
}

/** git and this app's file listing report `/`-separated paths; the clipboard gets a native one. */
export function absolutePath(projectPath: string, relative: string): string {
  return [projectPath, ...relative.split("/")].join(isWindows() ? "\\" : "/");
}
