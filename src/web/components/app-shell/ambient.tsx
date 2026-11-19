"use client"

import { AnimatedGridPattern } from "@/ui/animated-grid-pattern"
import { LightRays } from "@/ui/light-rays"
import { Spotlight } from "@/ui/spotlight"

/**
 * 工作台单色环境层（固定在内容之下，不接收指针）：
 * - Aceternity Spotlight：左上角斜向单色柔光；
 * - Magic UI Light Rays：极淡中性银白光线；
 * - Magic UI Animated Grid Pattern：中心淡出的方格，偶尔亮起几格。
 * 全程保持无彩色（0 chroma）极简基调，只增强空间层次、不抢正文。
 */
export function Ambient() {
  return (
    <div aria-hidden className="pointer-events-none fixed inset-0 -z-10 overflow-hidden">
      <Spotlight className="-top-40 left-0 text-foreground/[0.32] md:-top-20 md:left-40 dark:text-white/55" />
      <LightRays count={5} color="rgba(160, 160, 168, 0.09)" blur={30} speed={18} className="fixed inset-0" />
      <AnimatedGridPattern
        numSquares={18}
        maxOpacity={0.055}
        className="fixed inset-0 [mask-image:radial-gradient(ellipse_at_center,white,transparent_72%)]"
      />
    </div>
  )
}
