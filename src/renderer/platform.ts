import { platformOf } from "../shared/platform";

/** The platform the window runs on (src/shared/platform.ts), read off `navigator`: the renderer
 *  has no `process`. */
export const PLATFORM = platformOf(detect(navigator.platform.toLowerCase()));

function detect(reported: string): string {
  if (reported.includes("mac")) {
    return "darwin";
  }
  return reported.includes("win") ? "win32" : "linux";
}

/** The platform's modifier held (Platform.modifierKey), for shortcuts, links, copy and paste. */
export function isModifierHeld(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return PLATFORM.modifierKey === "Meta" ? event.metaKey : event.ctrlKey;
}

export function isModifierKey(event: KeyboardEvent): boolean {
  return event.key === PLATFORM.modifierKey;
}

/** A `/`-separated relative path as a native absolute one, for the clipboard. */
export function absolutePath(projectPath: string, relative: string): string {
  return [projectPath, ...relative.split("/")].join(PLATFORM.pathSeparator);
}
