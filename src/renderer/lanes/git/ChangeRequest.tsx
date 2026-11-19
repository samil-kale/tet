import type { NoticeLink } from "../../../shared/types/app";
import { headRemote, headRemoteBranch, type RepositoryState } from "../../../shared/types/git";
import type { ProjectRef } from "../../../shared/types/project";
import type { ChangeRequest, ChangeRequestInput, ChangeRequestKind, ChangeRequestKindResult } from "../../../shared/types/providers";
import { askLogin } from "../../git/GitLogin";
import type { FileAsk } from "../../git/run-action";
import { filled, prompt } from "../../ui/Dialog";
import { Dropdown } from "../../ui/Dropdown";
import { Field, SuggestField, TextField } from "../../ui/Field";
import { notify } from "../../ui/Notices";

/** "Pull request" for a title. */
function capitalized(noun: string): string {
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

/** One by its number as its host writes it, for a notice's link. */
function linkOf(kind: ChangeRequestKind, { number, url }: ChangeRequest): NoticeLink {
  return { url, label: `${kind.prefix}${number}` };
}

/** The branches one can go into: those of the remote the checked-out branch is pushed to, but its own. */
function intoBranches(state: RepositoryState): string[] {
  const remote = headRemote(state);
  const head = headRemoteBranch(state);
  return (state.remotes.find((entry) => entry.name === remote)?.branches ?? []).filter((name) => name !== head);
}

/** BRANCHES' button and its dialog, on either host, the button on or off. */
export const CHANGE_REQUEST_TITLE = "Push and create Pull/Merge Request";

/**
 * BRANCHES' button: the kind it opens, and its tooltip — `CHANGE_REQUEST_TITLE`, or why it is
 * off: what the host's side refused (`changeRequestKind`), a remote with no branch to open one
 * into, or a branch the default branch already holds whole (`mergedBranches`, read anyway), which
 * has nothing to merge. Off without a word while the kind is read (`result` undefined).
 */
export function changeRequestAction(
  state: RepositoryState,
  result: ChangeRequestKindResult | undefined,
): { title: string; kind?: ChangeRequestKind } {
  if (result === undefined) {
    return { title: CHANGE_REQUEST_TITLE };
  }
  if ("refusal" in result) {
    return { title: result.refusal };
  }
  if (intoBranches(state).length === 0) {
    return { title: `The remote has no other branch to open a ${result.kind.noun} into` };
  }
  if (state.defaultBranch && state.mergedBranches.includes(state.head)) {
    return { title: `No new commits on ${state.head} to merge into ${state.defaultBranch.name}` };
  }
  return { title: CHANGE_REQUEST_TITLE, kind: result.kind };
}

/** The suggestion's first line is the title, the rest the description (`CHANGE_REQUEST_PROMPT`). */
function splitSuggestion(text: string): { title: string; description: string } {
  const [title, ...rest] = text.split("\n");
  return { title: title.trim(), description: rest.join("\n").trim() };
}

/**
 * BRANCHES' pull or merge request (`kind`, the host's word for one): from the checked-out
 * branch into a branch of the remote it is pushed to, its title and description typed or suggested.
 * The branch is pushed first where the remote lacks what it has; what refuses either stands in the
 * dialog, but a push wanting a login, which is asked once the dialog is gone (one question at a
 * time), and the dialog comes back with what was typed (`typed`).
 */
export async function askChangeRequest(
  ref: ProjectRef,
  state: RepositoryState,
  kind: ChangeRequestKind,
  ask: FileAsk,
  typed?: ChangeRequestInput,
  pushed = false,
): Promise<void> {
  const noun = capitalized(kind.noun);
  // Told before the question: a text typed for one that is open already is typed for nothing.
  const found = await window.tet.repository.findChangeRequest(ref);
  if (!found.ok) {
    notify("error", found.error);
    return;
  }
  if (found.open) {
    const link = linkOf(kind, found.open);
    notify("info", `${noun} ${link.label} is open already.`, { link });
    return;
  }
  const branches = intoBranches(state);
  // The button is off then (`changeRequestAction`).
  if (branches.length === 0) {
    return;
  }
  const base = state.worktrees.find((worktree) => worktree.current)?.base ?? state.defaultBranch?.name;
  const into = typed?.into ?? (base !== undefined && branches.includes(base) ? base : branches[0]);
  // Where the remote lacks what the branch has, or has no branch of it yet.
  const push = !pushed && (state.upstream === undefined || state.ahead > 0);
  const canSuggest = (await window.tet.agents.askable()).length > 0;
  /** What Create ran into or opened, held for once the dialog is gone. */
  const outcome: { login?: { url: string; error: string; input: ChangeRequestInput }; created?: ChangeRequest & ChangeRequestInput } = {};
  const create = async (input: ChangeRequestInput) => {
    if (push) {
      const result = await window.tet.repository.push(ref);
      if (!result.ok) {
        if (result.loginUrl === undefined) {
          return result;
        }
        outcome.login = { url: result.loginUrl, error: result.error, input };
        return { ok: true as const };
      }
    }
    const created = await window.tet.repository.createChangeRequest(ref, input);
    if (created.ok) {
      outcome.created = { ...input, number: created.number, url: created.url };
    }
    return created;
  };
  await prompt<ChangeRequestInput>({
    title: CHANGE_REQUEST_TITLE,
    value: typed ?? { into, title: "", description: "" },
    confirmLabel: "Create",
    ready: (value) => filled(value.title),
    render: ({ value, onChange, error, busy, field, hold }) => (
      <>
        <Field label="Into">
          <Dropdown
            value={value.into}
            options={branches.map((name) => ({ value: name, label: name }))}
            disabled={busy}
            onChange={(next) => onChange((current) => ({ ...current, into: next }))}
          />
        </Field>
        <TextField
          label="Title"
          value={value.title}
          onChange={(title) => onChange((current) => ({ ...current, title }))}
          disabled={busy}
          ref={field}
          error={error}
        />
        <SuggestField
          label="Description"
          value={value.description}
          onChange={(description) => onChange((current) => ({ ...current, description }))}
          suggestion={
            canSuggest
              ? {
                  label: "Suggest title and description",
                  run: async () => {
                    const result = await window.tet.repository.suggestChangeRequest(ref, value.into);
                    if (result.value === undefined) {
                      return result;
                    }
                    const { title, description } = splitSuggestion(result.value);
                    onChange((current) => ({ ...current, title }));
                    return { value: description };
                  },
                }
              : undefined
          }
          disabled={busy}
          multiline
          sizeKey="change-request-height"
          onSuggesting={hold}
        />
      </>
    ),
    className: "change-request-dialog",
    abort: window.tet.repository.cancelSuggestion,
    submit: (value) => ask(() => create({ ...value, title: value.title.trim(), description: value.description.trim() })),
  });
  const { login, created } = outcome;
  if (login) {
    let loggedIn = false;
    await askLogin(login.url, login.error, async (typedLogin) => {
      const refused = await ask(() => window.tet.repository.push(ref, typedLogin));
      loggedIn = refused === undefined;
      return refused;
    });
    if (loggedIn) {
      await askChangeRequest(ref, state, kind, ask, login.input, true);
    }
    return;
  }
  if (created) {
    const link = linkOf(kind, created);
    notify("info", `Created ${kind.noun} ${link.label} into ${created.into}.`, { link });
  }
}
