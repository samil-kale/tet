interface RadioOption<T extends string> {
  value: T;
  label: string;
}

interface RadioGroupProps<T extends string> {
  value: T;
  options: RadioOption<T>[];
  onChange: (value: T) => void;
}

/**
 * VS Code's radio widget (base/browser/ui/radio): a row of joined buttons, the chosen one marked.
 * The borders between them are drawn once — by the chosen one, or else by the right-hand one.
 */
export function RadioGroup<T extends string>({ value, options, onChange }: RadioGroupProps<T>) {
  const activeIndex = options.findIndex((option) => option.value === value);
  return (
    <div className="radio-group" role="radiogroup">
      {options.map((option, index) => {
        const active = index === activeIndex;
        const className = ["radio-option", active && "active", index === activeIndex + 1 && "previous-active"]
          .filter(Boolean)
          .join(" ");
        return (
          <button
            key={option.value}
            type="button"
            role="radio"
            aria-checked={active}
            className={className}
            onClick={() => onChange(option.value)}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}
