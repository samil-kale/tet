import type { ProviderId } from "../../shared/types";
import { github } from "./github";
import { gitlab } from "./gitlab";
import type { GitProvider } from "./provider";

export const PROVIDERS: Record<ProviderId, GitProvider> = { github, gitlab };
