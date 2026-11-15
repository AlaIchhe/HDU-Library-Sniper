"use client";

import { motion, type Variants } from "motion/react";

import { useIconVariants, IconWrapper, type IconProps, useAnimateIconContext } from "./icon";

type GripVerticalProps = IconProps<keyof typeof animations>;

const dot = (delay: number): Variants => ({
  initial: { scale: 1 },
  animate: {
    scale: [1, 1.35, 1],
    transition: { duration: 0.35, delay, ease: "easeInOut" },
  },
});

const animations = {
  default: {
    top: dot(0),
    mid: dot(0.08),
    bot: dot(0.16),
  } satisfies Record<string, Variants>,
} as const;

function IconComponent({ size, ...props }: GripVerticalProps) {
  const { controls } = useAnimateIconContext();
  const variants = useIconVariants(animations);

  return (
    <motion.svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...props}
    >
      <motion.circle
        cx={9}
        cy={5}
        r={1}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        variants={variants.top}
        initial="initial"
        animate={controls}
      />
      <motion.circle
        cx={15}
        cy={5}
        r={1}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        variants={variants.top}
        initial="initial"
        animate={controls}
      />
      <motion.circle
        cx={9}
        cy={12}
        r={1}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        variants={variants.mid}
        initial="initial"
        animate={controls}
      />
      <motion.circle
        cx={15}
        cy={12}
        r={1}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        variants={variants.mid}
        initial="initial"
        animate={controls}
      />
      <motion.circle
        cx={9}
        cy={19}
        r={1}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        variants={variants.bot}
        initial="initial"
        animate={controls}
      />
      <motion.circle
        cx={15}
        cy={19}
        r={1}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        variants={variants.bot}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}

function GripVertical(props: GripVerticalProps) {
  return <IconWrapper icon={IconComponent} {...props} />;
}

export {
  animations,
  GripVertical,
  GripVertical as GripVerticalIcon,
  type GripVerticalProps,
  type GripVerticalProps as GripVerticalIconProps,
};
