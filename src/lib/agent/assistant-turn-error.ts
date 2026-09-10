import Anthropic from "@anthropic-ai/sdk";

/**
 * Dead-end copy — do not return this to users. Use {@link formatAgentChatUserError}.
 */
export const GENERIC_ASSISTANT_ERROR_DEAD_END =
  "The assistant ran into an error. Please try again." as const;

export type AssistantTurnFailure = {
  message: string;
  httpStatus: number;
};

/**
 * Does the provider message name a genuine media problem?
 *
 * Deliberately narrow. The provider stamps `invalid_request_error` into the
 * message of essentially EVERY 400, so matching `invalid` — or the `token` /
 * `maximum` that appear in `max_tokens` errors — matches every failure the API
 * can produce. That is how an out-of-credit account came to tell managers
 * "that attachment could not be processed" for a question with no file
 * attached. Only phrasing that can only come from an actual media block counts.
 */
function mentionsAttachmentMedia(lower: string): boolean {
  return (
    lower.includes("image") ||
    lower.includes("pdf") ||
    lower.includes("media_type") ||
    lower.includes("base64") ||
    lower.includes("document")
  );
}

/**
 * Account-level failures (spent credit balance, billing, quota) arrive as an
 * ordinary 400, not a 402. They are not the caller's fault and cannot be fixed
 * from the chat box, so they must never be dressed up as a problem with the
 * message the user just sent.
 */
function mentionsBillingProblem(lower: string): boolean {
  return (
    lower.includes("credit balance") ||
    lower.includes("billing") ||
    lower.includes("quota") ||
    lower.includes("insufficient") ||
    lower.includes("payment required")
  );
}

/** True when the provider refused the turn because the service account cannot pay. */
export function isAssistantBillingFailure(error: unknown): boolean {
  const ApiError = Anthropic.APIError;
  if (typeof ApiError === "function" && error instanceof ApiError && error.status === 402) {
    return true;
  }
  const lower =
    error instanceof Error
      ? error.message.toLowerCase()
      : typeof error === "string"
        ? error.toLowerCase()
        : "";
  return Boolean(lower) && mentionsBillingProblem(lower);
}

/**
 * SMS cannot stay silent when the model fails: Twilio then retries, marks 11200,
 * and the texter never gets a reply. Keep this shorter than portal copy.
 */
export function formatSmsAgentTurnError(error: unknown): string {
  if (isAssistantBillingFailure(error)) {
    return "Sorry, I couldn't reply just now. Please try again in a minute.";
  }
  return formatAgentChatUserError(error).message;
}

/** Prompt/context-window exhaustion, as opposed to a malformed request. */
function mentionsContextExhaustion(lower: string): boolean {
  return lower.includes("context") || lower.includes("too long") || lower.includes("exceed");
}

const SERVICE_ACCOUNT_FAILURE: AssistantTurnFailure = {
  message:
    "The assistant is unavailable because of a problem with the PropLane AI service account, not with your message. Please contact PropLane support — this cannot be fixed from here.",
  httpStatus: 503,
};

function mapAssistantTurnFailure(error: unknown): AssistantTurnFailure {
  if (error instanceof Anthropic.APIError) {
    if (error.status === 429) {
      return {
        message: "The AI service is busy right now. Wait about a minute and try again.",
        httpStatus: 429,
      };
    }
    if (error.status === 529 || error.status === 503) {
      return {
        message: "The AI service is temporarily overloaded. Please try again in a minute.",
        httpStatus: 503,
      };
    }
    if (error.status === 401 || error.status === 403) {
      return {
        message:
          "The assistant is temporarily unavailable. If this keeps happening, contact PropLane support.",
        httpStatus: 503,
      };
    }
    if (error.status === 402) return SERVICE_ACCOUNT_FAILURE;
    if (error.status === 413 || error.status === 400) {
      const lower = error.message.toLowerCase();
      // Checked first: a billing message can otherwise be swallowed by one of
      // the content-shaped branches below and reported as the user's fault.
      if (mentionsBillingProblem(lower)) return SERVICE_ACCOUNT_FAILURE;
      // Media is checked before context exhaustion: an oversized image reports
      // as "image ... exceeds 5 MB maximum", which the context test would
      // otherwise claim as a too-long conversation and send the user to a new
      // chat instead of to the file that actually failed.
      if (mentionsAttachmentMedia(lower)) {
        return {
          message:
            "That attachment could not be processed. Try a smaller JPEG or PNG, or send your question without the file.",
          httpStatus: 400,
        };
      }
      if (mentionsContextExhaustion(lower)) {
        return {
          message:
            "This conversation is too long for one turn. Start a new chat or ask about one thing at a time.",
          httpStatus: 400,
        };
      }
      // An unrecognized 400 is a bad request we could not classify. Say that,
      // rather than blaming an attachment the user may never have sent.
      return {
        message:
          "The assistant could not process that request. Try rephrasing it, or start a new chat if it keeps happening.",
        httpStatus: 400,
      };
    }
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (lower.includes("timeout") || lower.includes("timed out")) {
      return {
        message: "That took too long. Try a shorter question or fewer attachments.",
        httpStatus: 504,
      };
    }
    if (lower.includes("fetch failed") || lower.includes("econnreset") || lower.includes("network")) {
      return {
        message: "Could not reach the AI service. Check your connection and try again.",
        httpStatus: 503,
      };
    }
    if (lower.includes("could not upload") || lower.includes("listing photo")) {
      return {
        message: "We could not save your photos. Try again or use smaller images.",
        httpStatus: 500,
      };
    }
  }

  // Truly unclassified. Stay neutral about the cause — attachment-specific and
  // account-specific failures are classified above, so guessing here is what
  // sends users chasing the wrong fix.
  return {
    message:
      "I could not finish that request. Try again or rephrase it. If it keeps failing, start a new chat.",
    httpStatus: 500,
  };
}

/** Map an internal failure to a safe, actionable user message (no secrets / stack traces). */
export function formatAgentChatUserError(error: unknown): AssistantTurnFailure {
  return mapAssistantTurnFailure(error);
}

/** @deprecated Use {@link formatAgentChatUserError}. */
export function userFacingAssistantError(error: unknown): AssistantTurnFailure {
  return formatAgentChatUserError(error);
}

export function assistantTurnErrorResponse(error: unknown): {
  body: { error: string };
  status: number;
} {
  const { message, httpStatus } = formatAgentChatUserError(error);
  return { body: { error: message }, status: httpStatus };
}

/**
 * Shown in-thread when a proposal could not be persisted for confirm. It must
 * be unambiguous that NOTHING was changed — the whole failure mode this guards
 * against is the assistant sounding like it completed work it never did.
 */
export const PENDING_ACTION_SAVE_FAILED_NOTE =
  "I couldn't save that action for you to confirm, so nothing has been changed. Please try again in a moment, or make the change from the main portal.";
