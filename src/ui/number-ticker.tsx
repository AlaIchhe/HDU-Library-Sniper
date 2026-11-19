"use client";

import { useInView, useMotionValue, useReducedMotion, useSpring } from "motion/react";
import { type ComponentPropsWithoutRef, useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * Number Ticker — Magic UI
 * https://magicui.design/docs/components/number-ticker
 *
 * 数值变化时用弹簧滚动到新值；减少动态效果时直接显示终值。
 */
interface NumberTickerProps extends ComponentPropsWithoutRef<"span"> {
  value: number;
  startValue?: number;
  direction?: "up" | "down";
  delay?: number;
  decimalPlaces?: number;
}

function formatNumber(latest: number, decimalPlaces: number) {
  return Intl.NumberFormat("zh-CN", {
    minimumFractionDigits: decimalPlaces,
    maximumFractionDigits: decimalPlaces,
  }).format(Number(latest.toFixed(decimalPlaces)));
}

export function NumberTicker({
  value,
  startValue = 0,
  direction = "up",
  delay = 0,
  className,
  decimalPlaces = 0,
  ...props
}: NumberTickerProps) {
  const ref = useRef<HTMLSpanElement>(null);
  const reduced = useReducedMotion();
  const motionValue = useMotionValue(direction === "down" ? value : startValue);
  const springValue = useSpring(motionValue, { damping: 60, stiffness: 100 });
  const isInView = useInView(ref, { once: true, margin: "0px" });

  useEffect(() => {
    if (!isInView) return;
    if (reduced) {
      motionValue.jump(direction === "down" ? startValue : value);
      springValue.jump(direction === "down" ? startValue : value);
      return;
    }
    const timer = setTimeout(() => motionValue.set(direction === "down" ? startValue : value), delay * 1000);
    return () => clearTimeout(timer);
  }, [motionValue, springValue, isInView, delay, value, direction, startValue, reduced]);

  useEffect(
    () =>
      springValue.on("change", (latest) => {
        if (ref.current) ref.current.textContent = formatNumber(latest, decimalPlaces);
      }),
    [springValue, decimalPlaces],
  );

  return (
    <span ref={ref} className={cn("inline-block tracking-tight tabular-nums", className)} {...props}>
      {formatNumber(direction === "down" ? value : startValue, decimalPlaces)}
    </span>
  );
}
