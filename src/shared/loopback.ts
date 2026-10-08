/**
 * Whether `hostname` (no port; an IPv6 address bare or in brackets) is the machine's own, as Chrome
 * takes it: `localhost` and every name under it, 127.0.0.0/8, `::1` and `0.0.0.0`. A browser tab
 * reaches it over http with a dev server's own certificate (browser-tabs.ts), and a sandbox's relay
 * dials it in the sandbox itself (src/cli/browser-relay.ts).
 */
export function isLoopbackHost(hostname: string): boolean {
  const name = bareHost(hostname).toLowerCase();
  return name === "localhost" || name.endsWith(".localhost") || name === "::1" || name === "0.0.0.0" || /^127\.\d+\.\d+\.\d+$/.test(name);
}

/** `host` without the brackets a URL puts around an IPv6 address. */
export function bareHost(host: string): string {
  return host.replace(/^\[|\]$/g, "");
}
