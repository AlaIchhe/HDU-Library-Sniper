"use client";

import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import * as React from "react";
import { cn } from "@/lib/utils";
import { Button } from "@/ui/button";
import { AnimateIcon, PanelLeft } from "@/ui/icons";
import { ScrollArea } from "@/ui/scroll-area";

const SIDEBAR_WIDTH = "16rem";
const SIDEBAR_KEYBOARD_SHORTCUT = "b";

type SidebarContextProps = {
  state: "expanded" | "collapsed";
  open: boolean;
  setOpen: (open: boolean) => void;
  toggleSidebar: () => void;
};

const SidebarContext = React.createContext<SidebarContextProps | null>(null);

function useSidebar(): SidebarContextProps {
  const context = React.useContext(SidebarContext);
  if (!context) {
    throw new Error("useSidebar must be used within a SidebarProvider.");
  }
  return context;
}

export function SidebarProvider({
  defaultOpen = true,
  open: openProp,
  onOpenChange: setOpenProp,
  className,
  style,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  defaultOpen?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}): React.ReactElement {
  const [_open, _setOpen] = React.useState(defaultOpen);
  const open = openProp ?? _open;

  const setOpen = React.useCallback(
    (value: boolean | ((prev: boolean) => boolean)) => {
      const openState = typeof value === "function" ? value(open) : value;
      if (setOpenProp) setOpenProp(openState);
      else _setOpen(openState);
    },
    [setOpenProp, open],
  );

  const toggleSidebar = React.useCallback(() => {
    setOpen((prev) => !prev);
  }, [setOpen]);

  React.useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent): void => {
      if (event.key === SIDEBAR_KEYBOARD_SHORTCUT && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        toggleSidebar();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [toggleSidebar]);

  const state = open ? "expanded" : "collapsed";

  const contextValue = React.useMemo<SidebarContextProps>(
    () => ({ open, setOpen, state, toggleSidebar }),
    [state, open, setOpen, toggleSidebar],
  );

  return (
    <SidebarContext.Provider value={contextValue}>
      <div
        className={cn(
          "group/sidebar-wrapper flex min-h-svh w-full has-data-[variant=inset]:bg-sidebar",
          className,
        )}
        data-slot="sidebar-wrapper"
        style={{ "--sidebar-width": SIDEBAR_WIDTH, ...style } as React.CSSProperties}
        {...props}
      >
        {children}
      </div>
    </SidebarContext.Provider>
  );
}

export function Sidebar({
  variant = "sidebar",
  className,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  variant?: "sidebar" | "inset";
}): React.ReactElement {
  const { state } = useSidebar();

  return (
    <div
      className="group peer hidden text-sidebar-foreground xl:block"
      data-collapsible={state === "collapsed" ? "offcanvas" : ""}
      data-side="left"
      data-slot="sidebar"
      data-state={state}
      data-variant={variant}
    >
      <div
        className={cn(
          "relative w-(--sidebar-width) bg-transparent transition-[width] duration-200 ease-linear",
          "group-data-[collapsible=offcanvas]:w-0",
        )}
        data-slot="sidebar-gap"
      />
      <div
        className={cn(
          "fixed inset-y-0 left-0 z-10 hidden h-svh w-(--sidebar-width) transition-[left,width] duration-200 ease-linear group-data-[collapsible=offcanvas]:left-[calc(var(--sidebar-width)*-1)] xl:flex",
          variant === "inset" ? "p-2" : "border-r",
          className,
        )}
        data-slot="sidebar-container"
        {...props}
      >
        <div
          className="flex h-full w-full flex-col bg-sidebar"
          data-sidebar="sidebar"
          data-slot="sidebar-inner"
        >
          {children}
        </div>
      </div>
    </div>
  );
}

export function SidebarTrigger({
  className,
  onClick,
  ...props
}: React.ComponentProps<typeof Button>): React.ReactElement {
  const { toggleSidebar } = useSidebar();

  return (
    <AnimateIcon animateOnHover asChild>
      <Button
        className={cn("size-7", className)}
        data-sidebar="trigger"
        data-slot="sidebar-trigger"
        onClick={(event: React.MouseEvent<HTMLButtonElement>) => {
          onClick?.(event);
          toggleSidebar();
        }}
        size="icon"
        variant="ghost"
        {...props}
      >
        <PanelLeft />
        <span className="sr-only">Toggle Sidebar</span>
      </Button>
    </AnimateIcon>
  );
}

