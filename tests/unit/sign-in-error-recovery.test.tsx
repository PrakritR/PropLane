// @vitest-environment jsdom

import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { SignInErrorNotice } from "@/components/auth/sign-in-error-notice";
import {
  SIGN_IN_CREDENTIAL_MISMATCH_MESSAGE,
  presentSignInError,
} from "@/lib/auth/sign-in-error";

afterEach(cleanup);

describe("sign-in error recovery", () => {
  it("keeps wrong-password and unknown-account failures indistinguishable", () => {
    expect(presentSignInError("Invalid login credentials")).toEqual({
      message: SIGN_IN_CREDENTIAL_MISMATCH_MESSAGE,
      credentialMismatch: true,
    });
    expect(presentSignInError("INVALID CREDENTIALS")).toEqual({
      message: SIGN_IN_CREDENTIAL_MISMATCH_MESSAGE,
      credentialMismatch: true,
    });
    expect(SIGN_IN_CREDENTIAL_MISMATCH_MESSAGE).not.toMatch(/does not exist|not registered|no account/i);
  });

  it("renders both recovery paths inside the credential error", () => {
    const createAccountHref = "/auth/create-account?next=%2Fportal%2Fapplications";
    render(
      <SignInErrorNotice
        error={presentSignInError("Invalid login credentials")}
        createAccountHref={createAccountHref}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent(SIGN_IN_CREDENTIAL_MISMATCH_MESSAGE);
    expect(screen.getByRole("link", { name: "Reset password" })).toHaveAttribute(
      "href",
      "/auth/forgot-password",
    );
    expect(screen.getByRole("link", { name: "Create account" })).toHaveAttribute(
      "href",
      createAccountHref,
    );
  });

  it("does not show account-creation recovery for unrelated errors", () => {
    render(
      <SignInErrorNotice
        error={presentSignInError("Email not confirmed")}
        createAccountHref="/auth/create-account"
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("Email not confirmed");
    expect(screen.queryByRole("link", { name: "Reset password" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Create account" })).not.toBeInTheDocument();
  });

  it("rewords connection failures without exposing provider language", () => {
    expect(presentSignInError("TypeError: Failed to fetch")).toEqual({
      message: "We could not reach PropLane. Check your connection and try again.",
      credentialMismatch: false,
    });
  });
});
