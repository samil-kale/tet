import { Fragment, type ReactNode } from "react";

/**
 * A sentence with the names in it — a branch, a remote, a path — set apart from the words around
 * them, for any menu entry's label and a question's message, detail, checkbox and field label: a
 * template whose every `${}` is a name, or several of them, listed with commas.
 */
export function named(words: TemplateStringsArray, ...names: (string | string[])[]): ReactNode {
  return words.map((part, index) => (
    <Fragment key={index}>
      {part}
      {[names[index] ?? []].flat().map((name, at) => (
        <Fragment key={at}>
          {at > 0 && ", "}
          <span className="inline-name">{name}</span>
        </Fragment>
      ))}
    </Fragment>
  ));
}
