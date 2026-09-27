import { useRef, type RefObject } from "react";

/**
 * A ref holding what this render was handed, for a callback or listener made once to read later —
 * on a click, a key, an await's end — without being remade whenever the value changes.
 */
export function useLatest<T>(value: T): RefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
