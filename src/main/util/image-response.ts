/** A response's image as a data URL; null for an error, anything but an image, or one over the cap. */
export async function imageDataUrl(response: Response, maxBytes: number): Promise<string | null> {
  const type = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() ?? "";
  if (!response.ok || !type.startsWith("image/") || !response.body) {
    void response.body?.cancel();
    return null;
  }
  // Read in chunks against the cap: a response without a content-length would otherwise be held
  // whole before it could be measured. Leaving the loop cancels the rest.
  const chunks: Uint8Array[] = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > maxBytes) {
      return null;
    }
    chunks.push(chunk);
  }
  return `data:${type};base64,${Buffer.concat(chunks).toString("base64")}`;
}
