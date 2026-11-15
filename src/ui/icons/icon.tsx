"use client";

import {
  type LegacyAnimationControls,
  type SVGMotionProps,
  type UseInViewOptions,
  useAnimation,
  useInView,
  useReducedMotion,
  type Variants,
} from "motion/react";
import * as React from "react";

import { cn } from "../../lib/utils";

const staticAnimations = {
  path: {
    initial: { pathLength: 1 },
    animate: {
      pathLength: [0.05, 1],
      transition: {
        duration: 0.8,
        ease: "easeInOut",
      },
    },
  } as Variants,
  "path-loop": {
    initial: { pathLength: 1 },
    animate: {
      pathLength: [1, 0.05, 1],
      transition: {
        duration: 1.6,
        ease: "easeInOut",
      },
    },
  } as Variants,
} as const;

type StaticAnimations = keyof typeof staticAnimations;
type TriggerProp<T = string> = boolean | StaticAnimations | T;
type Trigger = TriggerProp<string>;

type AnimateIconContextValue = {
  controls: LegacyAnimationControls | undefined;
  animation: StaticAnimations | string;
  loop: boolean;
  loopDelay: number;
  active: boolean;
  animate?: Trigger;
  initialOnAnimateEnd?: boolean;
  completeOnStop?: boolean;
  persistOnAnimateEnd?: boolean;
  delay?: number;
};

type DefaultIconProps<T = string> = {
  animate?: TriggerProp<T>;
  animateOnHover?: TriggerProp<T>;
  animateOnTap?: TriggerProp<T>;
  animateOnView?: TriggerProp<T>;
  animateOnViewMargin?: UseInViewOptions["margin"];
  animateOnViewOnce?: boolean;
  animation?: T | StaticAnimations;
  loop?: boolean;
  loopDelay?: number;
  initialOnAnimateEnd?: boolean;
  completeOnStop?: boolean;
  persistOnAnimateEnd?: boolean;
  delay?: number;
};

type InteractiveElementProps = {
  onMouseEnter?: React.MouseEventHandler<HTMLElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLElement>;
  onPointerDown?: React.PointerEventHandler<HTMLElement>;
  onPointerUp?: React.PointerEventHandler<HTMLElement>;
  onPointerCancel?: React.PointerEventHandler<HTMLElement>;
  className?: string;
  style?: React.CSSProperties;
  ref?: React.Ref<HTMLElement>;
};

type AnimateIconProps<T = string> = DefaultIconProps<T> & {
  children: React.ReactNode;
  asChild?: boolean;
  className?: string;
  style?: React.CSSProperties;
};

type IconProps<T = string> = DefaultIconProps<T> &
  Omit<SVGMotionProps<SVGSVGElement>, "animate"> & {
    size?: number;
  };

type IconWrapperProps<T extends string = string> = IconProps<T> & {
  icon: React.ComponentType<IconProps<T>>;
};

// 触发属性收窄为 boolean | StaticAnimations，使各图标的窄动画联合类型均可协变赋值
type AnimatedIconComponent = React.ComponentType<IconProps<never>>;

const AnimateIconContext = React.createContext<AnimateIconContextValue | null>(null);

const FALLBACK_CONTEXT: AnimateIconContextValue = {
  controls: undefined,
  animation: "default",
  loop: false,
  loopDelay: 0,
  active: false,
  animate: undefined,
  initialOnAnimateEnd: undefined,
  completeOnStop: undefined,
  persistOnAnimateEnd: undefined,
  delay: undefined,
};

function useAnimateIconContext(): AnimateIconContextValue {
  const context = React.useContext(AnimateIconContext);
  return context ?? FALLBACK_CONTEXT;
}

function composeHandlers<E>(theirs?: (event: E) => void, ours?: (event: E) => void) {
  return (event: E) => {
    theirs?.(event);
    ours?.(event);
  };
}

function mergeRefs<T>(...refs: (React.Ref<T> | undefined)[]): React.RefCallback<T> {
  return (node) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === "function") {
        ref(node);
      } else {
        (ref as React.RefObject<T | null>).current = node;
      }
    }
  };
}

