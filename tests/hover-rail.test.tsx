import { act } from "react";
import { createRoot } from "react-dom/client";
import { RouterProvider, createMemoryHistory, createRootRoute, createRouter } from "@tanstack/react-router";
import { afterEach, describe, expect, test } from "vitest";

import { HoverRail } from "../src/web/components/hover-rail";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let activeUnmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (activeUnmount) {
    await activeUnmount();
    activeUnmount = null;
  }
});

async function mountRail() {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  activeUnmount = async () => {
    await act(async () => {
      root.unmount();
    });
    container.remove();
  };
  const routeTree = createRootRoute({
    component: () => <HoverRail plansActive bookingsActive={false} runtimeState="running" />,
  });
  const router = createRouter({
    routeTree,
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  await act(async () => {
    root.render(<RouterProvider router={router} />);
  });
  const rail = container.querySelector("aside") as HTMLElement;
  if (!rail) throw new Error("rail not rendered");
  return rail;
}

/** 派发一个指针事件，可指定 pointerType（happy-dom 默认不带）。 */
async function firePointer(el: HTMLElement, type: string, pointerType = "mouse") {
  // happy-dom 没有 PointerEvent；React 的 pointerenter 走非冒泡路径，
  // 用 MouseEvent 并补上 pointerType 即可触发对应 handler。
  // React 把 pointerenter/pointerleave 实现为在 pointerover/pointerout 上做
  // "从外部进入" 的判定，因此这里派发冒泡的 pointerover/pointerout。
  const nativeType = type === "pointerenter" ? "pointerover" : type === "pointerleave" ? "pointerout" : type;
  const event = new MouseEvent(nativeType, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "pointerType", { value: pointerType });
  if (type === "pointerover" || nativeType === "pointerover") {
    Object.defineProperty(event, "relatedTarget", { value: null });
  }
  if (nativeType === "pointerout") {
    Object.defineProperty(event, "relatedTarget", { value: null });
  }
  await act(async () => {
    el.dispatchEvent(event);
  });
}

async function advance(ms: number) {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms));
  });
}

describe("HoverRail interaction", () => {
  test("expands on mouse enter and collapses on leave", async () => {
    const rail = await mountRail();
    expect(rail.dataset.expanded).toBe("false");

    await firePointer(rail, "pointerenter");
    await advance(200);
    expect(rail.dataset.expanded).toBe("true");

    await firePointer(rail, "pointerleave");
    await advance(260);
    expect(rail.dataset.expanded).toBe("false");
  });

  test("stays expanded while clicking a nav item with the pointer still inside", async () => {
    const rail = await mountRail();

    await firePointer(rail, "pointerenter");
    await advance(200);
    expect(rail.dataset.expanded).toBe("true");

    const nav = rail.querySelector("nav") as HTMLElement;
    const link = nav.querySelector("a") as HTMLElement;

    // 鼠标用户点击导航：指针仍停在 rail 内，rail 不应突然收起。
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await advance(50);

    expect(rail.dataset.expanded).toBe("true");
  });

  test("does not get stuck collapsed after pointer leaves following a click", async () => {
    const rail = await mountRail();

    await firePointer(rail, "pointerenter");
    await advance(200);
    const link = rail.querySelector("nav a") as HTMLElement;
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await advance(50);

    // 移出后应正常收起
    await firePointer(rail, "pointerleave");
    await advance(260);
    expect(rail.dataset.expanded).toBe("false");

    // 再次移入应能重新展开（dismissed 必须已被清掉）
    await firePointer(rail, "pointerenter");
    await advance(200);
    expect(rail.dataset.expanded).toBe("true");
  });
});

describe("HoverRail keyboard and touch", () => {
  test("collapses on nav click when the pointer is not hovering (touch/keyboard)", async () => {
    const rail = await mountRail();
    // 键盘聚焦展开
    const link = rail.querySelector("nav a") as HTMLElement;
    await act(async () => {
      link.dispatchEvent(new FocusEvent("focusin", { bubbles: true }));
    });
    // 触屏点击：没有 hover，应回收到图标栏
    await act(async () => {
      link.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true }));
    });
    await advance(50);
    expect(rail.dataset.expanded).toBe("false");
  });

  test("Esc collapses an expanded rail", async () => {
    const rail = await mountRail();
    await firePointer(rail, "pointerenter");
    await advance(200);
    expect(rail.dataset.expanded).toBe("true");

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await advance(50);
    expect(rail.dataset.expanded).toBe("false");
  });
});
