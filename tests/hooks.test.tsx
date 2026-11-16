import { act, useState } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useAppStore, useRefreshSignal } from "../src/web/data/store";
import { type LoginFormValues, loginResolver, useForm } from "../src/web/form-resolvers";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let activeUnmount: (() => Promise<void>) | null = null;

afterEach(async () => {
  if (activeUnmount) {
    await activeUnmount();
    activeUnmount = null;
  }
});

async function mountNode(element: React.ReactElement) {
  const container = document.createElement("div");
  const root = createRoot(container);
  activeUnmount = async () => {
    await act(async () => {
      root.unmount();
    });
  };
  await act(async () => {
    root.render(element);
  });
  return container;
}

function RefreshHarness({ onRefresh }: { onRefresh: () => void }) {
  const [label, setLabel] = useState("idle");
  useRefreshSignal(() => {
    onRefresh();
    setLabel("refreshed");
  });
  return <output>{label}</output>;
}

function FormHarness({ onSubmitted }: { onSubmitted: (data: LoginFormValues) => void }) {
  const form = useForm<LoginFormValues>({
    resolver: loginResolver,
    defaultValues: { studentId: "", password: "" },
  });
  return (
    <form onSubmit={form.handleSubmit(onSubmitted)}>
      <input aria-label="学号" {...form.register("studentId")} />
      {form.formState.errors.studentId?.message && (
        <p role="alert">{form.formState.errors.studentId.message}</p>
      )}
      <input aria-label="密码" {...form.register("password")} />
      {form.formState.errors.password?.message && (
        <p role="alert">{form.formState.errors.password.message}</p>
      )}
      <button
        type="button"
        onClick={() => form.setValue("studentId", " 23050101 ", { shouldValidate: true })}
      >
        fill-id
      </button>
      <button type="button" onClick={() => form.setValue("password", "secret", { shouldValidate: true })}>
        fill-pw
      </button>
      <button type="submit">提交</button>
    </form>
  );
}

describe("React hooks without external state libraries", () => {
  test("useRefreshSignal skips initial mount and fires when requestRefresh increments", async () => {
    const onRefresh = vi.fn();
    const container = await mountNode(<RefreshHarness onRefresh={onRefresh} />);
    expect(onRefresh).not.toHaveBeenCalled();

    await act(async () => {
      useAppStore.getState().requestRefresh();
    });
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(container.textContent).toBe("refreshed");
  });

  test("useForm blocks invalid submit, clears field error on revalidation, and submits normalized values", async () => {
    const submitted: LoginFormValues[] = [];
    const container = await mountNode(<FormHarness onSubmitted={(data) => submitted.push(data)} />);
    const formEl = container.querySelector("form");
    expect(formEl).not.toBeNull();

    await act(async () => {
      formEl?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submitted).toHaveLength(0);
    expect(container.textContent).toContain("请输入学号");
    expect(container.textContent).toContain("请输入密码");

    const buttons = container.querySelectorAll("button[type='button']");
    await act(async () => {
      buttons[0]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    expect(container.textContent).not.toContain("请输入学号");
    expect(container.textContent).toContain("请输入密码");

    await act(async () => {
      buttons[1]?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    });
    await act(async () => {
      formEl?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(submitted).toEqual([{ studentId: "23050101", password: "secret" }]);
  });
});
