"use client";

import { motion, type Variants } from "motion/react";

import { useIconVariants, IconWrapper, type IconProps, useAnimateIconContext } from "./icon";

type ListChecksProps = IconProps<keyof typeof animations>;

const animations = {
  default: {
    check1: {
      initial: { pathLength: 1, opacity: 1 },
      animate: {
        pathLength: [0, 1],
        opacity: [0.2, 1],
        transition: { duration: 0.35, ease: "easeInOut" },
      },
    },
    check2: {
      initial: { pathLength: 1, opacity: 1 },
      animate: {
        pathLength: [0, 1],
        opacity: [0.2, 1],
        transition: { duration: 0.35, delay: 0.14, ease: "easeInOut" },
      },
    },
    line1: {
      initial: { x: 0 },
      animate: {
        x: [0, 1.5, 0],
        transition: { duration: 0.35, ease: "easeInOut" },
      },
    },
    line2: {
      initial: { x: 0 },
      animate: {
        x: [0, 1.5, 0],
        transition: { duration: 0.35, delay: 0.08, ease: "easeInOut" },
      },
    },
    line3: {
      initial: { x: 0 },
      animate: {
        x: [0, 1.5, 0],
        transition: { duration: 0.35, delay: 0.16, ease: "easeInOut" },
      },
    },
  } satisfies Record<string, Variants>,
} as const;

function IconComponent({ size, ...props }: ListChecksProps) {
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
      <motion.path d="M13 5h8" variants={variants.line1} initial="initial" animate={controls} />
      <motion.path d="M13 12h8" variants={variants.line2} initial="initial" animate={controls} />
      <motion.path d="M13 19h8" variants={variants.line3} initial="initial" animate={controls} />
      <motion.path d="m3 7 2 2 4-4" variants={variants.check1} initial="initial" animate={controls} />
      <motion.path d="m3 17 2 2 4-4" variants={variants.check2} initial="initial" animate={controls} />
    </motion.svg>
  );
}

function ListChecks(props: ListChecksProps) {
  return <IconWrapper icon={IconComponent} {...props} />;
}

export {
  animations,
  ListChecks,
  ListChecks as ListChecksIcon,
  type ListChecksProps,
  type ListChecksProps as ListChecksIconProps,
};
