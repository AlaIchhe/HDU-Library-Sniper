"use client";

import { motion, type Variants } from "motion/react";

import { useIconVariants, IconWrapper, type IconProps, useAnimateIconContext } from "./icon";

type CommandProps = IconProps<keyof typeof animations>;

const animations = {
  default: {
    group: {
      initial: { scale: 1 },
      animate: {
        scale: [1, 1.08, 1],
        transition: { duration: 0.45, ease: "easeInOut" },
      },
    },
    path: {
      initial: { pathLength: 1 },
      animate: {
        pathLength: [0.35, 1],
        transition: { duration: 0.55, ease: "easeInOut" },
      },
    },
  } satisfies Record<string, Variants>,
} as const;

function IconComponent({ size, ...props }: CommandProps) {
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
      variants={variants.group}
      initial="initial"
      animate={controls}
      {...props}
    >
      <motion.path
        d="M15 6v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3V6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3"
        variants={variants.path}
        initial="initial"
        animate={controls}
      />
    </motion.svg>
  );
}

function Command(props: CommandProps) {
  return <IconWrapper icon={IconComponent} {...props} />;
}

export {
  animations,
  Command,
  Command as CommandIcon,
  type CommandProps,
  type CommandProps as CommandIconProps,
};
