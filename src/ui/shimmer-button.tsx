"use client";

import type React from "react";

import { cn } from "@/lib/utils";
import { Spinner } from "@/ui/spinner";

/**
 * Shimmer Button — Magic UI
 * https://magicui.design/docs/components/shimmer-button
 *
 * 沿按钮边缘旋转的克制微光 + 内部柔光；默认与站点单色主按钮（primary / primary-foreground）对齐，
 * 浅色与深色模式均保持一致的对比度。
 */
export interface ShimmerButtonProps extends React.ComponentProps<"button"> {
  shimmerColor?: string;
  shimmerSize?: string;
  borderRadius?: string;
  shimmerDuration?: string;
  background?: string;
  loading?: boolean;
}

export function ShimmerButton({
  shimmerColor = "color-mix(in oklch, var(--primary-foreground) 80%, transparent)",
  shimmerSize = "0.06em",
  shimmerDuration = "3.4s",
  borderRadius = "var(--radius-md)",
  background = "var(--primary)",
  loading = false,
  disabled,
  className,
  children,
  type = "button",
  ...props
}: ShimmerButtonProps) {
  return (
    <button
      type={type}
      disabled={disabled || loading}
      style={
        {
          "--spread": "90deg",
          "--shimmer-color": shimmerColor,
          "--shimmer-radius": borderRadius,
          "--speed": shimmerDuration,
          "--cut": shimmerSize,
          "--bg": background,
        } as React.CSSProperties
      }
      className={cn(
        "group relative z-0 inline-flex cursor-pointer items-center justify-center gap-2 overflow-hidden whitespace-nowrap border border-primary/15 px-4 py-2 text-sm font-medium text-primary-foreground shadow-xs outline-none [background:var(--bg)] [border-radius:var(--shimmer-radius)]",
        "transform-gpu transition-[transform,opacity,box-shadow] duration-200 ease-out hover:opacity-95 active:translate-y-px active:scale-[0.985]",
        "focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:pointer-events-none disabled:opacity-60",
        className,
      )}
      {...props}
    >
      <div aria-hidden className="-z-30 blur-[2px] absolute inset-0 overflow-visible [container-type:size]">
        <div className="absolute inset-0 h-[100cqh] animate-shimmer-slide [aspect-ratio:1] [border-radius:0] [mask:none]">
          <div className="absolute -inset-full w-auto rotate-0 animate-spin-around [background:conic-gradient(from_calc(270deg-(var(--spread)*0.5)),transparent_0,var(--shimmer-color)_var(--spread),transparent_var(--spread))] [translate:0_0]" />
        </div>
      </div>
      <span className="relative z-10 inline-flex items-center justify-center gap-2">
        {loading ? <Spinner className="size-4 text-current" /> : null}
        {children}
      </span>
      <div
        aria-hidden
        className="absolute inset-0 size-full [border-radius:var(--shimmer-radius)] shadow-[inset_0_-8px_10px_color-mix(in_oklch,var(--primary-foreground)_10%,transparent)] transition-shadow duration-300 group-hover:shadow-[inset_0_-6px_10px_color-mix(in_oklch,var(--primary-foreground)_18%,transparent)]"
      />
      <div
        aria-hidden
        className="absolute -z-20 [background:var(--bg)] [border-radius:var(--shimmer-radius)] [inset:var(--cut)]"
      />
    </button>
  );
}
