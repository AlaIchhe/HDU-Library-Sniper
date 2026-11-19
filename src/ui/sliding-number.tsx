"use client";

import { type MotionValue, motion, useReducedMotion, useSpring, useTransform } from "motion/react";
import { useEffect } from "react";

import { cn } from "@/lib/utils";

/**
 * Sliding Number — Motion Primitives
 * https://motion-primitives.com/docs/sliding-number
 *
 * 每一位数字是一条 0–9 的竖向胶卷，数值变化时弹簧滚动；减少动态效果时直接渲染静态文本。
 */
const TRANSITION = { stiffness: 280, damping: 20, mass: 0.35 };

function Digit({ value, place }: { value: number; place: number }) {
  const digit = Math.floor(value / place) % 10;
  const animated = useSpring(digit, TRANSITION);

  useEffect(() => {
    animated.set(digit);
  }, [animated, digit]);

  return (
    <span className="relative inline-block w-[1ch] overflow-y-clip leading-none tabular-nums">
      <span className="invisible">0</span>
      {Array.from({ length: 10 }, (_, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: 0–9 固定胶卷
        <Reel key={i} mv={animated} number={i} />
      ))}
    </span>
  );
}

function Reel({ mv, number }: { mv: MotionValue<number>; number: number }) {
  const y = useTransform(mv, (latest) => {
    const placeValue = latest % 10;
    const offset = (10 + number - placeValue) % 10;
    let memo = offset;
    if (offset > 5) memo -= 10;
    return `${memo}em`;
  });
  return (
    <motion.span style={{ y }} className="absolute inset-0 flex items-center justify-center">
      {number}
    </motion.span>
  );
}

export function SlidingNumber({
  value,
  padStart = false,
  className,
}: {
  value: number;
  padStart?: boolean;
  className?: string;
}) {
  const reduced = useReducedMotion();
  const abs = Math.abs(Math.trunc(value));
  const formatted = `${value < 0 ? "-" : ""}${padStart && abs < 10 ? `0${abs}` : String(abs)}`;

  if (reduced) {
    return (
      <span className={cn("inline-flex items-center leading-none tabular-nums", className)}>{formatted}</span>
    );
  }

  const digits = (padStart && abs < 10 ? `0${abs}` : String(abs)).split("");
  return (
    <span className={cn("inline-flex items-center leading-none tabular-nums", className)}>
      <span className="sr-only">{formatted}</span>
      <span aria-hidden className="inline-flex">
        {value < 0 && "-"}
        {digits.map((_, index) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: 位数即身份
          <Digit key={`pos-${digits.length - index}`} value={abs} place={10 ** (digits.length - index - 1)} />
        ))}
      </span>
    </span>
  );
}
