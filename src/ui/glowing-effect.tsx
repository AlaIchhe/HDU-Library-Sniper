"use client";

import { animate } from "motion/react";
import { memo, useCallback, useEffect, useRef } from "react";

import { cn } from "@/lib/utils";

/**
 * Glowing Effect — Aceternity UI
 * https://ui.aceternity.com/components/glowing-effect
 *
 * 指针靠近时，卡片边框上有一段单色银灰/墨色光弧朝向指针滑动。
 * 父元素需要 `relative` 与圆角；粗指针（触屏）与减少动态效果时自动关闭。
 */
interface GlowingEffectProps {
  blur?: number;
  inactiveZone?: number;
  proximity?: number;
  spread?: number;
  glow?: boolean;
  className?: string;
  disabled?: boolean;
  movementDuration?: number;
  borderWidth?: number;
}

const MONOCHROME_GRADIENT = `repeating-conic-gradient(
  from 236.84deg at 50% 50%,
  var(--sheen-strong) 0%,
  var(--sheen) calc(25% / var(--repeating-conic-gradient-times)),
  var(--sheen-strong) calc(50% / var(--repeating-conic-gradient-times)),
  var(--sheen) calc(75% / var(--repeating-conic-gradient-times)),
  var(--sheen-strong) calc(100% / var(--repeating-conic-gradient-times))
)`;

export const GlowingEffect = memo(function GlowingEffect({
  blur = 0,
  inactiveZone = 0.65,
  proximity = 56,
  spread = 28,
  glow = false,
  className,
  movementDuration = 1.6,
  borderWidth = 1,
  disabled = false,
}: GlowingEffectProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const lastPosition = useRef({ x: 0, y: 0 });
  const animationFrameRef = useRef<number>(0);

  const handleMove = useCallback(
    (e?: PointerEvent | { x: number; y: number }) => {
      if (!containerRef.current) return;
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);

      animationFrameRef.current = requestAnimationFrame(() => {
        const element = containerRef.current;
        if (!element) return;

        const { left, top, width, height } = element.getBoundingClientRect();
        const mouseX = e?.x ?? lastPosition.current.x;
        const mouseY = e?.y ?? lastPosition.current.y;
        if (e) lastPosition.current = { x: mouseX, y: mouseY };

        const center = [left + width * 0.5, top + height * 0.5] as const;
        const distanceFromCenter = Math.hypot(mouseX - center[0], mouseY - center[1]);
        const inactiveRadius = 0.5 * Math.min(width, height) * inactiveZone;

        if (distanceFromCenter < inactiveRadius) {
          element.style.setProperty("--active", "0");
          return;
        }

        const isActive =
          mouseX > left - proximity &&
          mouseX < left + width + proximity &&
          mouseY > top - proximity &&
          mouseY < top + height + proximity;

        element.style.setProperty("--active", isActive ? "1" : "0");
        if (!isActive) return;

        const currentAngle = Number.parseFloat(element.style.getPropertyValue("--start")) || 0;
        const targetAngle = (180 * Math.atan2(mouseY - center[1], mouseX - center[0])) / Math.PI + 90;
        const angleDiff = ((targetAngle - currentAngle + 180) % 360) - 180;
        const newAngle = currentAngle + angleDiff;

        animate(currentAngle, newAngle, {
          duration: movementDuration,
          ease: [0.16, 1, 0.3, 1],
          onUpdate: (value) => element.style.setProperty("--start", String(value)),
        });
      });
    },
    [inactiveZone, proximity, movementDuration],
  );

  const off =
    disabled ||
    (typeof window !== "undefined" &&
      (window.matchMedia?.("(pointer: coarse)").matches ||
        window.matchMedia?.("(prefers-reduced-motion: reduce)").matches));

  useEffect(() => {
    if (off) return;
    const handleScroll = () => handleMove();
    const handlePointerMove = (e: PointerEvent) => handleMove(e);
    window.addEventListener("scroll", handleScroll, { passive: true });
    document.body.addEventListener("pointermove", handlePointerMove, { passive: true });
    return () => {
      if (animationFrameRef.current) cancelAnimationFrame(animationFrameRef.current);
      window.removeEventListener("scroll", handleScroll);
      document.body.removeEventListener("pointermove", handlePointerMove);
    };
  }, [handleMove, off]);

  if (off) return null;

  return (
    <div
      aria-hidden
      ref={containerRef}
      style={
        {
          "--blur": `${blur}px`,
          "--spread": spread,
          "--start": "0",
          "--active": "0",
          "--glowingeffect-border-width": `${borderWidth}px`,
          "--repeating-conic-gradient-times": "5",
          "--gradient": MONOCHROME_GRADIENT,
        } as React.CSSProperties
      }
      className={cn(
        "pointer-events-none absolute inset-0 rounded-[inherit] opacity-100 transition-opacity",
        glow && "opacity-100",
        blur > 0 && "blur-[var(--blur)]",
        className,
      )}
    >
      <div
        className={cn(
          "rounded-[inherit]",
          'after:absolute after:inset-[calc(-1*var(--glowingeffect-border-width))] after:rounded-[inherit] after:content-[""]',
          "after:[border:var(--glowingeffect-border-width)_solid_transparent]",
          "after:[background:var(--gradient)] after:[background-attachment:fixed]",
          "after:opacity-(--active) after:transition-opacity after:duration-300",
          "after:[mask-clip:padding-box,border-box]",
          "after:[mask-composite:intersect]",
          "after:[mask-image:linear-gradient(#0000,#0000),conic-gradient(from_calc((var(--start)-var(--spread))*1deg),#00000000_0deg,#fff,#00000000_calc(var(--spread)*2deg))]",
        )}
      />
    </div>
  );
});
