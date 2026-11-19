"use client";

import { motion, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import type React from "react";
import { useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * Magnet — React Bits
 * https://reactbits.dev/animations/magnet
 *
 * 指针靠近时元素被「吸」过去一点。原版用 setState + CSS transition，
 * 这里换成 motion 弹簧值，mousemove 不触发 React 渲染。触屏 / 减少动态效果时不生效。
 */
type MagnetProps = {
  children: React.ReactNode;
  padding?: number;
  magnetStrength?: number;
  className?: string;
};

export function Magnet({ children, padding = 60, magnetStrength = 4, className }: MagnetProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const x = useMotionValue(0);
  const y = useMotionValue(0);
  const springX = useSpring(x, { stiffness: 260, damping: 18, mass: 0.4 });
  const springY = useSpring(y, { stiffness: 260, damping: 18, mass: 0.4 });

  useEffect(() => {
    if (reduced || window.matchMedia?.("(pointer: coarse)").matches) return;
    const onMove = (e: PointerEvent) => {
      const el = ref.current;
      if (!el) return;
      const { left, top, width, height } = el.getBoundingClientRect();
      const cx = left + width / 2;
      const cy = top + height / 2;
      if (Math.abs(cx - e.clientX) < width / 2 + padding && Math.abs(cy - e.clientY) < height / 2 + padding) {
        x.set((e.clientX - cx) / magnetStrength);
        y.set((e.clientY - cy) / magnetStrength);
      } else {
        x.set(0);
        y.set(0);
      }
    };
    window.addEventListener("pointermove", onMove, { passive: true });
    return () => window.removeEventListener("pointermove", onMove);
  }, [padding, magnetStrength, reduced, x, y]);

  return (
    <div ref={ref} className={cn("relative inline-block", className)}>
      <motion.div style={{ x: springX, y: springY }}>{children}</motion.div>
    </div>
  );
}
