"use client";

import { Drawer as DrawerPrimitive } from "@base-ui/react/drawer";
import type React from "react";
import { cn } from "@/lib/utils";
import { ScrollArea } from "@/ui/scroll-area";

export function Drawer({
  swipeDirection = "down",
  ...props
}: DrawerPrimitive.Root.Props): React.ReactElement {
  return <DrawerPrimitive.Root swipeDirection={swipeDirection} {...props} />;
}

export function DrawerClose(props: DrawerPrimitive.Close.Props): React.ReactElement {
  return <DrawerPrimitive.Close data-slot="drawer-close" {...props} />;
}

export function DrawerPopup({
  className,
  children,
  ...props
}: DrawerPrimitive.Popup.Props): React.ReactElement {
  return (
    <DrawerPrimitive.Portal>
      <DrawerPrimitive.Backdrop
        className="fixed inset-0 z-50 bg-black/32 opacity-[calc(1-var(--drawer-swipe-progress))] backdrop-blur-sm transition-opacity duration-450 ease-[cubic-bezier(0.32,0.72,0,1)] data-ending-style:opacity-0 data-starting-style:opacity-0 data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-swiping:duration-0"
        data-slot="drawer-backdrop"
      />
      <DrawerPrimitive.Viewport
        className="fixed inset-0 z-50 grid touch-none grid-rows-[1fr_auto] pt-12 [--bleed:--spacing(12)] [--inset:0px]"
        data-slot="drawer-viewport"
      >
        <DrawerPrimitive.Popup
          className={cn(
            "relative row-start-2 -mb-[max(0px,calc(var(--drawer-snap-point-offset,0px)+clamp(0,1,var(--drawer-snap-point-offset,0px)/1px)*var(--drawer-swipe-movement-y,0px)))] flex h-(--drawer-height,auto) max-h-full min-h-0 w-full min-w-0 origin-[50%_calc(100%-var(--inset))] touch-none flex-col rounded-t-2xl border-t bg-popover not-dark:bg-clip-padding pb-[max(0px,calc(env(safe-area-inset-bottom,0px)+var(--drawer-snap-point-offset,0px)+clamp(0,1,var(--drawer-snap-point-offset,0px)/1px)*var(--drawer-swipe-movement-y,0px)))] text-popover-foreground shadow-lg/5 outline-none transition-[transform,box-shadow,height,background-color] duration-450 ease-[cubic-bezier(0.32,0.72,0,1)] will-change-transform [--height:max(0px,calc(var(--drawer-frontmost-height,var(--drawer-height))))] [--peek:calc(--spacing(6)-1px)] [--scale-base:calc(max(0,1-(var(--nested-drawers)*var(--stack-step))))] [--scale:clamp(0,calc(var(--scale-base)+(var(--stack-step)*var(--stack-progress))),1)] [--shrink:calc(1-var(--scale))] [--stack-peek-offset:max(0px,calc((var(--nested-drawers)-var(--stack-progress))*var(--peek)))] [--stack-progress:clamp(0,var(--drawer-swipe-progress),1)] [--stack-step:0.05] transform-[translateY(calc(var(--drawer-snap-point-offset)+var(--drawer-swipe-movement-y)))] before:pointer-events-none before:absolute before:inset-0 before:rounded-t-[calc(var(--radius-2xl)-1px)] before:shadow-[0_1px_--theme(--color-black/4%)] after:pointer-events-none after:absolute after:inset-x-0 after:top-full after:h-(--bleed) after:bg-popover not-data-starting-style:not-data-ending-style:transition-[transform,box-shadow,height,background-color,margin,padding] data-swiping:select-none data-nested-drawer-open:h-(--height) data-nested-drawer-open:overflow-hidden data-nested-drawer-open:bg-[color-mix(in_srgb,var(--popover),var(--color-black)_calc(2%*(var(--nested-drawers)-var(--stack-progress))))] data-nested-drawer-open:transform-[translateY(calc(var(--drawer-swipe-movement-y)-var(--stack-peek-offset)-(var(--shrink)*var(--height))))_scale(var(--scale))] data-ending-style:mb-0 data-starting-style:mb-0 data-ending-style:pb-0 data-starting-style:pb-0 data-ending-style:shadow-transparent data-starting-style:shadow-transparent data-ending-style:duration-[calc(var(--drawer-swipe-strength)*400ms)] data-ending-style:transform-[translateY(calc(100%+env(safe-area-inset-bottom,0px)+var(--inset)))] data-starting-style:transform-[translateY(calc(100%+env(safe-area-inset-bottom,0px)+var(--inset)))] dark:data-nested-drawer-open:bg-[color-mix(in_srgb,var(--popover),var(--color-black)_calc(6%*(var(--nested-drawers)-var(--stack-progress))))] dark:before:shadow-[0_-1px_--theme(--color-white/6%)]",
            className,
          )}
          data-slot="drawer-popup"
          {...props}
        >
          {children}
        </DrawerPrimitive.Popup>
      </DrawerPrimitive.Viewport>
    </DrawerPrimitive.Portal>
  );
}

export function DrawerHeader({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "flex cursor-default flex-col gap-2 p-6 in-[[data-slot=drawer-popup]:has([data-slot=drawer-panel])]:pb-3 max-sm:pb-4",
        className,
      )}
      data-slot="drawer-header"
      {...props}
    />
  );
}

export function DrawerFooter({ className, ...props }: DrawerPrimitive.Content.Props): React.ReactElement {
  return (
    <DrawerPrimitive.Content
      className={cn(
        "flex flex-col-reverse gap-2 border-t bg-muted/72 px-6 pt-4 pb-[calc(env(safe-area-inset-bottom,0px)+--spacing(4))] sm:flex-row sm:justify-end",
        className,
      )}
      data-slot="drawer-footer"
      {...props}
    />
  );
}

export function DrawerTitle({ className, ...props }: DrawerPrimitive.Title.Props): React.ReactElement {
  return (
    <DrawerPrimitive.Title
      className={cn("font-heading font-semibold text-xl leading-none", className)}
      data-slot="drawer-title"
      {...props}
    />
  );
}

export function DrawerPanel({ className, ...props }: DrawerPrimitive.Content.Props): React.ReactElement {
  return (
    <ScrollArea className="touch-auto" overscrollContain scrollFade>
      <DrawerPrimitive.Content
        className={cn(
          "p-6 in-[[data-slot=drawer-popup]:has([data-slot=drawer-header])]:pt-1 in-[[data-slot=drawer-popup]:has([data-slot=drawer-footer]:not(.border-t))]:pb-1",
          className,
        )}
        data-slot="drawer-panel"
        {...props}
      />
    </ScrollArea>
  );
}
