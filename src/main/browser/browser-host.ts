import * as browserAutomation from "./browser-automation";
import { serveModule } from "../util/utility-host";

/**
 * The browser's process: Playwright driving the browser tabs' pages (browser-automation.ts) in its
 * own `utilityProcess` (browser-client.ts), its CDP over the port handed in beside the calls.
 * Nothing here or in browser-automation.ts may import electron.
 */
serveModule(browserAutomation, browserAutomation.usePort);
