/**
 * `editor.main` pulls in ~80 Monarch languages and four language services with workers; tet colors
 * through shiki (`editor.ts`). 0.56.0 has no narrower entry point, so this is `editor.main.js`'s
 * import list minus the languages and every contribution that only talks to a language provider
 * (hover, suggestions, format, rename, go-to-definition, ...). Not a public API: re-diff against
 * `node_modules/monaco-editor/editor/editor.main.js` on a monaco upgrade.
 */
import "monaco-editor/editor/contrib/anchorSelect/browser/anchorSelect.js";
import "monaco-editor/editor/contrib/bracketMatching/browser/bracketMatching.js";
import "monaco-editor/editor/contrib/caretOperations/browser/transpose.js";
import "monaco-editor/editor/contrib/clipboard/browser/clipboard.js";
import "monaco-editor/editor/browser/widget/codeEditor/codeEditorWidget.js";
// A relative path: monaco-editor's "exports" maps "./*" to "./esm/vs/*.js", appending .js to .css.
import "../../../node_modules/monaco-editor/esm/vs/base/browser/ui/codicons/codicon/codicon.css";
import "monaco-editor/editor/contrib/comment/browser/comment.js";
import "monaco-editor/editor/contrib/contextmenu/browser/contextmenu.js";
import "monaco-editor/editor/contrib/cursorUndo/browser/cursorUndo.js";
import "monaco-editor/editor/browser/widget/diffEditor/diffEditor.contribution.js";
import "monaco-editor/editor/contrib/diffEditorBreadcrumbs/browser/contribution.js";
import "monaco-editor/editor/contrib/dnd/browser/dnd.js";
import "monaco-editor/features/find/register.js";
// floatingMenu.contribution.js left out: nothing in monaco contributes to MenuId.EditorContent.
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
// placeholderText.contribution.js left out: no editor here sets a placeholder.
// standaloneCommandsQuickAccess.js (F1's palette) left out on purpose, and standaloneHelpQuickAccess.js
// with it (it would list only go-to-line); standaloneGotoSymbolQuickAccess.js needs a language service.
import "monaco-editor/editor/contrib/readOnlyMessage/browser/contribution.js";
import "monaco-editor/editor/contrib/sectionHeaders/browser/sectionHeaders.js";
import "monaco-editor/editor/contrib/smartSelect/browser/smartSelect.js";
// snippetController2.js left out: snippets arrive only through suggestions, which are off.
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
