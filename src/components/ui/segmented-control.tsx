"use client";

type SegmentedTwoProps<T extends string> = {
  value: T;
  onChange: (id: T) => void;
  left: { id: T; label: string };
  right: { id: T; label: string };
  className?: string;
};

type SegmentedThreeOption<T extends string> = {
  id: T;
  label: string;
  count?: number;
};

type SegmentedThreeProps<T extends string> = {
  value: T;
  onChange: (id: T) => void;
  first: SegmentedThreeOption<T>;
  second: SegmentedThreeOption<T>;
  third: SegmentedThreeOption<T>;
  className?: string;
  disabled?: boolean;
};

const activeSegment =
  "bg-[var(--btn-primary)] text-white shadow-[0_2px_10px_-2px_rgba(47,95,208,0.45)]";
const inactiveSegment = "text-muted hover:bg-card/60 hover:text-foreground";

export function SegmentedThree<T extends string>({
  value,
  onChange,
  first,
  second,
  third,
  className = "",
  disabled = false,
}: SegmentedThreeProps<T>) {
  const opts = [first, second, third];
  return (
    <div
      className={`grid grid-cols-3 gap-1 rounded-2xl border border-border bg-card/40 p-1 shadow-sm ${className}`}
    >
      {opts.map((opt) => {
        const active = value === opt.id;
        return (
          <button
            key={opt.id}
            type="button"
            disabled={disabled}
            onClick={() => onChange(opt.id)}
            className={`rounded-xl py-2.5 text-sm font-semibold transition-colors duration-150 ease-out disabled:cursor-not-allowed disabled:opacity-60 ${
              active ? activeSegment : inactiveSegment
            }`}
            style={active ? { background: "var(--btn-primary)" } : undefined}
          >
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

export function SegmentedTwo<T extends string>({ value, onChange, left, right, className = "" }: SegmentedTwoProps<T>) {
  const isRight = value === right.id;

  return (
    <div className={`relative flex w-full gap-1 rounded-2xl border border-border bg-card/40 p-1 shadow-sm backdrop-blur-sm ${className}`}>
      <span
        aria-hidden
        className="segmented-pill absolute bottom-1 left-1 top-1 w-[calc(50%-6px)] rounded-xl shadow-[0_4px_14px_-4px_rgba(47,95,208,0.45)] transition-transform duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] will-change-transform"
        style={{
          transform: isRight ? "translateX(calc(100% + 0.25rem))" : "translateX(0)",
          background: "var(--btn-primary)",
        }}
      />
      <button
        type="button"
        onClick={() => onChange(left.id)}
        className={`relative z-10 flex-1 rounded-xl py-2.5 text-sm font-semibold transition-colors duration-300 ${
          value === left.id ? "text-white" : inactiveSegment
        }`}
      >
        {left.label}
      </button>
      <button
        type="button"
        onClick={() => onChange(right.id)}
        className={`relative z-10 flex-1 rounded-xl py-2.5 text-sm font-semibold transition-colors duration-300 ${
          value === right.id ? "text-white" : inactiveSegment
        }`}
      >
        {right.label}
      </button>
    </div>
  );
}
