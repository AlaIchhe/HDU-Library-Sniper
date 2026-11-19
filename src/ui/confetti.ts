import confetti from "canvas-confetti";

/**
 * Confetti — Magic UI 的 `canvas-confetti` 预设封装
 * https://magicui.design/docs/components/confetti
 *
 * 只在真正值得庆祝的时刻调用（预约成功、签到成功）；配色保持单色墨银 + 语义成功绿。
 */
const CELEBRATION_COLORS = ["#171717", "#525252", "#a3a3a3", "#e5e5e5", "#22c55e"];

function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** 从某个元素（或屏幕中下方）喷出一簇克制的纸屑。 */
export function fireConfetti(origin?: Element | null) {
  if (typeof window === "undefined" || reducedMotion()) return;
  let x = 0.5;
  let y = 0.68;
  if (origin) {
    const rect = origin.getBoundingClientRect();
    x = (rect.left + rect.width / 2) / window.innerWidth;
    y = (rect.top + rect.height / 2) / window.innerHeight;
  }
  void confetti({
    particleCount: 55,
    spread: 60,
    startVelocity: 32,
    scalar: 0.85,
    ticks: 150,
    origin: { x, y },
    colors: CELEBRATION_COLORS,
    disableForReducedMotion: true,
  });
}

/** 两侧礼花（Magic UI "Side Cannons" 预设），用于后台推送的预约成功。 */
export function fireSideCannons() {
  if (typeof window === "undefined" || reducedMotion()) return;
  const end = Date.now() + 900;
  const frame = () => {
    if (Date.now() > end) return;
    void confetti({
      particleCount: 2,
      angle: 60,
      spread: 50,
      startVelocity: 52,
      origin: { x: 0, y: 0.65 },
      colors: CELEBRATION_COLORS,
      disableForReducedMotion: true,
    });
    void confetti({
      particleCount: 2,
      angle: 120,
      spread: 50,
      startVelocity: 52,
      origin: { x: 1, y: 0.65 },
      colors: CELEBRATION_COLORS,
      disableForReducedMotion: true,
    });
    requestAnimationFrame(frame);
  };
  frame();
}
