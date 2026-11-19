import { useCallback, useState } from "react";
import type { NoticeLink } from "../../../shared/types/app";
import type { RepositoryState } from "../../../shared/types/git";
import type { ProjectRef } from "../../../shared/types/project";
import type {
  ChangeRequest,
  ChangeRequestInput,
  ChangeRequestKind,
  ChangeRequestTarget,
  ChangeRequestTargetResult,
} from "../../../shared/types/providers";
import { askLogin } from "../../git/GitLogin";
import type { FileAsk } from "../../git/run-action";
import { filled, prompt, type PromptFields } from "../../ui/Dialog";
import { SuggestField, TextField } from "../../ui/Field";
import { named } from "../../ui/named";
import { notify } from "../../ui/Notices";

/** "Pull request" for a title. */
function capitalized(noun: string): string {
  return noun.charAt(0).toUpperCase() + noun.slice(1);
}

/** The button's and the dialog's title, in the host's word: "Push and create Pull-Request". Until
 *  the host is known, or where it is none, it says "Change Request" (the code's word for either). */
export function changeRequestTitle(kind: ChangeRequestKind | undefined): string {
  return `Push and create ${kind ? capitalized(kind.noun).replace(" ", "-") : "Change Request"}`;
}

/** One by its number as its host writes it, for a notice's link. */
function linkOf(kind: ChangeRequestKind, { number, url }: ChangeRequest): NoticeLink {
  return { url, label: `${kind.prefix}${number}` };
}

/** BRANCHES' button: where it opens one, and its tooltip — `changeRequestTitle`, or why it is off
 *  (`changeRequestTarget`'s refusal). Off without a word while the target is read (`result`
 *  undefined). */
export function changeRequestAction(result: ChangeRequestTargetResult | undefined): { title: string; target?: ChangeRequestTarget } {
  if (result === undefined) {
    return { title: changeRequestTitle(undefined) };
  }
  if ("refusal" in result) {
    return { title: result.refusal };
  }
  return { title: changeRequestTitle(result.kind), target: result };
}

/** The suggestion's first line is the title, the rest the description (`CHANGE_REQUEST_PROMPT`). */
function splitSuggestion(text: string): { title: string; description: string } {
  const [title, ...rest] = text.split("\n");
  return { title: title.trim(), description: rest.join("\n").trim() };
}

/** The dialog's title and description. A suggestion writes both, so the title is held like the
 *  description while one is fetched. */
function ChangeRequestFields({
  at,
  canSuggest,
  value,
  onChange,
  error,
  busy,
  field,
  hold,
}: PromptFields<ChangeRequestInput> & { at: ProjectRef; canSuggest: boolean }) {
  const [suggesting, setSuggesting] = useState(false);
  const onSuggesting = useCallback(
    (held: boolean) => {
      setSuggesting(held);
      hold(held);
    },
    [hold],
  );
  return (
    <>
      <TextField
        label="Title"
        value={value.title}
        onChange={(title) => onChange((current) => ({ ...current, title }))}
        disabled={busy || suggesting}
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
                  const result = await window.tet.repository.suggestChangeRequest(at);
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
        onSuggesting={onSuggesting}
      />
    </>
  );
}

/**
 * BRANCHES' pull or merge request: from the checked-out branch into the branch its `target`
 * names, said in the dialog, its title and description typed or suggested. The branch is pushed
 * first where the remote lacks what it has; what refuses either stands in the dialog, but a push
 * wanting a login, which is asked once the dialog is gone (one question at a time), and the dialog
 * comes back with what was typed (`typed`).
 */
export async function askChangeRequest(
  ref: ProjectRef,
  state: RepositoryState,
  target: ChangeRequestTarget,
  ask: FileAsk,
  typed?: ChangeRequestInput,
  pushed = false,
): Promise<void> {
  const { kind, into } = target;
  // Told before the question: a text typed for one that is open already is typed for nothing.
  const found = await window.tet.repository.findChangeRequest(ref);
  if (!found.ok) {
    notify("error", found.error);
    return;
  }
  if (found.open) {
    const link = linkOf(kind, found.open);
    notify("info", `${capitalized(kind.noun)} ${link.label} is open already.`, { link });
    return;
  }
  // Where the remote lacks what the branch has, or has no branch of it yet.
  const push = !pushed && (state.upstream === undefined || state.ahead > 0);
  const canSuggest = (await window.tet.agents.askable()).length > 0;
  /** What Create ran into or opened, held for once the dialog is gone. */
  const outcome: { login?: { url: string; error: string; input: ChangeRequestInput }; created?: ChangeRequest } = {};
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
      outcome.created = created;
    }
    return created;
  };
  await prompt<ChangeRequestInput>({
    title: changeRequestTitle(kind),
    // The host's word is no name: only the branches are set apart.
    detail: (
      <>
        {capitalized(kind.noun)} {named`from ${state.head} into ${into}`}
      </>
    ),
    value: typed ?? { title: "", description: "" },
    confirmLabel: "Create",
    ready: (value) => filled(value.title),
    render: (fields) => <ChangeRequestFields at={ref} canSuggest={canSuggest} {...fields} />,
    className: "change-request-dialog",
    abort: window.tet.repository.cancelSuggestion,
    submit: (value) => ask(() => create({ title: value.title.trim(), description: value.description.trim() })),
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
      await askChangeRequest(ref, state, target, ask, login.input, true);
    }
    return;
  }
  if (created) {
    const link = linkOf(kind, created);
    notify("info", `Created ${kind.noun} ${link.label} into ${into}.`, { link });
  }
}
