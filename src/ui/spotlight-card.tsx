"use client";

import type React from "react";
import { useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * Spotlight Card — React Bits
 * https://reactbits.dev/components/spotlight-card
 *
 * 指针位置一团克制的中性柔光。写 CSS 变量驱动，mousemove 不触发 React 重渲染。
 */
type SpotlightCardProps = React.ButtonHTMLAttributes<HTMLButtonElement> & {
  spotlightColor?: string;
};

export function SpotlightCard({
  children,
  className,
  spotlightColor = "color-mix(in oklch, var(--foreground) 8%, transparent)",
  onPointerMove,
  type = "button",
  ...props
}: SpotlightCardProps) {
  const ref = useRef<HTMLButtonElement>(null);

  return (
    <button
      ref={ref}
      type={type}
      onPointerMove={(event) => {
        const el = ref.current;
        if (el) {
          const rect = el.getBoundingClientRect();
          el.style.setProperty("--spot-x", `${event.clientX - rect.left}px`);
          el.style.setProperty("--spot-y", `${event.clientY - rect.top}px`);
        }
        onPointerMove?.(event);
      }}
      className={cn(
        "group/spot relative isolate flex cursor-pointer flex-col items-start overflow-hidden rounded-2xl border bg-card p-5 text-left outline-none transition-[border-color,transform,box-shadow] duration-200",
        "hover:-translate-y-0.5 hover:border-foreground/25 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background active:translate-y-0 active:scale-[0.99]",
        "disabled:pointer-events-none disabled:opacity-50",
        className,
      )}
      {...props}
    >
      <span
        aria-hidden
        className="pointer-events-none absolute inset-0 -z-1 opacity-0 transition-opacity duration-400 ease-in-out group-hover/spot:opacity-100 group-focus-visible/spot:opacity-100"
        style={{
          background: `radial-gradient(240px circle at var(--spot-x, 50%) var(--spot-y, 50%), ${spotlightColor}, transparent 75%)`,
        }}
      />
      {children}
    </button>
  );
}
