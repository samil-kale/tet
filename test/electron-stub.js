/**
 * `electron` for the tests (esbuild.js's testConfig aliases it): node's runner has no electron, and
 * the real package only exports the binary's path. CommonJS, so esbuild checks no named import
 * against it: only what main code reachable from a test reads at runtime is here, anything else is
 * undefined and fails where it is used. `shell` and `utilityProcess` are empty for a test to fill
 * with its fakes (repository.test.ts).
 */
module.exports = { nativeTheme: { shouldUseDarkColors: true }, shell: {}, utilityProcess: {} };
