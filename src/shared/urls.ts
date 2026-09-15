/**
 * A url: `<scheme>://` up to whitespace, `"` or `'`. Adapted from @xterm/addon-web-links with a
 * generic RFC 3986 scheme, so deep links (`msteams://`, `vscode://`) match. For single terminal
 * rows; large text goes through findUrls().
 */
export const URL_REGEX = /[A-Za-z][A-Za-z0-9+.-]*:[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

/** A character URL_REGEX accepts inside a url — mirrors its body class. */
export const URL_BODY_CHAR = /[^\s"'!*(){}|\\^<>`]/;

/** A character URL_REGEX accepts as a url's last one — mirrors its final class. */
const URL_END_CHAR = /[^\s"':,.!?{}|\\^~[\]`()<>]/;

const SCHEME_CHAR = /[A-Za-z0-9+.-]/;
const LETTER = /[A-Za-z]/;

/**
 * Every url in the text, in order. Not URL_REGEX: its scheme prefix backtracks through every
 * alphanumeric run, quadratic on raw JSON with base64 blobs. Anchoring on "://" and expanding
 * outwards is linear. Matches URL_REGEX, bar a url ending in "*".
 */
export function findUrls(text: string): string[] {
  const urls: string[] = [];
  for (let at = text.indexOf("://"); at !== -1; at = text.indexOf("://", at + 3)) {
    let start = at;
    while (start > 0 && SCHEME_CHAR.test(text[start - 1])) {
      start--;
    }
    // A scheme starts with a letter.
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
