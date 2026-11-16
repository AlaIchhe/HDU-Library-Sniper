"use client";

import { Combobox as ComboboxPrimitive } from "@base-ui/react/combobox";
import type * as React from "react";
import { cn } from "@/lib/utils";
import { AnimateIcon, ChevronsUpDown } from "@/ui/icons";
import { Input } from "@/ui/input";
import { ScrollArea } from "@/ui/scroll-area";

export function Combobox<Value>(props: ComboboxPrimitive.Root.Props<Value, false>): React.ReactElement {
  return <ComboboxPrimitive.Root {...props} />;
}

export function ComboboxInput({
  className,
  size,
  ...props
}: Omit<ComboboxPrimitive.Input.Props, "size"> & {
  size?: "sm" | "default" | "lg" | number;
}): React.ReactElement {
  const sizeValue = (size ?? "default") as "sm" | "default" | "lg" | number;

  return (
    <ComboboxPrimitive.InputGroup
      className="relative w-full not-has-[>*.w-full]:w-fit text-foreground has-disabled:opacity-64"
      data-slot="combobox-input-group"
    >
      <ComboboxPrimitive.Input
        className={cn(
          sizeValue === "sm"
            ? "has-[+[data-slot=combobox-trigger]]:*:data-[slot=combobox-input]:pe-6.5"
            : "has-[+[data-slot=combobox-trigger]]:*:data-[slot=combobox-input]:pe-7",
          className,
        )}
        data-slot="combobox-input"
        render={<Input className="has-disabled:opacity-100" nativeInput size={sizeValue} />}
        {...props}
      />
      <AnimateIcon animateOnHover asChild>
        <ComboboxPrimitive.Trigger
          className={cn(
            "absolute top-1/2 inline-flex size-8 shrink-0 -translate-y-1/2 cursor-pointer items-center justify-center rounded-md border border-transparent opacity-80 outline-none transition-opacity pointer-coarse:after:absolute pointer-coarse:after:min-h-11 pointer-coarse:after:min-w-11 hover:opacity-100 sm:size-7 [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
            sizeValue === "sm" ? "end-0" : "end-0.5",
          )}
          data-slot="combobox-trigger"
        >
          <ComboboxPrimitive.Icon data-slot="combobox-icon">
            <ChevronsUpDown />
          </ComboboxPrimitive.Icon>
        </ComboboxPrimitive.Trigger>
      </AnimateIcon>
    </ComboboxPrimitive.InputGroup>
  );
}

export function ComboboxPopup({
  className,
  children,
  side = "bottom",
  sideOffset = 4,
  alignOffset,
  align = "start",
  portalProps,
  ...props
}: ComboboxPrimitive.Popup.Props & {
  align?: ComboboxPrimitive.Positioner.Props["align"];
  sideOffset?: ComboboxPrimitive.Positioner.Props["sideOffset"];
  alignOffset?: ComboboxPrimitive.Positioner.Props["alignOffset"];
  side?: ComboboxPrimitive.Positioner.Props["side"];
  portalProps?: ComboboxPrimitive.Portal.Props;
}): React.ReactElement {
  return (
    <ComboboxPrimitive.Portal {...portalProps}>
      <ComboboxPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        className="z-50 select-none"
        data-slot="combobox-positioner"
        side={side}
        sideOffset={sideOffset}
      >
        <span
          className={cn(
            "relative flex max-h-full min-w-(--anchor-width) max-w-(--available-width) origin-(--transform-origin) rounded-lg border bg-popover not-dark:bg-clip-padding shadow-lg/5 transition-[scale,opacity] before:pointer-events-none before:absolute before:inset-0 before:rounded-[calc(var(--radius-lg)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            className,
          )}
        >
          <ComboboxPrimitive.Popup
            className="flex max-h-[min(var(--available-height),23rem)] flex-1 flex-col text-foreground"
            data-slot="combobox-popup"
            {...props}
          >
            {children}
          </ComboboxPrimitive.Popup>
        </span>
      </ComboboxPrimitive.Positioner>
    </ComboboxPrimitive.Portal>
  );
}

export function ComboboxItem({
  className,
  children,
  ...props
}: ComboboxPrimitive.Item.Props): React.ReactElement {
  return (
    <ComboboxPrimitive.Item
      className={cn(
        "grid min-h-8 in-data-[side=none]:min-w-[calc(var(--anchor-width)+1.25rem)] cursor-default grid-cols-[1rem_minmax(0,1fr)] items-center gap-2 rounded-sm py-1 ps-2 pe-4 text-base outline-none data-disabled:pointer-events-none data-highlighted:bg-accent data-highlighted:text-accent-foreground data-disabled:opacity-64 sm:min-h-7 sm:text-sm [&_svg:not([class*='size-'])]:size-4.5 sm:[&_svg:not([class*='size-'])]:size-4 [&_svg]:pointer-events-none [&_svg]:shrink-0",
        className,
      )}
      data-slot="combobox-item"
      {...props}
    >
      <ComboboxPrimitive.ItemIndicator className="col-start-1">
        <svg
          aria-hidden="true"
          fill="none"
          height="24"
          stroke="currentColor"
          strokeLinecap="round"
          strokeLinejoin="round"
          strokeWidth="2"
          viewBox="0 0 24 24"
          width="24"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M5.252 12.7 10.2 18.63 18.748 5.37" />
        </svg>
      </ComboboxPrimitive.ItemIndicator>
      <div className="wrap-anywhere col-start-2 min-w-0">{children}</div>
    </ComboboxPrimitive.Item>
  );
}

export function ComboboxEmpty({ className, ...props }: ComboboxPrimitive.Empty.Props): React.ReactElement {
  return (
    <ComboboxPrimitive.Empty
      className={cn("not-empty:p-2 text-center text-base text-muted-foreground sm:text-sm", className)}
      data-slot="combobox-empty"
      {...props}
    />
  );
}

export function ComboboxList({ className, ...props }: ComboboxPrimitive.List.Props): React.ReactElement {
  return (
    <ScrollArea overscrollContain scrollbarGutter scrollFade>
      <ComboboxPrimitive.List
        className={cn(
          "not-empty:scroll-py-1 not-empty:px-1 not-empty:py-1 in-data-has-overflow-y:pe-3",
          className,
        )}
        data-slot="combobox-list"
        {...props}
      />
    </ScrollArea>
  );
}
