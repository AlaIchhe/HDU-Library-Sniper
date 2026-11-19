"use client";

import { motion, type Transition, useReducedMotion } from "motion/react";
import { useMemo, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Blur Text — React Bits
 * https://reactbits.dev/text-animations/blur-text
 *
 * 逐字（中文）/ 逐词（英文）由轻模糊到清晰地落定；完成后自动折叠回单文本节点，
 * 保持文本选择与无障碍树完全干净。
 */
type BlurTextProps = {
  text: string;
  delay?: number;
  className?: string;
  animateBy?: "words" | "letters";
  direction?: "top" | "bottom";
  stepDuration?: number;
  as?: "h1" | "h2" | "p" | "span";
};

export function BlurText({
  text,
  delay = 28,
  className,
  animateBy = "letters",
  direction = "bottom",
  stepDuration = 0.22,
  as: Tag = "p",
}: BlurTextProps) {
  const reduced = useReducedMotion();
  const [settled, setSettled] = useState(false);
  const segments = useMemo(
    () => (animateBy === "words" ? text.split(/(\s+)/) : Array.from(text)),
    [text, animateBy],
  );

  if (reduced || settled) {
    return <Tag className={cn("relative", className)}>{text}</Tag>;
  }

  const from = { filter: "blur(6px)", opacity: 0, y: direction === "top" ? -10 : 10 };
  const steps = [
    { filter: "blur(2px)", opacity: 0.7, y: direction === "top" ? 2 : -2 },
    { filter: "blur(0px)", opacity: 1, y: 0 },
  ];

  return (
    <Tag className={cn("relative", className)}>
      <span className="sr-only">{text}</span>
      <span aria-hidden className="inline-flex flex-wrap">
        {segments.map((segment, index) => {
          const isLast = index === segments.length - 1;
          const transition: Transition = {
            duration: stepDuration * 2,
            times: [0, 0.5, 1],
            delay: (index * delay) / 1000,
            ease: [0.22, 1, 0.36, 1],
          };
          return (
            <motion.span
              // biome-ignore lint/suspicious/noArrayIndexKey: 文本片段顺序即身份
              key={`${segment}-${index}`}
              className="inline-block will-change-[transform,filter,opacity]"
              initial={from}
              animate={{
                filter: [from.filter, steps[0].filter, steps[1].filter],
                opacity: [from.opacity, steps[0].opacity, steps[1].opacity],
                y: [from.y, steps[0].y, steps[1].y],
              }}
              transition={transition}
              onAnimationComplete={isLast ? () => setSettled(true) : undefined}
            >
              {segment === " " ? "\u00A0" : segment}
            </motion.span>
          );
        })}
      </span>
    </Tag>
  );
}
