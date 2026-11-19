import { type ComponentPropsWithoutRef, type CSSProperties, memo } from "react";

import { cn } from "@/lib/utils";

/**
 * Ripple — Magic UI
 * https://magicui.design/docs/components/ripple
 *
 * 一圈圈缓慢呼吸的同心圆，放在空状态图标后面做背景。
 */
interface RippleProps extends ComponentPropsWithoutRef<"div"> {
  mainCircleSize?: number;
  mainCircleOpacity?: number;
  numCircles?: number;
}

export const Ripple = memo(function Ripple({
  mainCircleSize = 160,
  mainCircleOpacity = 0.2,
  numCircles = 6,
  className,
  ...props
}: RippleProps) {
  return (
    <div
      aria-hidden
      className={cn(
        "pointer-events-none absolute inset-0 select-none [mask-image:radial-gradient(circle,white,transparent_70%)]",
        className,
      )}
      {...props}
    >
      {Array.from({ length: numCircles }, (_, i) => {
        const size = mainCircleSize + i * 64;
        const opacity = mainCircleOpacity - i * 0.03;
        return (
          <div
            // biome-ignore lint/suspicious/noArrayIndexKey: 纯装饰，顺序固定
            key={i}
            className="absolute animate-ripple rounded-full border bg-foreground/[0.04] shadow-xl"
            style={
              {
                "--i": i,
                width: `${size}px`,
                height: `${size}px`,
                opacity,
                animationDelay: `${i * 0.06}s`,
                borderStyle: "solid",
                borderWidth: "1px",
                borderColor: `color-mix(in oklch, var(--foreground) ${Math.max(4, 14 - i * 2)}%, transparent)`,
                top: "50%",
                left: "50%",
                transform: "translate(-50%, -50%) scale(1)",
              } as CSSProperties
            }
          />
        );
      })}
    </div>
  );
});
