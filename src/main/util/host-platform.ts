import { platformOf } from "../../shared/platform";

/** The platform the main process runs on (src/shared/platform.ts). */
export const PLATFORM = platformOf(process.platform);
