const { EventEmitter } = require("node:events");

/**
 * A notification a test's call into `showDesktopNotification` made: an event emitter, as the real
 * thing is, so a test can simulate a click on it. Kept on `instances`, oldest first, for a test to
 * find the one it just caused (notifications.test.ts via util.test.ts).
 */
class Notification extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    Notification.instances.push(this);
  }
  show() {}
  close() {}
}
Notification.instances = [];
Notification.isSupported = () => true;
Notification.handleActivation = () => undefined;

/**
 * `electron` for the tests (esbuild.js's testConfig aliases it): the real package only exports the
 * binary's path. CommonJS, so esbuild checks no named import against it: only what main code
 * reachable from a test reads is here, anything else fails where it is used. `shell`,
 * `utilityProcess` and `safeStorage` are empty for a test to fill with its fakes (helpers/index.ts's
 * forkUtilitiesInProcess and fakeSafeStorage, repository.test.ts's trash). `app`'s members are
 * harmless no-ops; nothing yet reads more of it from a test.
 */
module.exports = {
  nativeTheme: { shouldUseDarkColors: true },
  shell: {},
  utilityProcess: {},
  safeStorage: {},
  Notification,
  app: { isPackaged: false, whenReady: () => Promise.resolve(), setAppUserModelId: () => undefined, setToastActivatorCLSID: () => undefined },
};