function AnimateIcon({
  asChild = false,
  animate = false,
  animateOnHover = false,
  animateOnTap = false,
  animateOnView = false,
  animateOnViewMargin = "0px",
  animateOnViewOnce = true,
  animation = "default",
  loop = false,
  loopDelay = 0,
  initialOnAnimateEnd = false,
  completeOnStop = false,
  persistOnAnimateEnd = false,
  delay = 0,
  className,
  style,
  children,
}: AnimateIconProps): React.ReactElement | null {
  const controls = useAnimation();
  const reduced = useReducedMotion();

  const [localAnimate, setLocalAnimate] = React.useState<boolean>(() => {
    if (reduced || animate === undefined || animate === false) return false;
    return delay <= 0;
  });
  const [currentAnimation, setCurrentAnimation] = React.useState<string | StaticAnimations>(
    typeof animate === "string" ? animate : animation,
  );
  const statusRef = React.useRef<"initial" | "animate">("initial");
  const delayRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const loopDelayRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const inProgressRef = React.useRef(false);
  const endPromiseRef = React.useRef<Promise<void> | null>(null);
  const resolveEndRef = React.useRef<(() => void) | null>(null);
  const activeRef = React.useRef(localAnimate);
  const runGenRef = React.useRef(0);
  const viewRef = React.useRef<HTMLElement | null>(null);

  const inViewResult = useInView(viewRef, {
    once: animateOnViewOnce,
    margin: animateOnViewMargin,
  });
  const isInView = !animateOnView || inViewResult;

  const clearTimers = React.useCallback(() => {
    if (delayRef.current) {
      clearTimeout(delayRef.current);
      delayRef.current = null;
    }
    if (loopDelayRef.current) {
      clearTimeout(loopDelayRef.current);
      loopDelayRef.current = null;
    }
  }, []);

  const startAnimation = React.useCallback(
    (trigger: TriggerProp) => {
      if (reduced) return;
      const next = typeof trigger === "string" ? trigger : animation;
      runGenRef.current += 1;
      clearTimers();
      setCurrentAnimation(next);
      if (delay > 0) {
        setLocalAnimate(false);
        delayRef.current = setTimeout(() => {
          setLocalAnimate(true);
        }, delay);
      } else {
        setLocalAnimate(true);
      }
    },
    [animation, clearTimers, delay, reduced],
  );

  const stopAnimation = React.useCallback(() => {
    runGenRef.current += 1;
    clearTimers();
    setLocalAnimate(false);
  }, [clearTimers]);

  React.useEffect(() => {
    activeRef.current = localAnimate;
  }, [localAnimate]);

  React.useEffect(() => {
    if (reduced) {
      stopAnimation();
      return;
    }
    if (animate === undefined) return;
    if (animate) startAnimation(animate as TriggerProp);
    else stopAnimation();
  }, [animate, reduced, startAnimation, stopAnimation]);

  React.useEffect(() => {
    if (!animateOnView || reduced) return;
    if (isInView) startAnimation(animateOnView);
    else stopAnimation();
  }, [animateOnView, isInView, reduced, startAnimation, stopAnimation]);

  React.useEffect(() => clearTimers, [clearTimers]);

  React.useEffect(() => {
    const gen = ++runGenRef.current;
    let cancelled = false;

    const startAnim = async (anim: "initial" | "animate", method: "start" | "set" = "start") => {
      try {
        await controls[method](anim);
        statusRef.current = anim;
      } catch {
        // 组件卸载或动画被中断时忽略
      }
    };

    async function run() {
      if (reduced || !localAnimate) {
        if (completeOnStop && inProgressRef.current && endPromiseRef.current) {
          try {
            await endPromiseRef.current;
          } catch {
            // noop
          }
        }
        if (!persistOnAnimateEnd || reduced) {
          await startAnim("initial");
        }
        return;
      }

      if (loop) {
        if (cancelled || gen !== runGenRef.current) return;
        await startAnim("initial", "set");
      }

      inProgressRef.current = true;
      endPromiseRef.current = new Promise<void>((resolve) => {
        resolveEndRef.current = resolve;
      });

      if (cancelled || gen !== runGenRef.current) {
        inProgressRef.current = false;
        resolveEndRef.current?.();
        resolveEndRef.current = null;
        endPromiseRef.current = null;
        return;
      }

      await startAnim("animate");

      inProgressRef.current = false;
      resolveEndRef.current?.();
      resolveEndRef.current = null;
      endPromiseRef.current = null;

      if (cancelled || gen !== runGenRef.current) return;

      if (initialOnAnimateEnd) {
        await startAnim("initial", "set");
      }

      if (loop && activeRef.current && !cancelled && gen === runGenRef.current) {
        if (loopDelay > 0) {
          await new Promise<void>((resolve) => {
            loopDelayRef.current = setTimeout(() => {
              loopDelayRef.current = null;
              resolve();
            }, loopDelay);
          });
        }
        if (cancelled || gen !== runGenRef.current) return;
        if (!activeRef.current) {
          if (statusRef.current !== "initial" && !persistOnAnimateEnd) {
            await startAnim("initial");
          }
          return;
        }
        await run();
      }
    }

    void run();

    return () => {
      cancelled = true;
      clearTimers();
    };
  }, [
    clearTimers,
    completeOnStop,
    controls,
    initialOnAnimateEnd,
    localAnimate,
    loop,
    loopDelay,
    persistOnAnimateEnd,
    reduced,
  ]);

  const onMouseEnter = React.useCallback(() => {
    if (animateOnHover) startAnimation(animateOnHover);
  }, [animateOnHover, startAnimation]);

  const onMouseLeave = React.useCallback(() => {
    if (animateOnHover || animateOnTap) stopAnimation();
  }, [animateOnHover, animateOnTap, stopAnimation]);

  const onPointerDown = React.useCallback(() => {
    if (animateOnTap) startAnimation(animateOnTap);
  }, [animateOnTap, startAnimation]);

  const onPointerUp = React.useCallback(() => {
    if (animateOnTap) stopAnimation();
  }, [animateOnTap, stopAnimation]);

  let content: React.ReactNode;
  if (asChild) {
    if (!React.isValidElement<InteractiveElementProps>(children)) {
      return null;
    }
    const childProps = children.props;
    const nextProps: InteractiveElementProps = {
      onMouseEnter: composeHandlers(childProps.onMouseEnter, onMouseEnter),
      onMouseLeave: composeHandlers(childProps.onMouseLeave, onMouseLeave),
      onPointerDown: composeHandlers(childProps.onPointerDown, onPointerDown),
      onPointerUp: composeHandlers(childProps.onPointerUp, onPointerUp),
      onPointerCancel: composeHandlers(childProps.onPointerCancel, onPointerUp),
    };
    if (className || childProps.className) {
      nextProps.className = cn(childProps.className, className);
    }
    if (style || childProps.style) {
      nextProps.style = { ...childProps.style, ...style };
    }
    if (animateOnView) {
      nextProps.ref = mergeRefs(childProps.ref, viewRef);
    }
    content = React.cloneElement(children, nextProps);
  } else {
    content = (
      // biome-ignore lint/a11y/noStaticElementInteractions: 纯视觉悬停触发容器，非独立交互控件
      <span
        ref={
          animateOnView
            ? (node) => {
                viewRef.current = node;
              }
            : undefined
        }
        className={cn("inline-flex items-center justify-center", className)}
        style={style}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
        onPointerDown={onPointerDown}
        onPointerUp={onPointerUp}
        onPointerCancel={onPointerUp}
      >
        {children}
      </span>
    );
  }

  return (
    <AnimateIconContext.Provider
      value={{
        controls,
        animation: currentAnimation,
        loop,
        loopDelay,
        active: localAnimate,
        animate,
        initialOnAnimateEnd,
        completeOnStop,
        persistOnAnimateEnd,
        delay,
      }}
    >
      {content}
    </AnimateIconContext.Provider>
  );
}

