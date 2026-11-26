import { useCallback, useEffect, useRef } from "react";
import { flushSync } from "react-dom";

import { cn } from "@/lib/utils";
import { AnimateIcon, Moon, Sun } from "@/ui/icons";

interface AnimatedThemeTogglerProps extends React.ComponentPropsWithoutRef<"button"> {
  duration?: number;
  theme: "light" | "dark";
  onThemeChange: (theme: "light" | "dark") => void;
}

export const AnimatedThemeToggler = ({
  className,
  duration = 400,
  theme,
  onThemeChange,
  ...props
}: AnimatedThemeTogglerProps) => {
  const isDark = theme === "dark";
  const buttonRef = useRef<HTMLButtonElement>(null);
  const isTransitioningRef = useRef(false);
  const activeAnimRef = useRef<Animation | null>(null);

  const cancelAnim = useCallback(() => {
    activeAnimRef.current?.cancel();
    activeAnimRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      cancelAnim();
      const root = document.documentElement;
      if (root.dataset.magicuiThemeVt !== "active") return;
      delete root.dataset.magicuiThemeVt;
      root.style.removeProperty("--magicui-theme-toggle-vt-duration");
      root.style.removeProperty("--magicui-theme-vt-clip-from");
    };
  }, [cancelAnim]);

  const toggleTheme = useCallback(() => {
    const button = buttonRef.current;
    if (!button || isTransitioningRef.current || document.documentElement.dataset.magicuiThemeVt === "active")
      return;

    const viewportWidth = window.innerWidth;
    const viewportHeight = window.innerHeight;
    const { top, left, width, height } = button.getBoundingClientRect();
    const x = left + width / 2;
    const y = top + height / 2;
    const maxRadius = Math.hypot(Math.max(x, viewportWidth - x), Math.max(y, viewportHeight - y));
    const toPct = (v: number, total: number) => `${(v / total) * 100}%`;
    const toRadius = (r: number) =>
      `${(r / (Math.hypot(viewportWidth, viewportHeight) / Math.SQRT2)) * 100}%`;
    const at = `${toPct(x, viewportWidth)} ${toPct(y, viewportHeight)}`;
    const clipPath = [`circle(0% at ${at})`, `circle(${toRadius(maxRadius)} at ${at})`];

    const applyTheme = () => {
      const nextTheme = isDark ? "light" : "dark";
      document.documentElement.classList.toggle("dark", nextTheme === "dark");
      onThemeChange(nextTheme);
    };

    const prefersReducedMotion =
      typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (prefersReducedMotion || typeof document.startViewTransition !== "function") {
      applyTheme();
      return;
    }

    const root = document.documentElement;
    root.dataset.magicuiThemeVt = "active";
    root.style.setProperty("--magicui-theme-toggle-vt-duration", `${duration}ms`);
    root.style.setProperty("--magicui-theme-vt-clip-from", clipPath[0]);
    const cleanup = () => {
      isTransitioningRef.current = false;
      delete root.dataset.magicuiThemeVt;
      root.style.removeProperty("--magicui-theme-toggle-vt-duration");
      root.style.removeProperty("--magicui-theme-vt-clip-from");
      cancelAnim();
    };

    isTransitioningRef.current = true;
    const transition = document.startViewTransition(() => {
      flushSync(applyTheme);
    });
    if (typeof transition?.finished?.finally === "function") {
      transition.finished.finally(cleanup).catch(() => {});
    } else {
      cleanup();
    }

    transition?.ready
      ?.then(() => {
        activeAnimRef.current = document.documentElement.animate(
          { clipPath },
          { duration, easing: "ease-in-out", fill: "forwards", pseudoElement: "::view-transition-new(root)" },
        );
      })
      .catch(() => {});
  }, [duration, isDark, onThemeChange, cancelAnim]);

  return (
    <AnimateIcon animateOnHover asChild>
      <button type="button" ref={buttonRef} onClick={toggleTheme} className={cn(className)} {...props}>
        <span className="relative grid size-4 place-items-center">
          <span
            aria-hidden={!isDark}
            className={cn(
              "col-start-1 row-start-1 inline-flex transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              isDark ? "scale-100 rotate-0 opacity-100" : "pointer-events-none scale-75 -rotate-45 opacity-0",
            )}
          >
            <Sun />
          </span>
          <span
            aria-hidden={isDark}
            className={cn(
              "col-start-1 row-start-1 inline-flex transition-[opacity,transform] duration-300 ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none",
              !isDark ? "scale-100 rotate-0 opacity-100" : "pointer-events-none scale-75 rotate-45 opacity-0",
            )}
          >
            <Moon />
          </span>
        </span>
        <span className="sr-only">{isDark ? "切换到浅色主题" : "切换到深色主题"}</span>
      </button>
    </AnimateIcon>
  );
};
