"use client";

import { motion, type Variants } from "motion/react";

import { useIconVariants, IconWrapper, type IconProps, useAnimateIconContext } from "./icon";

type CircleArrowUpProps = IconProps<keyof typeof animations>;

const animations = {
  default: {
    circle: {},
    arrow: {
      initial: { y: 0 },
      animate: {
        y: [0, -2.5, 0],
        transition: { duration: 0.55, ease: "easeInOut" },
      },
    },
  } satisfies Record<string, Variants>,
} as const;

function IconComponent({ size, ...props }: CircleArrowUpProps) {
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
      <motion.circle cx={12} cy={12} r={10} variants={variants.circle} initial="initial" animate={controls} />
      <motion.g variants={variants.arrow} initial="initial" animate={controls}>
        <path d="m16 12-4-4-4 4" />
        <path d="M12 16V8" />
      </motion.g>
    </motion.svg>
  );
}

function CircleArrowUp(props: CircleArrowUpProps) {
  return <IconWrapper icon={IconComponent} {...props} />;
}

export {
  animations,
  CircleArrowUp,
  CircleArrowUp as CircleArrowUpIcon,
  type CircleArrowUpProps,
  type CircleArrowUpProps as CircleArrowUpIconProps,
};