const pathClassName = "[&_[stroke-dasharray='1px_1px']]:![stroke-dasharray:1px_0px]";

function IconWrapper<T extends string>({
  size = 24,
  animation: animationProp,
  animate,
  animateOnHover,
  animateOnTap,
  animateOnView,
  animateOnViewMargin,
  animateOnViewOnce,
  icon: IconComponent,
  loop,
  loopDelay,
  persistOnAnimateEnd,
  initialOnAnimateEnd,
  delay,
  completeOnStop,
  className,
  ...props
}: IconWrapperProps<T>): React.ReactElement {
  const context = React.useContext(AnimateIconContext);

  if (context) {
    const {
      controls,
      animation: parentAnimation,
      loop: parentLoop,
      loopDelay: parentLoopDelay,
      active: parentActive,
      animate: parentAnimate,
      persistOnAnimateEnd: parentPersistOnAnimateEnd,
      initialOnAnimateEnd: parentInitialOnAnimateEnd,
      delay: parentDelay,
      completeOnStop: parentCompleteOnStop,
    } = context;

    const hasOverrides =
      animate !== undefined ||
      animateOnHover !== undefined ||
      animateOnTap !== undefined ||
      animateOnView !== undefined ||
      loop !== undefined ||
      loopDelay !== undefined ||
      initialOnAnimateEnd !== undefined ||
      persistOnAnimateEnd !== undefined ||
      delay !== undefined ||
      completeOnStop !== undefined;

    if (hasOverrides) {
      const inheritedAnimate: Trigger = parentActive
        ? (animationProp ?? parentAnimation ?? "default")
        : false;
      const finalAnimate: Trigger = (animate ?? parentAnimate ?? inheritedAnimate) as Trigger;
      const resolvedAnimation = animationProp ?? parentAnimation;

      return (
        <AnimateIcon
          animate={finalAnimate}
          animateOnHover={animateOnHover}
          animateOnTap={animateOnTap}
          animateOnView={animateOnView}
          animateOnViewMargin={animateOnViewMargin}
          animateOnViewOnce={animateOnViewOnce}
          animation={resolvedAnimation}
          loop={loop ?? parentLoop}
          loopDelay={loopDelay ?? parentLoopDelay}
          persistOnAnimateEnd={persistOnAnimateEnd ?? parentPersistOnAnimateEnd}
          initialOnAnimateEnd={initialOnAnimateEnd ?? parentInitialOnAnimateEnd}
          delay={delay ?? parentDelay}
          completeOnStop={completeOnStop ?? parentCompleteOnStop}
          asChild
        >
          <IconComponent
            size={size}
            className={cn(
              className,
              (resolvedAnimation === "path" || resolvedAnimation === "path-loop") && pathClassName,
            )}
            {...props}
          />
        </AnimateIcon>
      );
    }

    const animationToUse = animationProp ?? parentAnimation;

    return (
      <AnimateIconContext.Provider
        value={{
          controls,
          animation: animationToUse,
          loop: parentLoop,
          loopDelay: parentLoopDelay,
          active: parentActive,
          animate: parentAnimate,
          initialOnAnimateEnd: parentInitialOnAnimateEnd,
          delay: parentDelay,
          completeOnStop: parentCompleteOnStop,
        }}
      >
        <IconComponent
          size={size}
          className={cn(
            className,
            (animationToUse === "path" || animationToUse === "path-loop") && pathClassName,
          )}
          {...props}
        />
      </AnimateIconContext.Provider>
    );
  }

  if (
    animate !== undefined ||
    animateOnHover !== undefined ||
    animateOnTap !== undefined ||
    animateOnView !== undefined ||
    animationProp !== undefined
  ) {
    return (
      <AnimateIcon
        animate={animate}
        animateOnHover={animateOnHover}
        animateOnTap={animateOnTap}
        animateOnView={animateOnView}
        animateOnViewMargin={animateOnViewMargin}
        animateOnViewOnce={animateOnViewOnce}
        animation={animationProp}
        loop={loop}
        loopDelay={loopDelay}
        persistOnAnimateEnd={persistOnAnimateEnd}
        initialOnAnimateEnd={initialOnAnimateEnd}
        delay={delay}
        completeOnStop={completeOnStop}
        asChild
      >
        <IconComponent
          size={size}
          className={cn(
            className,
            (animationProp === "path" || animationProp === "path-loop") && pathClassName,
          )}
          {...props}
        />
      </AnimateIcon>
    );
  }

  return (
    <IconComponent
      size={size}
      className={cn(className, (animationProp === "path" || animationProp === "path-loop") && pathClassName)}
      {...props}
    />
  );
}

function useIconVariants<V extends { default: T; [key: string]: T }, T extends Record<string, Variants>>(
  animations: V,
): T {
  const { animation: animationType } = useAnimateIconContext();

  if (animationType in staticAnimations) {
    const variant = staticAnimations[animationType as StaticAnimations];
    const result = {} as T;
    for (const key in animations.default) {
      if ((animationType === "path" || animationType === "path-loop") && key.includes("group")) {
        continue;
      }
      result[key] = variant as unknown as T[Extract<keyof T, string>];
    }
    return result;
  }

  return (animations[animationType as keyof V] as T) ?? animations.default;
}

export {
  pathClassName,
  staticAnimations,
  AnimateIcon,
  IconWrapper,
  useAnimateIconContext,
  useIconVariants,
  type AnimateIconContextValue,
  type AnimateIconProps,
  type AnimatedIconComponent,
  type IconProps,
  type IconWrapperProps,
};
