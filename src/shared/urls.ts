/**
 * A url: `<scheme>://` up to whitespace, `"` or `'`. Adapted from @xterm/addon-web-links with a
 * generic RFC 3986 scheme, so deep links (`msteams://`, `vscode://`) match. For terminal rows.
 */
export const URL_REGEX = /[A-Za-z][A-Za-z0-9+.-]*:[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/;

