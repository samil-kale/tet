/** Whether `text` is an http(s) url with a host, as a field asking for a web address takes it: what a
 *  typed row is checked against before the tool it goes to is asked. */
export function isHttpUrl(text: string): boolean {
  const parsed = URL.parse(text.trim());
  return parsed !== null && (parsed.protocol === "https:" || parsed.protocol === "http:") && parsed.hostname !== "";
}
