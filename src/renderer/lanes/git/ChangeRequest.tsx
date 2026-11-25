import { useCallback, useState } from "react";
import type { RepositoryState } from "../../../shared/types/git";
import type { ProjectRef } from "../../../shared/types/project";
import {
  capitalized,
  changeRequestName,
  type ChangeRequest,
  type ChangeRequestFollowUps,
  type ChangeRequestInput,
  type ChangeRequestKind,
  type ChangeRequestPeople,
  type ChangeRequestTarget,
  type ChangeRequestTargetResult,
} from "../../../shared/types/providers";
import { askLogin } from "../../git/GitLogin";
import type { FileAsk } from "../../git/run-action";
import { filled, prompt, type PromptFields } from "../../ui/Dialog";
import { Dropdown, type DropdownOption } from "../../ui/Dropdown";
import { Checkbox, Field, SuggestField, TextField } from "../../ui/Field";
import { named } from "../../ui/named";
import { notify } from "../../ui/Notices";

/** The button's and the dialog's title, in the host's word: "Push and create Pull-Request". Until
 *  the host is known, or where it is none, it says "Change Request" (the code's word for either). */
export function changeRequestTitle(kind: ChangeRequestKind | undefined): string {
  return `Push and create ${kind ? capitalized(kind.noun).replace(" ", "-") : "Change Request"}`;
}

/** Branches' button: where it opens one, and its tooltip — `changeRequestTitle`, or why it is off
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

/** The dialog's checkboxes. */
type ChangeRequestOption = Exclude<keyof ChangeRequestInput, "into" | "title" | "description" | keyof ChangeRequestPeople>;

/** What the Assignee and Reviewer dropdowns offer: nobody, then the host's people by login. */
function personOptions(people: string[]): DropdownOption<string>[] {
  return [{ value: "", label: "Nobody", separatorAfter: true }, ...people.map((login) => ({ value: login, label: login }))];
}

/** `value` with what cannot apply unchecked: a draft is never set to auto-merge, and only one set to
 *  auto-merge is squashed. */
function applicable(value: ChangeRequestInput): ChangeRequestInput {
  const autoMerge = value.autoMerge && !value.draft;
  return { ...value, autoMerge, squash: value.squash && autoMerge };
}

/** The dialog's branch to merge into, labelled with the one it comes from (`head`, the checked-out
 *  one), title and description, whom it goes to, and what follows the opening. A suggestion reads
 *  the branch and writes both texts, so they are held like the description while one is fetched.
 *  Approving and deleting the source branch are offered where the host can. `peopleError` is why the
 *  host's people could not be read, leaving nobody to pick. */
function ChangeRequestFields({
  at,
  head,
  target: { kind, branches },
  canSuggest,
  people,
  peopleError,
  value,
  onChange,
  error,
  busy,
  field,
  hold,
}: PromptFields<ChangeRequestInput> & {
  at: ProjectRef;
  head: string;
  target: ChangeRequestTarget;
  canSuggest: boolean;
  people: string[];
  peopleError?: string;
}) {
  const [suggesting, setSuggesting] = useState(false);
  const onSuggesting = useCallback(
    (held: boolean) => {
      setSuggesting(held);
      hold(held);
    },
    [hold],
  );
  const tick = (option: ChangeRequestOption) => (checked: boolean) => onChange((current) => applicable({ ...current, [option]: checked }));
  const pick = (role: keyof ChangeRequestPeople) => (login: string) =>
    onChange((current) => ({ ...current, [role]: login === "" ? undefined : login }));
  const options = personOptions(people);
  return (
    <>
      {/* The host's word is no name: only the branch is set apart. */}
      <Field
        label={
          <>
            {capitalized(kind.noun)} {named`from ${head} into`}
          </>
        }
      >
        <Dropdown
          value={value.into}
          options={branches.map((name) => ({ value: name, label: name }))}
          onChange={(into) => onChange((current) => ({ ...current, into }))}
          disabled={busy || suggesting}
        />
      </Field>
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
                  const result = await window.tet.repository.suggestChangeRequest(at, value.into);
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
      <div className="change-request-people">
        <Field label="Assignee" error={peopleError}>
          <Dropdown value={value.assignee ?? ""} options={options} onChange={pick("assignee")} disabled={busy} />
        </Field>
        <Field label="Reviewer">
          <Dropdown value={value.reviewer ?? ""} options={options} onChange={pick("reviewer")} disabled={busy} />
        </Field>
      </div>
      <div className="change-request-options">
        <div>
          <Checkbox label="Open as draft" checked={value.draft} onChange={tick("draft")} disabled={busy} />
          <Checkbox label="Set to auto-merge" checked={value.autoMerge} onChange={tick("autoMerge")} disabled={busy || value.draft} />
          <Checkbox label="Squash on auto-merge" checked={value.squash} onChange={tick("squash")} disabled={busy || !value.autoMerge} />
        </div>
        {(kind.selfApproval || kind.deletesSourceBranch) && (
          <div>
            {kind.selfApproval && (
              <Checkbox label="Approve on creation" checked={value.approve} onChange={tick("approve")} disabled={busy} />
            )}
            {kind.deletesSourceBranch && (
              <Checkbox
                label="Delete source branch"
                checked={value.deleteSourceBranch}
                onChange={tick("deleteSourceBranch")}
                disabled={busy}
              />
            )}
          </div>
        )}
      </div>
    </>
  );
}

