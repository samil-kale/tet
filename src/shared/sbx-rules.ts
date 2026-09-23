/**
 * What an SBX Settings row may be, and what its edits reach — one rule for the dialog's marks
 * (src/renderer/dialogs/SbxSettingsFields.tsx) and the control channel's `sbx-set-*` verbs.
 */

import type { SbxKnowledgeConfig, SbxKnowledgeKind, SbxProjectConfig } from "./types";

/** Every kind of knowledge, in the Knowledge tab's order. */
export const SBX_KNOWLEDGE_KINDS: SbxKnowledgeKind[] = ["skills", "plugins", "instructions"];

/** What `sbx ports --publish` and `sbx run -p` take: a whole number from 1 to 65535. */
export function isPort(value: string): boolean {
  const trimmed = value.trim();
  return /^\d{1,5}$/.test(trimmed) && Number(trimmed) >= 1 && Number(trimmed) <= 65535;
}

/** A scheme or port, which `sbx secret set-custom` rejects (measured), or a leading "-", which sbx
 *  would read as an option of its own. */
export function isBadHost(host: string): boolean {
  return /^-|[/:]/.test(host);
}

/**
 * Whether going from `loaded` and `loadedKnowledge` to `config` and `knowledge` reaches a running
 * tab only once it restarts: a mount is added at a tab's start (a removed one goes at Save), and
 * `sbx run -e` sets a variable, a new secret's placeholder included, only there (sbx.ts's
 * prepareSbxRun). Ports, hosts and a secret's value or hosts apply at Save.
 */
export function sbxNeedsRestart(
  loaded: SbxProjectConfig,
  loadedKnowledge: SbxKnowledgeConfig,
  config: Omit<SbxProjectConfig, "enabled">,
  knowledge: SbxKnowledgeConfig
): boolean {
  const names = (variables: SbxProjectConfig["variables"]): string => JSON.stringify(variables.map((variable) => variable.env).sort());
  return (
    SBX_KNOWLEDGE_KINDS.some((kind) => knowledge[kind] !== false && knowledge[kind] !== loadedKnowledge[kind]) ||
    (knowledge.skills !== false && knowledge.skillsFolder !== loadedKnowledge.skillsFolder) ||
    config.paths.some((entry) => !loaded.paths.some((old) => old.path === entry.path && old.access === entry.access)) ||
    config.secrets.some((secret) => !loaded.secrets.some((old) => old.env === secret.env)) ||
    names(config.variables) !== names(loaded.variables)
  );
}
