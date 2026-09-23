import { safeStorage } from "electron";

/**
 * A value encrypted by the OS and base64-wrapped, as tet's own files keep a token or a secret.
 * Throws when the OS offers no encryption — on Linux without a keyring, where safeStorage would fall
 * back to a fixed key.
 */
export function seal(value: string): string {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("The OS offers no encryption to store a value with (on Linux: no keyring)");
  }
  return safeStorage.encryptString(value).toString("base64");
}

/** What `seal` stored; undefined when it was encrypted under a keychain this machine no longer
 *  has, and must be entered again. */
export function unseal(stored: string): string | undefined {
  try {
    return safeStorage.decryptString(Buffer.from(stored, "base64"));
  } catch {
    return undefined;
  }
}