/**
 * Branches' pull or merge request: from the checked-out branch into a branch its `target` lists,
 * picked in the dialog, its title and description typed or suggested. The branch is pushed
 * first where the remote lacks what it has; what refuses either stands in the dialog, but a push
 * wanting a login, which is asked once the dialog is gone (one question at a time), and the dialog
 * comes back with what was typed (`typed`). Once open, it is assigned and its review asked for as the
 * dropdowns say, which start at the project's last picks, and approved and set to auto-merge as the
 * checkboxes say; what of that failed goes in the notice that it opened, not the dialog, as it stands
 * either way and another Create would open a second one.
 */
export async function askChangeRequest(
  ref: ProjectRef,
  state: RepositoryState,
  target: ChangeRequestTarget,
  ask: FileAsk,
  typed?: ChangeRequestInput,
  pushed = false,
): Promise<void> {
  const { kind } = target;
  // Told before the question: a text typed for one that is open already is typed for nothing. The
  // people are read beside it, so the dialog waits on the slower of the two alone.
  const [found, people] = await Promise.all([window.tet.repository.findChangeRequest(ref), window.tet.repository.changeRequestPeople(ref)]);
  if (!found.ok) {
    notify("error", found.error);
    return;
  }
  if (found.open) {
    const { number } = found.open;
    notify("info", `${capitalized(kind.noun)} ${changeRequestName(kind, number)} is open already.`, {
      opens: { projectId: ref.projectId, tracked: { kind: "change-request", number } },
    });
    return;
  }
  // Where the remote lacks what the branch has, or has no branch of it yet.
  const push = !pushed && (state.upstream === undefined || state.ahead > 0);
  const canSuggest = (await window.tet.agents.askable()).length > 0;
  const { git } = await window.tet.settings.get();
  /** What Create ran into or opened, held for once the dialog is gone. */
  const outcome: {
    login?: { url: string; error: string; input: ChangeRequestInput };
    created?: ChangeRequest & ChangeRequestFollowUps & { into: string };
  } = {};
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
      outcome.created = { ...created, into: input.into };
    }
    return created;
  };
  await prompt<ChangeRequestInput>({
    title: changeRequestTitle(kind),
    value:
      typed ??
      applicable({
        into: target.into,
        title: "",
        description: "",
        ...(people.ok && { assignee: people.assignee, reviewer: people.reviewer }),
        approve: kind.selfApproval && git.approveChangeRequest,
        draft: git.draftChangeRequest,
        autoMerge: git.autoMergeChangeRequest,
        squash: git.squashChangeRequest,
        deleteSourceBranch: kind.deletesSourceBranch && git.deleteSourceBranchChangeRequest,
      }),
    confirmLabel: "Create",
    ready: (value) => filled(value.title),
    render: (fields) => (
      <ChangeRequestFields
        at={ref}
        head={state.head}
        target={target}
        canSuggest={canSuggest}
        people={people.ok ? people.people : []}
        peopleError={people.ok ? undefined : people.error}
        {...fields}
      />
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
      await askChangeRequest(ref, state, target, ask, login.input, true);
    }
    return;
  }
  if (created) {
    const { number } = created;
    // It stands either way, so what did not follow is told beside it.
    const missed = [
      created.assignError === undefined ? undefined : `Could not assign it: ${created.assignError}.`,
      created.reviewError === undefined ? undefined : `Could not ask for a review: ${created.reviewError}.`,
      created.approveError === undefined ? undefined : `Could not approve it: ${created.approveError}.`,
      created.autoMergeError === undefined ? undefined : `Could not set it to auto-merge: ${created.autoMergeError}.`,
    ].filter((sentence) => sentence !== undefined);
    notify(
      missed.length > 0 ? "warning" : "info",
      [`Created ${kind.noun} ${changeRequestName(kind, number)} into ${created.into}.`, ...missed].join(" "),
      { opens: { projectId: ref.projectId, tracked: { kind: "change-request", number } } },
    );
  }
}
