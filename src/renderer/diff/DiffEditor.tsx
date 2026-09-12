import { useEffect, useImperativeHandle, useRef } from "react";
import type { editor as MonacoEditor } from "monaco-editor";
import { languageForPath } from "./diff-highlight";
import { diffEditorOptions, editorOptions, ensureLanguage, loadMonaco } from "./editor";
import { parseKeyCombo, resolveKeybindings } from "./keybindings";

export interface DiffEditorHandle {
  /** The file's current text, BOM preserved — see `Repository.writeFile`. */
  getValue(): string;
  /** Marks the current text as the saved baseline: dirty goes false until it changes again. */
  markSaved(): void;
  /** Replaces the file's text in place (kept on the undo stack) and marks it saved. */
  setContent(text: string): void;
  /** Replaces what the diff compares against, after a commit or a checkout moved HEAD under the
   *  open file. No undo entry: nobody edits that side. */
  setOriginal(text: string): void;
}

interface DiffEditorProps {
  path: string;
  /** The working tree's text, and the side that is edited. */
  content: string;
  /** What HEAD has of the file. The same text as `content` where git reports no change, which
   *  leaves nothing marked and reads as a plain editor. */
  original: string;
  readOnly: boolean;
  onDirty: (dirty: boolean) => void;
  onSave: () => void;
  onBusy: (busy: boolean) => void;
  ref?: React.Ref<DiffEditorHandle>;
}

/**
 * The dialog's one view of a file: monaco's diff editor with its right-hand side editable, so that
 * reading the changes and making them are the same widget. One editor and two models for this
 * component's whole lifetime — `DiffDialog` mounts it only with the right file's texts in hand and
 * unmounts it when another file is chosen, so every prop but the callbacks is read once, at mount.
 */
export function DiffEditor({
  path,
  content,
  original,
  readOnly,
  onDirty,
  onSave,
  onBusy,
  ref
}: DiffEditorProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const editorRef = useRef<MonacoEditor.IStandaloneDiffEditor | null>(null);
  const savedVersionId = useRef(0);
  const onDirtyRef = useRef(onDirty);
  onDirtyRef.current = onDirty;
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  useImperativeHandle(ref, () => ({
    getValue: () => editorRef.current?.getModel()?.modified.getValue(undefined, true) ?? "",
    markSaved: () => {
      const model = editorRef.current?.getModel()?.modified;
      if (model) {
        savedVersionId.current = model.getAlternativeVersionId();
        onDirtyRef.current(false);
      }
    },
    setContent: (text) => {
      const model = editorRef.current?.getModel()?.modified;
      if (!model) {
        return;
      }
      model.pushEditOperations([], [{ range: model.getFullModelRange(), text }], () => null);
      savedVersionId.current = model.getAlternativeVersionId();
      onDirtyRef.current(false);
    },
    setOriginal: (text) => {
      // Asked on every refresh, so the no-op lands here: setting the same text again would throw
      // the computed diff away and have the worker rebuild the identical one.
      const model = editorRef.current?.getModel()?.original;
      if (model && model.getValue() !== text) {
        model.setValue(text);
      }
    }
  }));

  useEffect(() => {
    let cancelled = false;
    onBusy(true);
    void (async () => {
      const monaco = await loadMonaco();
      // Only a grammar diff-highlight.ts bundles gets colors; anything else is "plaintext".
      // Called for plaintext too — the first call defines the theme (see ensureLanguage).
      const language = languageForPath(path);
      await ensureLanguage(monaco, language ?? null);
      // Read before the editor exists: an unmount landing during this await must find nothing
      // to dispose.
      const { editorKeybindingPreset } = await window.tet.settings.get();
      const keybindings = resolveKeybindings(editorKeybindingPreset);
      if (cancelled || !hostRef.current) {
        return;
      }
      // Two models mean two URIs: the model service holds one instance per URI and throws on a
      // second. The edited side keeps the `tet:` scheme every save and find has always used.
      const models = {
        original: monaco.editor.createModel(original, language ?? "plaintext", monaco.Uri.parse(`tet-head:/${path}`)),
        modified: monaco.editor.createModel(content, language ?? "plaintext", monaco.Uri.parse(`tet:/${path}`))
      };
      savedVersionId.current = models.modified.getAlternativeVersionId();
      models.modified.onDidChangeContent(() => {
        onDirtyRef.current(models.modified.getAlternativeVersionId() !== savedVersionId.current);
      });
      const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim();
      const editor = monaco.editor.createDiffEditor(hostRef.current, {
        ...editorOptions(fontFamily),
        ...diffEditorOptions(),
        readOnly
      });
      editorRef.current = editor;
      editor.setModel(models);
      // No keybinding here; it comes from the resolved keybindings below.
      editor.addAction({ id: "tet.save", label: "Save", run: () => onSaveRef.current() });
      // Monaco's find/find-replace actions declare no context menu group; added as one here.
      editor.addAction({
        id: "tet.find",
        label: "Find",
        contextMenuGroupId: "1_find",
        contextMenuOrder: 1,
        run: (instance) => void instance.getAction("actions.find")?.run()
      });
      editor.addAction({
        id: "tet.findReplace",
        label: "Find and Replace",
        contextMenuGroupId: "1_find",
        contextMenuOrder: 2,
        run: (instance) => void instance.getAction("editor.action.startFindReplaceAction")?.run()
      });
      // An unknown combo is skipped at parse time, an unknown command id silently at run time.
      // `addCommand` and `addAction` on a diff editor both reach its modified side, which is where
      // every one of these commands belongs.
      for (const [combo, commandId] of Object.entries(keybindings)) {
        const parsed = parseKeyCombo(monaco, combo);
        if (parsed !== undefined) {
          editor.addCommand(parsed, () => editor.getModifiedEditor().getAction(commandId)?.run());
        }
      }
      editor.getModifiedEditor().focus();
      onBusy(false);
    })();
    return () => {
      cancelled = true;
      const models = editorRef.current?.getModel();
      // The editor first, then both models: disposing the widget leaves the models it was handed
      // standing, and one left behind holds its URI against the next mount of the same file.
      editorRef.current?.dispose();
      models?.original.dispose();
      models?.modified.dispose();
      editorRef.current = null;
      // A load still in flight never reaches its own onBusy(false) once cancelled.
      onBusy(false);
    };
    // Mount-once: `path`, `content` and `original` are this instance's fixed starting point.
  }, []);

  return <div className="editor-host" ref={hostRef} />;
}
