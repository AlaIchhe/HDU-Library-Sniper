"use client"
import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
} from "@/ui/combobox"
import { Field, FieldLabel, FormError } from "@/ui/field"
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/ui/select"

export function SelectField({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  error,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string; detail?: string }[]
  placeholder: string
  disabled?: boolean
  error?: string
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Select
        value={value}
        onValueChange={(next) => next && onChange(next)}
        disabled={disabled}
        itemToStringLabel={(item) =>
          options.find((option) => option.value === String(item))?.label ?? String(item ?? "")
        }
      >
        <SelectTrigger>
          <SelectValue placeholder={placeholder} />
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value} label={option.label}>
              {option.label}
              {option.detail && <small className="ms-2 text-muted-foreground">{option.detail}</small>}
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {error && <FormError>{error}</FormError>}
    </Field>
  )
}

export function SearchableField({
  label,
  value,
  onChange,
  options,
  placeholder,
  disabled,
  error,
  onOpenChange,
  emptyText = "没有匹配项",
}: {
  label: string
  value: string
  onChange: (value: string) => void
  options: { value: string; label: string }[]
  placeholder: string
  disabled?: boolean
  error?: string
  onOpenChange?: (open: boolean) => void
  emptyText?: string
}) {
  return (
    <Field>
      <FieldLabel>{label}</FieldLabel>
      <Combobox
        value={value}
        onValueChange={(next) => next !== null && onChange(String(next))}
        itemToStringValue={(item) => String(item ?? "")}
        onOpenChange={onOpenChange}
        disabled={disabled}
      >
        <ComboboxInput placeholder={placeholder} />
        <ComboboxPopup>
          <ComboboxList>
            {options.map((option) => (
              <ComboboxItem key={option.value} value={option.value}>
                {option.label}
              </ComboboxItem>
            ))}
            <ComboboxEmpty>{emptyText}</ComboboxEmpty>
          </ComboboxList>
        </ComboboxPopup>
      </Combobox>
      {error && <FormError>{error}</FormError>}
    </Field>
  )
}
