"use client";

import type * as React from "react";
import {
  Select,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export type MultipleSelectOption = { value: string; label: string };

export function MultipleSelect({
  options,
  value,
  onChange,
  placeholder = "请选择...",
  disabled,
}: {
  options: MultipleSelectOption[];
  value: string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
}): React.ReactElement {
  const allSelected = value.length >= options.length && options.length > 0;

  return (
    <Select value={value} onValueChange={onChange} multiple disabled={disabled}>
      <SelectTrigger>
        <SelectValue>
          {(selected: string[]) => {
            const labels = selected
              .map((item) => options.find((option) => option.value === String(item))?.label)
              .filter((label): label is string => Boolean(label));
            if (labels.length === 0) return placeholder;
            if (allSelected) return `每天`;
            const first = labels[0] || "";
            return labels.length > 1 ? `${first} 等${labels.length}天` : first;
          }}
        </SelectValue>
      </SelectTrigger>
      <SelectPopup alignItemWithTrigger={false}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value} label={option.label}>
            {option.label}
          </SelectItem>
        ))}
      </SelectPopup>
    </Select>
  );
}
