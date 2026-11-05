import { CircleAlertIcon } from "./icons";

export interface SwitchTab<T extends string> {
  id: T;
  label: string;
  /** Given, the tab cannot be chosen and says why on hover. */
  disabled?: string;
  /** Given, something on the tab needs a look: an error mark beside the label, saying what. */
  mark?: string;
}

/**
 * The tabs that switch what a view shows (`.switch-tab`), drawn as the tab strip's: the caller's
 * header or bar holds them, since they carry no background of their own beside the active one's.
 * `locked` holds them all, as a disabled one is.
 */
export function SwitchTabs<T extends string>({
  tabs,
  active,
  onSelect,
  locked,
}: {
  tabs: readonly SwitchTab<T>[];
  active: T;
  onSelect: (id: T) => void;
  locked?: boolean;
}) {
  return tabs.map((entry) => (
    <button
      key={entry.id}
      type="button"
      // The context menu's disabled entry, not the attribute: chromium swallows a disabled
      // control's tooltip, and the reason is the point.
      className={`switch-tab${active === entry.id ? " active" : ""}${entry.disabled || locked ? " disabled" : ""}`}
      title={entry.disabled ?? entry.mark}
      onClick={() => {
        if (!entry.disabled && !locked) {
          onSelect(entry.id);
        }
      }}
    >
      {entry.label}
      {entry.mark && (
        <span className="switch-tab-mark">
          <CircleAlertIcon />
        </span>
      )}
    </button>
  ));
}
