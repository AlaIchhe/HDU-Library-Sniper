"use client";

import { type MotionProps, motion, useInView, useReducedMotion, type Variants } from "motion/react";
import { useRef } from "react";

/**
 * Blur Fade — Magic UI
 * https://magicui.design/docs/components/blur-fade
 *
 * 轻微模糊 + 位移 + 透明度的入场，用于区块错峰出现；减少动态效果时直接就位。
 */
type MarginType = `${number}${"px" | "%"}` | `${number}${"px" | "%"} ${number}${"px" | "%"}`;

interface BlurFadeProps extends MotionProps {
  children: React.ReactNode;
  className?: string;
  variant?: { hidden: { y: number }; visible: { y: number } };
  duration?: number;
  delay?: number;
  offset?: number;
  direction?: "up" | "down" | "left" | "right";
  inView?: boolean;
  inViewMargin?: MarginType;
  blur?: string;
}

export function BlurFade({
  children,
  className,
  variant,
  duration = 0.28,
  delay = 0,
  offset = 8,
  direction = "up",
  inView = false,
  inViewMargin = "-50px",
  blur = "4px",
  ...props
}: BlurFadeProps) {
  const ref = useRef<HTMLDivElement>(null);
  const reduced = useReducedMotion();
  const inViewResult = useInView(ref, { once: true, margin: inViewMargin });
  const isInView = !inView || inViewResult;
  const axis = direction === "left" || direction === "right" ? "x" : "y";
  const sign = direction === "right" || direction === "down" ? -1 : 1;
  const defaultVariants: Variants = {
    hidden: { [axis]: sign * offset, opacity: 0, filter: `blur(${blur})` },
    visible: { [axis]: 0, opacity: 1, filter: "blur(0px)" },
  };
  const combinedVariants = variant || defaultVariants;

  if (reduced) {
    return <div className={className}>{children}</div>;
  }

  return (
    <motion.div
      ref={ref}
      initial="hidden"
      animate={isInView ? "visible" : "hidden"}
      variants={combinedVariants}
      transition={{ delay, duration, ease: [0.22, 1, 0.36, 1] }}
      className={className}
      {...props}
    >
      {children}
    </motion.div>
  );
}
