// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
vi.mock("@capacitor/core", () => ({ Capacitor: { isNativePlatform: () => false } }));
import { useNativeCamera } from "@/lib/native/use-native-camera";
afterEach(() => vi.restoreAllMocks());
it("settles a cancelled web photo picker so inspection controls unlock", async () => {
  vi.spyOn(HTMLInputElement.prototype, "click").mockImplementation(function (this: HTMLInputElement) {
    queueMicrotask(() => this.dispatchEvent(new Event("cancel")));
  });
  const { result } = renderHook(() => useNativeCamera());
  await act(async () => expect(await result.current.capture()).toBeNull());
});
