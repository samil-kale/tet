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
 * `DiffDialog` mounts it only with the right file's content in hand and unmounts it when another
 * file is chosen, so `path` and `content` are read once, at mount.
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
      const model = monaco.editor.createModel(content, language ?? "plaintext", monaco.Uri.parse(`tet:/${path}`));
      savedVersionId.current = model.getAlternativeVersionId();
      model.onDidChangeContent(() => {
        onDirtyRef.current(model.getAlternativeVersionId() !== savedVersionId.current);
      });
      const fontFamily = getComputedStyle(document.documentElement).getPropertyValue("--vscode-editor-font-family").trim();
      editorRef.current = monaco.editor.create(hostRef.current, { ...editorOptions(fontFamily), model });
      // No keybinding here; it comes from the resolved keybindings below.
      editorRef.current.addAction({ id: "tet.save", label: "Save", run: () => onSaveRef.current() });
      // Monaco's find/find-replace actions declare no context menu group; added as one here.
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
      // An unknown combo is skipped at parse time, an unknown command id silently at run time.
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
      // A load still in flight never reaches its own onBusy(false) once cancelled.
      onBusy(false);
    };
    // Mount-once: `path` and `content` are this instance's fixed starting point.
  }, []);

  return <div className="editor-host" ref={hostRef} />;
}
