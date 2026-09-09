/**
 * Considers everything from a `<scheme>://` up to the first whitespace, `"` or `'` a url. Adapted
 * from @xterm/addon-web-links's WebLinksAddon, with the scheme matched generically (RFC 3986) so an
 * agent's deep links — `msteams://`, `vscode://` — are recognized too. Used on terminal rows, one
 * line at a time; large text goes through findUrls() instead.
 */
export const URL_REGEX = /[A-Za-z][A-Za-z0-9+.-]*:[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

/** A character URL_REGEX accepts inside a url — mirrors its body class. */
export const URL_BODY_CHAR = /[^\s"'!*(){}|\\^<>`]/;

/** A character URL_REGEX accepts as a url's last one — mirrors its final class. */
const URL_END_CHAR = /[^\s"':,.!?{}|\\^~[\]`()<>]/;

const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
const LETTER = /[A-Za-z]/;

/**
 * Every url in a chunk of text, in order of appearance. Deliberately not URL_REGEX: its
 * `[A-Za-z][A-Za-z0-9+.-]*` prefix backtracks through every alphanumeric run not followed by a
 * colon, which is quadratic on the text this is called with (raw JSON with base64 blobs and file
 * contents in it). Anchoring on "://" and expanding outwards visits each character a bounded number
 * of times. The result matches URL_REGEX's, bar a url ending in "*".
 */
export function findUrls(text: string): string[] {
  const urls: string[] = [];
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", at + 3)) {
    let start = at;
    while (start > 0 && SCHEME_CHAR.test(text[start - 1])) {
      start--;
    }
    // A scheme starts with a letter; anything before that belongs to whatever precedes it.
    while (start < at && !LETTER.test(text[start])) {
      start++;
    }
    if (start === at) {
      continue;
    }
    let end = at + 3;
    while (end < text.length && URL_BODY_CHAR.test(text[end])) {
      end++;
    }
    while (end > at + 3 && !URL_END_CHAR.test(text[end - 1])) {
      end--;
    }
    if (end > at + 3) {
      urls.push(text.slice(start, end));
    }
  }
  return urls;
}
