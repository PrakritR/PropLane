import "server-only";

/**
 * The email half of a voice call summary.
 *
 * Kept separate from the fan-out so the delivery logic stays testable without a
 * mail provider: deliverVoiceCallSummary takes `sendEmail` as an argument, and
 * this is the real one.
 */
export async function sendVoiceSummaryEmail(input: {
  to: string;
  subject: string;
  text: string;
}): Promise<boolean> {
  const apiKey = process.env.RESEND_API_KEY?.trim();
  // No mailer configured is a deployment fact, not a call failure — the thread
  // copy and the SMS still went out.
  if (!apiKey) return false;
  const from = process.env.RESEND_FROM?.trim() || "PropLane <onboarding@resend.dev>";
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [input.to], subject: input.subject, text: input.text }),
    });
    return res.ok;
  } catch {
    return false;
  }
}
