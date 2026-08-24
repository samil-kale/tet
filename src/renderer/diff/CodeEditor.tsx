import { useEffect, useImperativeHandle, useRef } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { languageForPath } from "./diff-highlight";
import { editorOptions, ensureLanguage, loadMonaco } from "./editor";
import { parseKeyCombo, resolveKeybindings } from "./keybindings";

export interface CodeEditorHandle {
  /** The model's current text, BOM preserved — see `Repository.writeFile`. */
  getValue(): string;
  /** Marks the current text as the saved baseline: dirty goes false until it changes again. */
  markSaved(): void;
  /** Replaces the model's text in place (kept on the undo stack) and marks it saved. */
  setContent(text: string): void;
}

interface CodeEditorProps {
  path: string;
  content: string;
  onDirty: (dirty: boolean) => void;
  onSave: () => void;
  onBusy: (busy: boolean) => void;
  ref?: React.Ref<CodeEditorHandle>;
}

/**
 * The dialog's Edit mode: one editor and one model for this component's whole lifetime.
 * `DiffDialog` only ever mounts it once it already has the right file's content in hand (its own
 * `file.path === path` guard) and unmounts it the moment another file is chosen, so `path` and
 * `content` are read once, at mount, and nothing here ever needs to swap a model under the user —
 * a look-and-fix dialog, not a multi-file editing session (see CLAUDE.md).
 */
export function CodeEditor({ path, content, onDirty, onSave, onBusy, ref }: CodeEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const savedVersionId = useRef(0);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useImperativeHandle(ref, () => ({
    getValue: () => editorRef.current?.getModel()?.getValue(undefined, true) ?? "",
    markSaved: () => {
      const model = editorRef.current?.getModel();
      if (model) {
        savedVersionId.current = model.getAlternativeVersionId();
        onDirtyRef.current(false);
      }
    },
    setContent: (text) => {
      const model = editorRef.current?.getModel();
      if (!model) {
        return;
      }
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      savedVersionId.current = model.getAlternativeVersionId();
      onDirtyRef.current(false);
    }
  }));

  useEffect(() => {
    let cancelled = false;
    onBusy(true);
    void (async () => {
      const monaco = await loadMonaco();
      // Only a grammar diff-highlight.ts bundles gets shiki's colors — same rule the diff view
      // itself follows; anything else reads as monaco's built-in, uncolored "plaintext". Called
      // for plaintext too: the first call is also what defines the theme — see ensureLanguage.
      const language = languageForPath(path);
      await ensureLanguage(monaco, language ?? null);
      // The settings dialog's chosen preset, layered over tet's defaults for the commands added
      // below — free to name any of monaco's own command ids too (see keybindings.ts). Read
      // before the editor exists: an unmount landing during this read must find nothing to
      // dispose, not an editor the loop below would then reach for through a nulled ref.
      const { editorKeybindingPreset } = await window.tet.settings.get();
      const keybindings = resolveKeybindings(editorKeybindingPreset);
      if (cancelled || !hostRef.current) {
        return;
      }
      const model = monaco.editor.createModel(content, language ?? "plaintext", monaco.Uri.parse(`tet:/${path}`));
      savedVersionId.current = model.getAlternativeVersionId();
      model.onDidChangeContent(() => {
        onDirtyRef.current(model.getAlternativeVersionId() !== savedVersionId.current);
      });
      const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim();
      editorRef.current = monaco.editor.create(hostRef.current, { ...editorOptions(fontFamily), model });
      // No keybinding here — every command tet adds gets one the same way, below, from the
      // resolved keybindings ("ctrl+s" among tet's own defaults in there).
      editorRef.current.addAction({ id: "tet.save", label: "Save", run: () => onSaveRef.current() });
      // Monaco's find/find-replace actions (Ctrl+F/Ctrl+H, both already bound by default) don't
      // declare a context menu group of their own — VS Code's own right-click menu doesn't carry
      // them either. Added here as their own group so they're reachable without the shortcuts.
      editorRef.current.addAction({
        id: "tet.find",
        label: "Find",
        contextMenuGroupId: "1_find",
        contextMenuOrder: 1,
        run: (instance) => void instance.getAction("actions.find")?.run()
      });
      editorRef.current.addAction({
        id: "tet.findReplace",
        label: "Find and Replace",
        contextMenuGroupId: "1_find",
        contextMenuOrder: 2,
        run: (instance) => void instance.getAction("editor.action.startFindReplaceAction")?.run()
      });
      // An entry whose key or command this editor doesn't recognise is skipped rather than
      // guessed at — the combo at parse time, an unknown command id silently at run time.
      for (const [combo, commandId] of Object.entries(keybindings)) {
        const parsed = parseKeyCombo(monaco, combo);
        if (parsed !== undefined) {
          editorRef.current.addCommand(parsed, () => editorRef.current?.getAction(commandId)?.run());
        }
      }
      editorRef.current.focus();
      onBusy(false);
    })();
    return () => {
      cancelled = true;
      const model = editorRef.current?.getModel();
      editorRef.current?.dispose();
      model?.dispose();
      editorRef.current = null;
      // The load above may still be in flight, and its own onBusy(false) never runs once
      // cancelled — without this the dialog's bar would keep running for an editor that no
      // longer exists (toggled back to Diff mid-load). Same hand-back DiffView's cleanup does.
      onBusy(false);
    };
    // Mount-once, deliberately: `path` and `content` are this instance's fixed starting point,
    // never a later value to re-sync to — see the doc comment above for why that always holds.
  }, []);

  return <div className="editor-host" ref={hostRef} />;
}
