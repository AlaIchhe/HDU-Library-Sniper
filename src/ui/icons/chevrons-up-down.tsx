"use client";

import { motion, type Variants } from "motion/react";

import { useIconVariants, IconWrapper, type IconProps, useAnimateIconContext } from "./icon";

type ChevronsUpDownProps = IconProps<keyof typeof animations>;

const animations = {
  default: {
    up: {
      initial: { y: 0 },
      animate: {
        y: [0, -1.5, 0],
        transition: { duration: 0.45, ease: "easeInOut" },
      },
    },
    down: {
      initial: { y: 0 },
      animate: {
        y: [0, 1.5, 0],
        transition: { duration: 0.45, ease: "easeInOut" },
      },
    },
  } satisfies Record<string, Variants>,
} as const;

function IconComponent({ size, ...props }: ChevronsUpDownProps) {
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
      <motion.path d="m7 15 5 5 5-5" variants={variants.down} initial="initial" animate={controls} />
      <motion.path d="m7 9 5-5 5 5" variants={variants.up} initial="initial" animate={controls} />
    </motion.svg>
  );
}

function ChevronsUpDown(props: ChevronsUpDownProps) {
  return <IconWrapper icon={IconComponent} {...props} />;
}

export {
  animations,
  ChevronsUpDown,
  ChevronsUpDown as ChevronsUpDownIcon,
  type ChevronsUpDownProps,
  type ChevronsUpDownProps as ChevronsUpDownIconProps,
};
