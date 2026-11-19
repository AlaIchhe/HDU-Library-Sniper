"use client";

import { useEffect, useRef } from "react";

/**
 * Click Spark — React Bits
 * https://reactbits.dev/animations/click-spark
 *
 * 全视口固定画布 + 全局 pointerdown，只在有火花时才跑动画帧，静止时零开销。
 * 颜色取当前主题的 --foreground（中性单色），极低透明度点缀点击手感。
 */
interface ClickSparkProps {
  sparkSize?: number;
  sparkRadius?: number;
  sparkCount?: number;
  duration?: number;
  extraScale?: number;
}

type Spark = { x: number; y: number; angle: number; startTime: number; color: string };

const easeOut = (t: number) => t * (2 - t);

export function ClickSpark({
  sparkSize = 7,
  sparkRadius = 15,
  sparkCount = 8,
  duration = 360,
  extraScale = 1,
}: ClickSparkProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;

    let sparks: Spark[] = [];
    let frame = 0;
    let dpr = window.devicePixelRatio || 1;

    const resize = () => {
      dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(window.innerWidth * dpr);
      canvas.height = Math.floor(window.innerHeight * dpr);
      canvas.style.width = `${window.innerWidth}px`;
      canvas.style.height = `${window.innerHeight}px`;
    };
    resize();

    const draw = (timestamp: number) => {
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      sparks = sparks.filter((spark) => {
        const elapsed = timestamp - spark.startTime;
        if (elapsed >= duration) return false;
        const eased = easeOut(elapsed / duration);
        const distance = eased * sparkRadius * extraScale;
        const lineLength = sparkSize * (1 - eased);
        const x1 = spark.x + distance * Math.cos(spark.angle);
        const y1 = spark.y + distance * Math.sin(spark.angle);
        const x2 = spark.x + (distance + lineLength) * Math.cos(spark.angle);
        const y2 = spark.y + (distance + lineLength) * Math.sin(spark.angle);
        ctx.save();
        ctx.globalAlpha = 0.34 * (1 - eased);
        ctx.strokeStyle = spark.color;
        ctx.lineWidth = 1.5;
        ctx.lineCap = "round";
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
        ctx.restore();
        return true;
      });
      frame = sparks.length ? requestAnimationFrame(draw) : 0;
    };

    const onPointerDown = (event: PointerEvent) => {
      if (event.button !== 0) return;
      const color = getComputedStyle(document.documentElement).color || "currentColor";
      const now = performance.now();
      for (let i = 0; i < sparkCount; i++) {
        sparks.push({
          x: event.clientX,
          y: event.clientY,
          angle: (2 * Math.PI * i) / sparkCount,
          startTime: now,
          color,
        });
      }
      if (!frame) frame = requestAnimationFrame(draw);
    };

    window.addEventListener("resize", resize);
    window.addEventListener("pointerdown", onPointerDown, { passive: true });
    return () => {
      window.removeEventListener("resize", resize);
      window.removeEventListener("pointerdown", onPointerDown);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [sparkSize, sparkRadius, sparkCount, duration, extraScale]);

  return <canvas ref={canvasRef} aria-hidden className="pointer-events-none fixed inset-0 z-[100]" />;
}
