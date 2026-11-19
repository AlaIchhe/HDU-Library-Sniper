"use client";

import { motion } from "motion/react";
import type React from "react";

import { cn } from "@/lib/utils";

/**
 * Text Shimmer — Motion Primitives
 * https://motion-primitives.com/docs/text-shimmer
 */
export function TextShimmer({
  children,
  className,
  duration = 2,
  spread = 2,
}: {
  children: string;
  className?: string;
  duration?: number;
  spread?: number;
}) {
  return (
    <motion.span
      className={cn(
        "relative inline-block bg-[length:250%_100%,auto] bg-clip-text text-transparent",
        "[--base-color:var(--muted-foreground)] [--base-gradient-color:var(--foreground)]",
        "[background-repeat:no-repeat,padding-box] [--bg:linear-gradient(90deg,#0000_calc(50%-var(--spread)),var(--base-gradient-color),#0000_calc(50%+var(--spread)))]",
        className,
      )}
      initial={{ backgroundPosition: "100% center" }}
      animate={{ backgroundPosition: "0% center" }}
      transition={{ repeat: Number.POSITIVE_INFINITY, duration, ease: "linear" }}
      style={
        {
          "--spread": `${children.length * spread}px`,
          backgroundImage: "var(--bg), linear-gradient(var(--base-color), var(--base-color))",
        } as React.CSSProperties
      }
    >
      {children}
    </motion.span>
  );
}
