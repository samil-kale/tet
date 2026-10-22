import { safeStorage } from "electron";

/**
 * A value encrypted by the OS and base64-wrapped, as TET's own files keep a token or a secret.
 * Throws when the OS offers no encryption — on Linux without a keyring, where safeStorage would fall
 * back to a fixed key.
 */
export async function seal(value: string): Promise<string> {
  if (!(await safeStorage.isAsyncEncryptionAvailable())) {
    throw new Error("The OS offers no encryption to store a value with (on Linux: no keyring)");
  }
  return (await safeStorage.encryptStringAsync(value)).toString("base64");
}

/** What `seal` stored; undefined when it was encrypted under a keychain this machine no longer
 *  has, and must be entered again. */
export async function unseal(stored: string): Promise<string | undefined> {
  try {
    return (await safeStorage.decryptStringAsync(Buffer.from(stored, "base64"))).result;
  } catch {
    return undefined;
  }
}