export function SidebarInset({ className, ...props }: React.ComponentProps<"main">): React.ReactElement {
  return (
    <main
      className={cn(
        "relative flex w-full flex-1 flex-col bg-background",
        "xl:peer-data-[variant=inset]:peer-data-[state=collapsed]:ms-2 xl:peer-data-[variant=inset]:m-2 xl:peer-data-[variant=inset]:ms-0 xl:peer-data-[variant=inset]:rounded-xl xl:peer-data-[variant=inset]:shadow-sm/5",
        className,
      )}
      data-slot="sidebar-inset"
      {...props}
    />
  );
}

export function SidebarHeader({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return <div className={cn("flex flex-col gap-2 p-2", className)} data-slot="sidebar-header" {...props} />;
}

export function SidebarFooter({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return <div className={cn("flex flex-col gap-2 p-2", className)} data-slot="sidebar-footer" {...props} />;
}

export function SidebarContent({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <ScrollArea className="min-h-0 flex-1" fill overscrollContain scrollFade>
      <div className={cn("flex h-full flex-col gap-2", className)} data-slot="sidebar-content" {...props} />
    </ScrollArea>
  );
}

export function SidebarGroup({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn("relative flex w-full min-w-0 flex-col p-2", className)}
      data-slot="sidebar-group"
      {...props}
    />
  );
}

export function SidebarGroupLabel({ className, ...props }: React.ComponentProps<"div">): React.ReactElement {
  return (
    <div
      className={cn(
        "flex h-8 shrink-0 items-center rounded-lg px-2 font-medium text-sidebar-foreground text-xs outline-hidden ring-sidebar-ring",
        className,
      )}
      data-slot="sidebar-group-label"
      {...props}
    />
  );
}

export function SidebarGroupContent({
  className,
  ...props
}: React.ComponentProps<"div">): React.ReactElement {
  return <div className={cn("w-full text-sm", className)} data-slot="sidebar-group-content" {...props} />;
}

export function SidebarMenu({ className, ...props }: React.ComponentProps<"ul">): React.ReactElement {
  return (
    <ul className={cn("flex w-full min-w-0 flex-col gap-1", className)} data-slot="sidebar-menu" {...props} />
  );
}

export function SidebarMenuItem({ className, ...props }: React.ComponentProps<"li">): React.ReactElement {
  return (
    <li className={cn("group/menu-item relative", className)} data-slot="sidebar-menu-item" {...props} />
  );
}

export function SidebarMenuButton({
  isActive = false,
  tooltip,
  className,
  render,
  ...props
}: useRender.ComponentProps<"button"> & {
  isActive?: boolean;
  tooltip?: string;
}): React.ReactElement {
  const defaultProps = {
    className: cn(
      "peer/menu-button flex h-9 w-full items-center gap-2 overflow-hidden rounded-lg p-2 text-left text-sm outline-hidden ring-sidebar-ring transition-[width,height,padding,background-color,color,box-shadow,transform] duration-150 hover:bg-sidebar-accent hover:text-sidebar-accent-foreground focus-visible:bg-sidebar-accent focus-visible:text-sidebar-accent-foreground focus-visible:ring-2 focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar active:bg-sidebar-accent active:text-sidebar-accent-foreground disabled:pointer-events-none disabled:opacity-50 data-[active=true]:bg-sidebar-accent data-[active=true]:font-medium data-[active=true]:text-sidebar-accent-foreground data-[active=true]:shadow-xs dark:data-[active=true]:bg-foreground/10 [&>span:last-child]:truncate [&>svg:not([class*='size-'])]:size-5 [&>svg]:shrink-0",
      className,
    ),
    "data-active": isActive,
    "data-sidebar": "menu-button",
    "data-slot": "sidebar-menu-button",
    title: tooltip,
  };

  return useRender({
    defaultTagName: "button",
    props: mergeProps<"button">(defaultProps, props),
    render,
  });
}
