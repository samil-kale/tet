/**
 * Said in a dialog's button row (`DialogFrame`'s `message`) while its unsaved edits reach a running
 * tab only once it is restarted (the tab menu's Restart).
 */
export function RestartNote() {
  return <span className="restart-note">Restart running tabs for these changes to take effect.</span>;
}
