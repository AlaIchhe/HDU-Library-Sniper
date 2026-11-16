"use client";

import {
  type LegacyAnimationControls,
  type SVGMotionProps,
  useAnimation,
  useReducedMotion,
  type Variants,
} from "motion/react";
import * as React from "react";

import { cn } from "../../lib/utils";

type TriggerProp<T = string> = boolean | T;

type AnimateIconContextValue = {
  controls: LegacyAnimationControls | undefined;
  animation: string;
  active: boolean;
  animate?: TriggerProp;
};

type DefaultIconProps<T = string> = {
  animate?: TriggerProp<T>;
  animateOnHover?: TriggerProp<T>;
  animation?: T;
};

type InteractiveElementProps = {
  onMouseEnter?: React.MouseEventHandler<HTMLElement>;
  onMouseLeave?: React.MouseEventHandler<HTMLElement>;
  className?: string;
  style?: React.CSSProperties;
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

// 触发属性收窄为 boolean，使各图标的窄动画联合类型均可协变赋值
type AnimatedIconComponent = React.ComponentType<IconProps<never>>;

const AnimateIconContext = React.createContext<AnimateIconContextValue | null>(null);

const FALLBACK_CONTEXT: AnimateIconContextValue = {
  controls: undefined,
  animation: "default",
  active: false,
  animate: undefined,
};

function useAnimateIconContext(): AnimateIconContextValue {
  return React.useContext(AnimateIconContext) ?? FALLBACK_CONTEXT;
}

function composeHandlers<E>(theirs?: (event: E) => void, ours?: (event: E) => void) {
  return (event: E) => {
    theirs?.(event);
    ours?.(event);
  };
}

function AnimateIcon({
  asChild = false,
  animate = false,
  animateOnHover = false,
  animation = "default",
  className,
  style,
  children,
}: AnimateIconProps): React.ReactElement | null {
  const controls = useAnimation();
  const reduced = useReducedMotion();

  const [localAnimate, setLocalAnimate] = React.useState<boolean>(() => !reduced && Boolean(animate));
  const [currentAnimation, setCurrentAnimation] = React.useState<string>(
    typeof animate === "string" ? animate : animation,
  );

  React.useEffect(() => {
    if (reduced) {
      setLocalAnimate(false);
      return;
    }
    if (animate === undefined) return;
    if (animate) {
      setCurrentAnimation(typeof animate === "string" ? animate : animation);
      setLocalAnimate(true);
    } else {
      setLocalAnimate(false);
    }
  }, [animate, animation, reduced]);

  React.useEffect(() => {
    void controls.start(!reduced && localAnimate ? "animate" : "initial").catch(() => {});
  }, [controls, localAnimate, reduced]);

  const onMouseEnter = React.useCallback(() => {
    if (!animateOnHover || reduced) return;
    setCurrentAnimation(typeof animateOnHover === "string" ? animateOnHover : animation);
    setLocalAnimate(true);
  }, [animateOnHover, animation, reduced]);

  const onMouseLeave = React.useCallback(() => {
    if (animateOnHover) setLocalAnimate(false);
  }, [animateOnHover]);

  let content: React.ReactNode;
  if (asChild) {
    if (!React.isValidElement<InteractiveElementProps>(children)) {
      return null;
    }
    const childProps = children.props;
    const nextProps: InteractiveElementProps = {
      onMouseEnter: composeHandlers(childProps.onMouseEnter, onMouseEnter),
      onMouseLeave: composeHandlers(childProps.onMouseLeave, onMouseLeave),
    };
    if (className || childProps.className) {
      nextProps.className = cn(childProps.className, className);
    }
    if (style || childProps.style) {
      nextProps.style = { ...childProps.style, ...style };
    }
    content = React.cloneElement(children, nextProps);
  } else {
    content = (
      // biome-ignore lint/a11y/noStaticElementInteractions: 纯视觉悬停触发容器，非独立交互控件
      <span
        className={cn("inline-flex items-center justify-center", className)}
        style={style}
        onMouseEnter={onMouseEnter}
        onMouseLeave={onMouseLeave}
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
        active: localAnimate,
        animate,
      }}
    >
      {content}
    </AnimateIconContext.Provider>
  );
}

function IconWrapper<T extends string>({
  size = 24,
  animation: animationProp,
  animate,
  animateOnHover,
  icon: IconComponent,
  className,
  ...props
}: IconWrapperProps<T>): React.ReactElement {
  const context = React.useContext(AnimateIconContext);

  if (context) {
    const { controls, animation: parentAnimation, active: parentActive, animate: parentAnimate } = context;

    if (animate !== undefined || animateOnHover !== undefined) {
      const inheritedAnimate = parentActive ? (animationProp ?? parentAnimation ?? "default") : false;
      const finalAnimate = animate ?? parentAnimate ?? inheritedAnimate;

      return (
        <AnimateIcon
          animate={finalAnimate as TriggerProp}
          animateOnHover={animateOnHover}
          animation={animationProp ?? parentAnimation}
          asChild
        >
          <IconComponent size={size} className={className} {...props} />
        </AnimateIcon>
      );
    }

    return (
      <AnimateIconContext.Provider
        value={{
          controls,
          animation: animationProp ?? parentAnimation,
          active: parentActive,
          animate: parentAnimate,
        }}
      >
        <IconComponent size={size} className={className} {...props} />
      </AnimateIconContext.Provider>
    );
  }

  if (animate !== undefined || animateOnHover !== undefined || animationProp !== undefined) {
    return (
      <AnimateIcon animate={animate} animateOnHover={animateOnHover} animation={animationProp} asChild>
        <IconComponent size={size} className={className} {...props} />
      </AnimateIcon>
    );
  }

  return <IconComponent size={size} className={className} {...props} />;
}

function useIconVariants<V extends { default: T; [key: string]: T }, T extends Record<string, Variants>>(
  animations: V,
): T {
  const { animation: animationType } = useAnimateIconContext();
  return (animations[animationType as keyof V] as T) ?? animations.default;
}

export {
  AnimateIcon,
  IconWrapper,
  useAnimateIconContext,
  useIconVariants,
  type AnimateIconProps,
  type AnimatedIconComponent,
  type IconProps,
};
