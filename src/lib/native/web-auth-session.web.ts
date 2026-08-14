import type {
  WebAuthSessionAuthenticateOptions,
  WebAuthSessionAuthenticateResult,
  WebAuthSessionPlugin,
} from "@/lib/native/web-auth-session";

/**
 * Rejection for "this build has no native WebAuthSession".
 *
 * It carries Capacitor's `UNIMPLEMENTED` code deliberately: `openOAuthUrl` decides PRE-FLIGHT
 * failures (nothing was ever presented, so render the reason in place) from POST-FLIGHT ones
 * (the sheet came back with an error, so navigate) by that code. A bare `Error` with no code
 * reads as post-flight and would navigate the WebView — the "Continue with Google just
 * refreshes the page and loses the message" bug.
 */
class WebAuthSessionUnimplementedError extends Error {
  readonly code = "UNIMPLEMENTED";

  constructor() {
    super("WebAuthSession is only available on iOS");
    this.name = "WebAuthSessionUnimplementedError";
  }
}

export class WebAuthSessionWeb implements WebAuthSessionPlugin {
  async authenticate(_options: WebAuthSessionAuthenticateOptions): Promise<WebAuthSessionAuthenticateResult> {
    throw new WebAuthSessionUnimplementedError();
  }
}
