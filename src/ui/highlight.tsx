"use client";

import { AnimatePresence, motion, type Transition } from "motion/react";
import * as React from "react";
import { cn } from "../lib/utils";

type Bounds = {
  top: number;
  left: number;
  width: number;
  height: number;
};

type HighlightContextType = {
  activeValue: string | null;
  setActiveValue: (value: string | null) => void;
  setBounds: (bounds: DOMRect) => void;
  clearBounds: () => void;
  hover: boolean;
  disabled: boolean;
  setActiveClassName: (className: string) => void;
};

const HighlightContext = React.createContext<HighlightContextType | undefined>(undefined);

function useHighlight(): HighlightContextType {
  const context = React.useContext(HighlightContext);
  if (!context) {
    throw new Error("useHighlight must be used within a Highlight");
  }
  return context;
}

type HighlightProps = {
  mode?: "parent";
  controlledItems?: boolean;
  hover?: boolean;
  disabled?: boolean;
  exitDelay?: number;
  transition?: Transition;
  className?: string;
  containerClassName?: string;
  style?: React.CSSProperties;
  value?: string | null;
  defaultValue?: string | null;
  onValueChange?: (value: string | null) => void;
  children: React.ReactNode;
};

function Highlight({
  children,
  value,
  defaultValue,
  onValueChange,
  className,
  containerClassName,
  style,
  transition = { type: "spring", stiffness: 350, damping: 35 },
  hover = false,
  disabled = false,
  exitDelay = 200,
}: HighlightProps) {
  const localRef = React.useRef<HTMLDivElement>(null);
  const [activeValue, setActiveValue] = React.useState<string | null>(value ?? defaultValue ?? null);
  const [boundsState, setBoundsState] = React.useState<Bounds | null>(null);
  const [activeClassNameState, setActiveClassNameState] = React.useState<string>("");

  const safeSetActiveValue = React.useCallback(
    (id: string | null) => {
      setActiveValue((prev) => {
        if (prev !== id) {
          onValueChange?.(id);
          return id;
        }
        return prev;
      });
    },
    [onValueChange],
  );

  const setBounds = React.useCallback((bounds: DOMRect) => {
    if (!localRef.current) return;
    const containerRect = localRef.current.getBoundingClientRect();
    const next: Bounds = {
      top: bounds.top - containerRect.top,
      left: bounds.left - containerRect.left,
      width: bounds.width,
      height: bounds.height,
    };
    setBoundsState((prev) =>
      prev &&
      prev.top === next.top &&
      prev.left === next.left &&
      prev.width === next.width &&
      prev.height === next.height
        ? prev
        : next,
    );
  }, []);

  const clearBounds = React.useCallback(() => {
    setBoundsState((prev) => (prev === null ? prev : null));
  }, []);

  React.useEffect(() => {
    if (value !== undefined) setActiveValue(value);
    else if (defaultValue !== undefined) setActiveValue(defaultValue);
  }, [value, defaultValue]);

  React.useEffect(() => {
    const container = localRef.current;
    if (!container) return;

    const onScroll = () => {
      if (!activeValue) return;
      const activeEl = container.querySelector<HTMLElement>(
        `[data-value="${activeValue}"][data-highlight="true"]`,
      );
      if (activeEl) setBounds(activeEl.getBoundingClientRect());
    };

    container.addEventListener("scroll", onScroll, { passive: true });
    return () => container.removeEventListener("scroll", onScroll);
  }, [activeValue, setBounds]);

  return (
    <HighlightContext.Provider
      value={{
        activeValue,
        setActiveValue: safeSetActiveValue,
        hover,
        disabled,
        setBounds,
        clearBounds,
        setActiveClassName: setActiveClassNameState,
      }}
    >
      <div
        ref={localRef}
        data-slot="motion-highlight-container"
        style={{ position: "relative", zIndex: 1 }}
        className={containerClassName}
      >
        <AnimatePresence initial={false} mode="wait">
          {boundsState && (
            <motion.div
              data-slot="motion-highlight"
              animate={{
                top: boundsState.top,
                left: boundsState.left,
                width: boundsState.width,
                height: boundsState.height,
                opacity: 1,
              }}
              initial={{
                top: boundsState.top,
                left: boundsState.left,
                width: boundsState.width,
                height: boundsState.height,
                opacity: 0,
              }}
              exit={{
                opacity: 0,
                transition: {
                  ...transition,
                  delay: (transition?.delay ?? 0) + exitDelay / 1000,
                },
              }}
              transition={transition}
              style={{ position: "absolute", zIndex: 0, ...style }}
              className={cn(className, activeClassNameState)}
            />
          )}
        </AnimatePresence>
        {children}
      </div>
    </HighlightContext.Provider>
  );
}

type ExtendedChildProps = React.ComponentProps<"div"> & {
  id?: string;
  ref?: React.Ref<HTMLElement>;
  "data-active"?: string;
  "data-value"?: string;
  "data-disabled"?: boolean;
  "data-highlight"?: boolean;
  "data-slot"?: string;
};

type HighlightItemProps = {
  children: React.ReactElement;
  id?: string;
  value?: string;
  activeClassName?: string;
  disabled?: boolean;
  asChild?: boolean;
};

function HighlightItem({ children, id, value, disabled = false, activeClassName }: HighlightItemProps) {
  const itemId = React.useId();
  const {
    activeValue,
    setActiveValue,
    setBounds,
    clearBounds,
    hover,
    disabled: contextDisabled,
    setActiveClassName,
  } = useHighlight();

  const element = children as React.ReactElement<ExtendedChildProps>;
  const childValue = id ?? value ?? element.props?.["data-value"] ?? element.props?.id ?? itemId;
  const isActive = activeValue === childValue;
  const isDisabled = disabled ?? contextDisabled;
  const localRef = React.useRef<HTMLElement | null>(null);

  const refCallback = React.useCallback((node: HTMLElement | null) => {
    localRef.current = node;
  }, []);

  React.useEffect(() => {
    if (isActive && localRef.current) {
      setBounds(localRef.current.getBoundingClientRect());
      setActiveClassName(activeClassName ?? "");
    } else if (!activeValue) {
      clearBounds();
    }
  }, [isActive, activeValue, setBounds, clearBounds, activeClassName, setActiveClassName]);

  if (!React.isValidElement(children)) return children;

  const dataAttributes: Record<string, unknown> = {
    "data-active": isActive ? "true" : "false",
    "aria-selected": isActive,
    "data-disabled": isDisabled,
    "data-value": childValue,
    "data-highlight": true,
    "data-slot": "motion-highlight-item",
  };
  for (const key of Object.keys(dataAttributes)) {
    if ((element.props as Record<string, unknown>)[key] !== undefined) {
      delete dataAttributes[key];
    }
  }

  const handlers = hover
    ? {
        onMouseEnter: (e: React.MouseEvent<HTMLDivElement>) => {
          setActiveValue(childValue);
          element.props.onMouseEnter?.(e);
        },
        onMouseLeave: (e: React.MouseEvent<HTMLDivElement>) => {
          setActiveValue(null);
          element.props.onMouseLeave?.(e);
        },
      }
    : {};

  return React.cloneElement(element, {
    ref: refCallback,
    ...dataAttributes,
    ...handlers,
  } as Partial<ExtendedChildProps>);
}

export { Highlight, HighlightItem };
