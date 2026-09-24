export function isMac(): boolean {
  return navigator.platform.toLowerCase().includes("mac");
}

export function isWindows(): boolean {
  return navigator.platform.toLowerCase().includes("win");
}

export function isLinux(): boolean {
  return navigator.platform.toLowerCase().includes("linux");
}

/** Gates link activation and paste: Cmd on macOS, Ctrl elsewhere. */
export function isModifierHeld(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMac() ? event.metaKey : event.ctrlKey;
}

export function isModifierKey(event: KeyboardEvent): boolean {
  return isMac() ? event.key === "Meta" : event.key === "Control";
}

/** The modifier as a shortcut label spells it. */
export function modifierLabel(): string {
  return isMac() ? "⌘" : "Ctrl";
}

export function revealLabel(): string {
  if (isMac()) {
    return "Reveal in Finder";
  }
  return isWindows() ? "Show in Explorer" : "Show in your file manager";
}

/** A `/`-separated relative path as a native absolute one, for the clipboard. */
export function absolutePath(projectPath: string, relative: string): string {
  return [projectPath, ...relative.split("/")].join(isWindows() ? "\\" : "/");
}
