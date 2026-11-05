import type { AddAccountResult, ProviderId } from "../../shared/types/providers";
import { filled } from "../ui/Dialog";
import { FieldGroup, TextField } from "../ui/Field";
import { RadioGroup } from "../ui/RadioGroup";

export const PROVIDER_LABEL: Record<ProviderId, string> = { github: "GitHub", gitlab: "GitLab" };
const DEFAULT_HOST: Record<ProviderId, string> = { github: "github.com", gitlab: "gitlab.com" };
const PROVIDER_OPTIONS = (Object.keys(PROVIDER_LABEL) as ProviderId[]).map((value) => ({
  value,
  label: PROVIDER_LABEL[value],
}));

/** An account as the fields hold it, the token not yet checked by its host. */
export interface AccountDraft {
  provider: ProviderId;
  host: string;
  token: string;
}

export function emptyAccount(): AccountDraft {
  return { provider: "github", host: DEFAULT_HOST.github, token: "" };
}

/** Whether an account can be tried yet. */
export function accountReady(draft: AccountDraft): boolean {
  return filled(draft.host) && filled(draft.token);
}

const accountListeners = new Set<() => void>();

/** An account was added or removed, for what is read through the accounts to read again. */
export function subscribeAccounts(listener: () => void): () => void {
  accountListeners.add(listener);
  return () => accountListeners.delete(listener);
}

export function accountsChanged(): void {
  for (const listener of accountListeners) {
    listener();
  }
}

/** Adds the account the draft names; the host validates the token and answers its login. */
export async function addAccount(draft: AccountDraft): Promise<AddAccountResult> {
  const result = await window.tet.providers.addAccount(draft.provider, draft.host.trim(), draft.token.trim());
  if (result.ok) {
    accountsChanged();
  }
  return result;
}

interface AccountFieldsProps {
  value: AccountDraft;
  onChange: (draft: AccountDraft) => void;
  /** What the host refused, under the token field: that is what it checks ("Bad credentials"). */
  error?: string;
}

/**
 * Provider, host and token of an account; the token is validated on entry and never shown again.
 * Drawn by the add-repository dialog's account form and the Settings' Accounts tab alike.
 */
export function AccountFields({ value, onChange, error }: AccountFieldsProps) {
  /** Replaces the host only while it is empty or a provider default. */
  const pick = (provider: ProviderId): void =>
    onChange({
      ...value,
      provider,
      host: value.host === "" || Object.values(DEFAULT_HOST).includes(value.host) ? DEFAULT_HOST[provider] : value.host,
    });
  return (
    <>
      {/* Which provider a token is for; each validates against its own API. */}
      <FieldGroup label="Provider">
        <RadioGroup value={value.provider} options={PROVIDER_OPTIONS} onChange={pick} />
      </FieldGroup>
      <TextField label="Host" value={value.host} onChange={(host) => onChange({ ...value, host })} />
      <TextField
        label="Personal access token"
        type="password"
        value={value.token}
        onChange={(token) => onChange({ ...value, token })}
        error={error}
      />
    </>
  );
}
