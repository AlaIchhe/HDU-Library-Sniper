"use client";

import { motion, type Variants } from "motion/react";

import { useIconVariants, IconWrapper, type IconProps, useAnimateIconContext } from "./icon";

type QrCodeProps = IconProps<keyof typeof animations>;

const animations = {
  default: {
    rect1: {
      initial: { scale: 1 },
      animate: {
        scale: [1, 1.15, 1],
        transition: { duration: 0.35, ease: "easeInOut" },
      },
    },
    rect2: {
      initial: { scale: 1 },
      animate: {
        scale: [1, 1.15, 1],
        transition: { duration: 0.35, delay: 0.1, ease: "easeInOut" },
      },
    },
    rect3: {
      initial: { scale: 1 },
      animate: {
        scale: [1, 1.15, 1],
        transition: { duration: 0.35, delay: 0.2, ease: "easeInOut" },
      },
    },
    matrix: {
      initial: { opacity: 1 },
      animate: {
        opacity: [1, 0.45, 1],
        transition: { duration: 0.55, delay: 0.08, ease: "easeInOut" },
      },
    },
  } satisfies Record<string, Variants>,
} as const;

function IconComponent({ size, ...props }: QrCodeProps) {
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
      <motion.rect
        width={5}
        height={5}
        x={3}
        y={3}
        rx={1}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        variants={variants.rect1}
        initial="initial"
        animate={controls}
      />
      <motion.rect
        width={5}
        height={5}
        x={16}
        y={3}
        rx={1}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        variants={variants.rect2}
        initial="initial"
        animate={controls}
      />
      <motion.rect
        width={5}
        height={5}
        x={3}
        y={16}
        rx={1}
        style={{ transformBox: "fill-box", transformOrigin: "center" }}
        variants={variants.rect3}
        initial="initial"
        animate={controls}
      />
      <motion.g variants={variants.matrix} initial="initial" animate={controls}>
        <path d="M21 16h-3a2 2 0 0 0-2 2v3" />
        <path d="M21 21v.01" />
        <path d="M12 7v3a2 2 0 0 1-2 2H7" />
        <path d="M3 12h.01" />
        <path d="M12 3h.01" />
        <path d="M12 16v.01" />
        <path d="M16 12h1" />
        <path d="M21 12v.01" />
        <path d="M12 21v-1" />
      </motion.g>
    </motion.svg>
  );
}

function QrCode(props: QrCodeProps) {
  return <IconWrapper icon={IconComponent} {...props} />;
}

export { animations, QrCode, QrCode as QrCodeIcon, type QrCodeProps, type QrCodeProps as QrCodeIconProps };
