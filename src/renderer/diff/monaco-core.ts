/**
 * Monaco's own `editor.main` pulls in ~80 Monarch language definitions plus full CSS/HTML/JSON/
 * TypeScript language *services* (each wanting a worker of its own) — exactly what colouring
 * through shiki (`editor.ts`) is meant to replace. 0.56.0 ships no narrower entry point (an
 * `edcore.main` some older versions had is gone), so this file reproduces `editor.main.js`'s own
 * import list minus its language-definition and language-feature-service blocks: every editor
 * contribution (find, folding, bracket matching, context menu, coreCommands, ...), none of the
 * languages. Re-diff against `node_modules/monaco-editor/editor/editor.main.js` on a
 * monaco upgrade — this list is not a public API and can be renamed or reshuffled under it.
 *
 * Also left out, on top of that: every contribution whose only job is talking to a language
 * provider (code actions, code lens, colour swatches, document symbols, drop/paste transforms,
 * format, marker navigation, hover, inlay hints, inline completions, linked editing, parameter
 * hints, references, rename, semantic tokens, suggestions, go-to-definition) — this editor
 * registers no such providers (shiki colours tokens, nothing resolves symbols or diagnostics), so
 * each of those loaded for nothing at all. And a handful that plainly don't apply here: a dev-only
 * token inspector, iPad's on-screen-keyboard contribution, the experimental GPU renderer, a
 * high-contrast theme toggle (the theme is ours, from `editor.ts`), X11's middle-mouse-paste
 * scroll, and sticky scroll (already off via `editorOptions`, so loading it bought nothing).
 */
import "monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/caretOperations/browser/transpose.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js";
// monaco-editor's package.json "exports" maps every "./*" to "./esm/vs/*.js" — appending .js to
// even a .css request, which then 404s. A relative path reaches the file on disk directly,
// bypassing that map (this is what "exports" restricts: bare-specifier resolution, not a
// relative one) — the only reason these two imports look unlike the rest of monaco-core.ts.
import "../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js";
import "monaco-editor/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js";
import "monaco-editor/editor/contrib/dnd/browser/dnd.js";
import "monaco-editor/features/find/register.js";
import "monaco-editor/editor/contrib/floatingMenu/browser/floatingMenu.contribution.js";
import "monaco-editor/editor/contrib/folding/browser/folding.js";
import "monaco-editor/editor/contrib/fontZoom/browser/fontZoom.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoLineQuickAccess.js";
import "monaco-editor/editor/contrib/indentation/browser/indentation.js";
import "monaco-editor/editor/contrib/inPlaceReplace/browser/inPlaceReplace.js";
import "monaco-editor/editor/contrib/insertFinalNewLine/browser/insertFinalNewLine.js";
import "monaco-editor/editor/contrib/lineSelection/browser/lineSelection.js";
import "monaco-editor/editor/contrib/linesOperations/browser/linesOperations.js";
import "monaco-editor/editor/contrib/links/browser/links.js";
import "monaco-editor/editor/contrib/longLinesHelper/browser/longLinesHelper.js";
import "monaco-editor/editor/contrib/multicursor/browser/multicursor.js";
import "monaco-editor/editor/contrib/placeholderText/browser/placeholderText.contribution.js";
// standaloneCommandsQuickAccess.js (F1's full command palette) deliberately left out: this is a
// quick look-and-fix editor, not an IDE, and that surface is dozens of internal editor commands
// nobody asked for here.
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneHelpQuickAccess.js";
import "monaco-editor/editor/standalone/browser/quickAccess/standaloneGotoSymbolQuickAccess.js";
import "monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js";
import "monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders.js";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js";
import "monaco-editor/editor/contrib/snippet/browser/snippetController2.js";
import "monaco-editor/editor/contrib/toggleTabFocusMode/browser/toggleTabFocusMode.js";
import "monaco-editor/editor/contrib/tokenization/browser/tokenization.js";
import "monaco-editor/editor/contrib/unicodeHighlighter/browser/unicodeHighlighter.js";
import "monaco-editor/editor/contrib/unusualLineTerminators/browser/unusualLineTerminators.js";
import "monaco-editor/editor/contrib/wordHighlighter/browser/wordHighlighter.js";
import "monaco-editor/editor/contrib/wordOperations/browser/wordOperations.js";
import "monaco-editor/editor/contrib/wordPartOperations/browser/wordPartOperations.js";
import "monaco-editor/editor/browser/coreCommands.js";
import "monaco-editor/editor/contrib/caretOperations/browser/caretOperations.js";
import "monaco-editor/editor/contrib/find/browser/findController.js";
import "monaco-editor/editor/common/standaloneStrings.js";
import "../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon-modifiers.css";

export * from "monaco-editor/editor/editor.api.js";
