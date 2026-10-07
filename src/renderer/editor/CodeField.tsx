import { useEffect, useState, useSyncExternalStore } from "react";
import Editor from "react-simple-code-editor";
import type { HighlighterCore } from "shiki/core";
import { highlighter, highlightTheme, loadGrammar, subscribeHighlightTheme } from "./diff-highlight";

interface CodeFieldProps {
  /** A `GRAMMARS` entry of diff-highlight.ts. */
  language: string;
  value: string;
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
}

/**
 * A text field colored by shiki: a real `<textarea>` over the colored text, so a dialog's focus,
 * Enter and disabling (`DialogFrame`) treat it as any field. Tab moves the focus, as in any field.
 * Uncolored until the grammar has loaded.
 */
export function CodeField({ language, value, onChange, placeholder, className }: CodeFieldProps) {
  const [shiki, setShiki] = useState<HighlighterCore | null>(null);
  const theme = useSyncExternalStore(subscribeHighlightTheme, highlightTheme);
  useEffect(() => {
    let current = true;
    void highlighter().then(async (loaded) => {
      await loadGrammar(loaded, language);
      if (current) {
        setShiki(loaded);
      }
    });
    return () => {
      current = false;
    };
  }, [language]);
  return (
    <div className={className ? `code-field ${className}` : "code-field"}>
      <Editor
        className="code-field-editor"
        value={value}
        onValueChange={onChange}
        // Spans alone: the field's surface is the dialog's, not the theme's editor background.
        highlight={(code) =>
          shiki ? (
            shiki.codeToHtml(code, { lang: language, theme, structure: "inline" })
          ) : (
            <>
              {code}
              <br />
            </>
          )
        }
        placeholder={placeholder}
        ignoreTabKey
        padding="5px 6px"
      />
    </div>
  );
}
