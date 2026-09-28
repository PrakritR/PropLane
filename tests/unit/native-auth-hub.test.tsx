// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

const { getSession } = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("@/hooks/use-is-native-app", () => ({
  useIsNativeApp: () => ({ isNative: true, platform: "ios" }),
}));
vi.mock("@/lib/native/detect-native", () => ({ detectNativePlatformSync: () => "ios" }));
vi.mock("@/lib/native/open-url", () => ({ isNativeOAuthInProgress: () => false }));
vi.mock("@/lib/supabase/browser", () => ({
  createSupabaseBrowserClient: () => ({ auth: { getSession } }),
}));
vi.mock("@/lib/auth/with-timeout", () => ({
  withAuthTimeout: <T,>(promise: PromiseLike<T>) => Promise.resolve(promise),
}));
vi.mock("@/lib/auth/recover-implicit-auth-hash", () => ({
  recoverImplicitAuthHash: vi.fn().mockResolvedValue({ recovered: false }),
}));

import { NativeAuthHub } from "@/components/auth/native-auth-hub";
import { AppUiProvider } from "@/components/providers/app-ui-provider";

describe("NativeAuthHub passive session check", () => {
  it("shows the credential form when the bounded native session check rejects", async () => {
    getSession.mockRejectedValueOnce(new Error("native storage unavailable"));

    render(
      <AppUiProvider>
        <NativeAuthHub />
      </AppUiProvider>,
    );

    expect(await screen.findByPlaceholderText("Email")).toBeInTheDocument();
  });
});
