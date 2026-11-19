"use client";

import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Decrypted Text — React Bits
 * https://reactbits.dev/text-animations/decrypted-text
 *
 * 乱码逐位「解密」成原文。默认静止渲染为单节点纯文本，悬停时触发一次轻快的单色解密波动；
 * 读屏始终只读原文，不产生重复文本节点。
 */
type DecryptedTextProps = {
  text: string;
  speed?: number;
  maxIterations?: number;
  sequential?: boolean;
  revealDirection?: "start" | "end" | "center";
  characters?: string;
  className?: string;
  encryptedClassName?: string;
  animateOn?: "view" | "hover" | "both";
};

const DEFAULT_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789·/—+";

export function DecryptedText({
  text,
  speed = 36,
  maxIterations = 10,
  sequential = true,
  revealDirection = "start",
  characters = DEFAULT_CHARS,
  className,
  encryptedClassName = "text-foreground/45",
  animateOn = "hover",
}: DecryptedTextProps) {
  const [displayText, setDisplayText] = useState(text);
  const [isScrambling, setIsScrambling] = useState(false);
  const [revealed, setRevealed] = useState<Set<number>>(() => new Set(text.split("").map((_, i) => i)));
  const [run, setRun] = useState(0);
  const ref = useRef<HTMLSpanElement>(null);
  const scramblingRef = useRef(false);

  useEffect(() => {
    scramblingRef.current = isScrambling;
  }, [isScrambling]);

  useEffect(() => {
    if (animateOn === "view") return;
    const node = ref.current;
    if (!node) return;
    const onEnter = () => {
      if (scramblingRef.current) return;
      setRevealed(new Set());
      setRun((r) => r + 1);
    };
    node.addEventListener("mouseenter", onEnter);
    return () => node.removeEventListener("mouseenter", onEnter);
  }, [animateOn]);

  useEffect(() => {
    if (run === 0) return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    let iteration = 0;
    const revealedSet = new Set<number>();
    setIsScrambling(true);

    const nextIndex = (size: number) => {
      const len = text.length;
      if (revealDirection === "end") return len - 1 - size;
      if (revealDirection === "center") {
        const middle = Math.floor(len / 2);
        const offset = Math.floor(size / 2);
        return size % 2 === 0 ? middle + offset : middle - offset - 1;
      }
      return size;
    };

    const scramble = (keep: Set<number>) =>
      text
        .split("")
        .map((char, i) =>
          char === " " || keep.has(i) ? char : characters[Math.floor(Math.random() * characters.length)],
        )
        .join("");

    const interval = setInterval(() => {
      if (sequential) {
        if (revealedSet.size < text.length) {
          revealedSet.add(nextIndex(revealedSet.size));
          setRevealed(new Set(revealedSet));
          setDisplayText(scramble(revealedSet));
        } else {
          clearInterval(interval);
          setIsScrambling(false);
        }
      } else {
        setDisplayText(scramble(revealedSet));
        iteration++;
        if (iteration >= maxIterations) {
          clearInterval(interval);
          setIsScrambling(false);
          setDisplayText(text);
        }
      }
    }, speed);

    return () => {
      clearInterval(interval);
      setDisplayText(text);
      setRevealed(new Set(text.split("").map((_, i) => i)));
      setIsScrambling(false);
    };
  }, [run, text, speed, maxIterations, sequential, revealDirection, characters]);

  useEffect(() => {
    if (animateOn === "hover") return;
    setRevealed(new Set());
    setRun((r) => r + 1);
  }, [animateOn]);

  return (
    <span ref={ref} className={cn("inline-block whitespace-pre-wrap", className)}>
      {isScrambling ? (
        <>
          <span className="sr-only">{text}</span>
          <span aria-hidden>
            {displayText.split("").map((char, index) => (
              <span
                // biome-ignore lint/suspicious/noArrayIndexKey: 字符位置即身份
                key={index}
                className={cn(!revealed.has(index) && encryptedClassName)}
              >
                {char}
              </span>
            ))}
          </span>
        </>
      ) : (
        text
      )}
    </span>
  );
}
