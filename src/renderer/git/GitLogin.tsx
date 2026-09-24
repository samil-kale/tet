import type { RefObject } from "react";
import { urlUsername } from "../../shared/git-url";
import type { GitLogin } from "../../shared/types";
import { filled, prompt, questionUp } from "../ui/Dialog";
import { TextField } from "../ui/Field";
import { notify } from "../ui/Notices";

/** A login as the question starts: the url's username, which the fields then leave out. */
export function emptyLogin(url: string): GitLogin {
  return { username: urlUsername(url), password: "" };
}

/** Whether a login can be tried yet. */
export function loginReady(login: GitLogin): boolean {
  return filled(login.username) && login.password !== "";
}

interface GitLoginFieldsProps {
  /** The remote wanting the login (`GitActionResult.loginUrl`). */
  url: string;
  value: GitLogin;
  onChange: (login: GitLogin) => void;
  /** What git refused, under the password — the field it is usually about. */
  error?: string;
  /** The command is underway: the fields are disabled meanwhile. */
  busy?: boolean;
  /** The first field, for the dialog to focus. */
  field?: RefObject<HTMLInputElement | null>;
}

/**
 * A git host's username and password, as GitHub Desktop asks for them: whatever the host, and
 * checked by nothing but git itself. The username is left out where the url carries one. Drawn
 * by the login question (`askLogin`) and under the add-repository dialog's clone url alike.
 */
export function GitLoginFields({ url, value, onChange, error, busy, field }: GitLoginFieldsProps) {
  const fixedUsername = urlUsername(url) !== "";
  return (
    <>
      {!fixedUsername && (
        <TextField
          label="Username"
          value={value.username}
          onChange={(username) => onChange({ ...value, username })}
          disabled={busy}
          ref={field}
        />
      )}
      <TextField
        label="Password or token"
        type="password"
        value={value.password}
        onChange={(password) => onChange({ ...value, password })}
        disabled={busy}
        ref={fixedUsername ? field : undefined}
        error={error}
      />
      <p className="dialog-detail">Some hosts accept only a personal access token as the password.</p>
    </>
  );
}

/**
 * Asks for the login a command wanted and runs it again with it (`retry`, handing back what
 * refused it): the question stays up until that second try goes through, showing git's words for
 * a login it refused. Cancelled, or not asked since another question is up, the first try's
 * refusal is notified as it would have been — a delete whose remote half wanted the login has
 * gone only here. Resolves once it is done.
 */
export async function askLogin(
  url: string,
  refused: string,
  retry: (login: GitLogin) => Promise<string | undefined>
): Promise<void> {
  if (questionUp()) {
    notify("error", refused);
    return;
  }
  // Escape while the second try runs closes the question too: that try's outcome is then the
  // question's own to tell (a notice for a refusal), not the first try's.
  let tried = false;
  const answered = await prompt({
    title: "Authentication failed",
    detail: `${new URL(url).host} wants a login.`,
    value: emptyLogin(url),
    confirmLabel: "Sign in",
    ready: loginReady,
    render: (fields) => <GitLoginFields url={url} {...fields} />,
    submit: (login) => {
      tried = true;
      return retry({ username: login.username.trim(), password: login.password });
    }
  });
  if (answered === null && !tried) {
    notify("error", refused);
  }
}
