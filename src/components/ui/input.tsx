"use client";

import {
  Children,
  isValidElement,
  useMemo,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
} from "react";
import { ChevronDown } from "lucide-react";
import { FieldSingleSelect } from "@/components/ui/checkbox-multi-select";
import type { CheckboxMultiSelectOption } from "@/components/ui/checkbox-multi-select";
import { partitionFieldSelectClasses } from "@/components/ui/field-select-styles";

const fieldBase =
  "min-h-[44px] w-full rounded-2xl border border-border bg-auth-input-bg px-4 py-2.5 text-[16px] text-foreground outline-none shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-[border-color,background-color,box-shadow] duration-200 placeholder:text-muted/70 hover:border-primary/25 focus:border-primary/40 focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm";

const textareaBase =
  "min-h-[80px] w-full resize-none [field-sizing:content] rounded-2xl border border-border bg-auth-input-bg px-4 py-3 text-[16px] text-foreground outline-none shadow-[0_1px_2px_rgba(15,23,42,0.03)] transition-[border-color,background-color,box-shadow] duration-200 placeholder:text-muted/70 hover:border-primary/25 focus:border-primary/40 focus:ring-4 focus:ring-primary/10 disabled:cursor-not-allowed disabled:opacity-50 sm:text-sm";

function optionsFromSelectChildren(children: ReactNode): CheckboxMultiSelectOption[] {
  const options: CheckboxMultiSelectOption[] = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child) || child.type !== "option") return;
    const props = child.props as { value?: string; children?: ReactNode; disabled?: boolean };
    if (props.disabled) return;
    const label =
      typeof props.children === "string" || typeof props.children === "number"
        ? String(props.children)
        : Children.toArray(props.children).join("");
    options.push({ value: String(props.value ?? ""), label });
  });
  return options;
}

export function Input({ className = "", ...props }: InputHTMLAttributes<HTMLInputElement>) {
  return <input className={`${fieldBase} ${className}`} {...props} />;
}

export function Textarea({ className = "", ...props }: React.TextareaHTMLAttributes<HTMLTextAreaElement>) {
  return <textarea className={`${textareaBase} ${className}`} {...props} />;
}

/** Real `<select>` — OS-native picker. Avoid in portal UI; use {@link Select} instead. */
export function NativeSelect({ className = "", children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) {
  return (
    <div className="relative w-full">
      <select
        className={`${fieldBase} appearance-none pr-10 ${className}`.trim()}
        {...props}
      >
        {children}
      </select>
      <ChevronDown
        className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted"
        aria-hidden
      />
    </div>
  );
}

/** Native-select API backed by the shared portaled field dropdown (opaque white menu + search). */
export function Select({
  className = "",
  children,
  value,
  onChange,
  disabled,
  ...props
}: SelectHTMLAttributes<HTMLSelectElement> & { "data-attr"?: string }) {
  const options = useMemo(() => optionsFromSelectChildren(children), [children]);
  const emptyOption = options.find((o) => o.value === "");
  const placeholder = emptyOption?.label ?? "Select…";
  const ariaLabel = props["aria-label"] ?? props.name ?? placeholder;
  const { wrapperClassName, triggerClassName } = partitionFieldSelectClasses(className);

  return (
    <FieldSingleSelect
      hideLabel
      label={typeof ariaLabel === "string" ? ariaLabel : "Select"}
      wrapperClassName={wrapperClassName}
      triggerClassName={triggerClassName}
      value={String(value ?? "")}
      onChange={(next) => {
        const synthetic = {
          target: { value: next },
          currentTarget: { value: next },
        } as React.ChangeEvent<HTMLSelectElement>;
        onChange?.(synthetic);
      }}
      options={options}
      disabled={disabled}
      placeholder={placeholder}
      dataAttr={props.id ? `select-${props.id}` : props["data-attr"] ? String(props["data-attr"]) : undefined}
    />
  );
}
