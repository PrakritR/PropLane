import "server-only";

import { resolveEmailLinkBaseUrl } from "@/lib/app-url";
import { createTwilioRestClient, twilioErrorFields } from "@/lib/twilio-client.server";
import { PROPLANE_IDENTITY, type ConversationsGateway } from "./types";

/**
 * The only file that talks to Twilio Conversations. Group MMS works on US/Canada long codes with
 * at most ten participants including PropLane. 1:1 traffic stays on Programmable Messaging:
 * Conversations address autocreate must stay OFF for the shared number or it would take 1:1 texts.
 * A resident joins as an SMS participant (`messagingBinding.address` only); PropLane joins as a chat
 * participant whose `projectedAddress` is the shared number.
 */

export function conversationsWebhookUrl(): string {
  return process.env.TWILIO_CONVERSATIONS_WEBHOOK_URL?.trim() || `${resolveEmailLinkBaseUrl()}/api/twilio/conversations`;
}

export class ConversationsError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
    this.name = "ConversationsError";
  }
}

function fail(step: string, error: unknown): never {
  const f = twilioErrorFields(error);
  // Masked: a phone number never reaches a log.
  throw new ConversationsError(`${step} failed${f.code ? ` (${f.code})` : ""}`, f.code);
}

export function createConversationsGateway(): ConversationsGateway | null {
  const client = createTwilioRestClient();
  if (!client) return null;
  const conversations = client.conversations.v1.conversations;
  return {
    async createConversation({ friendlyName }) {
      try {
        const c = await conversations.create({ friendlyName: friendlyName.slice(0, 120) });
        return { sid: c.sid };
      } catch (error) {
        return fail("create conversation", error);
      }
    },
    async watchConversation(conversationSid) {
      try {
        await conversations(conversationSid).webhooks.create({
          target: "webhook",
          "configuration.url": conversationsWebhookUrl(),
          "configuration.method": "POST",
          "configuration.filters": ["onMessageAdded"],
        });
      } catch (error) {
        fail("watch conversation", error);
      }
    },
    async addResident(conversationSid, phoneE164) {
      try {
        const p = await conversations(conversationSid).participants.create({ "messagingBinding.address": phoneE164 });
        return { participantSid: p.sid };
      } catch (error) {
        return fail("add resident", error);
      }
    },
    async addProplane(conversationSid, sharedNumberE164) {
      try {
        await conversations(conversationSid).participants.create({
          identity: PROPLANE_IDENTITY,
          "messagingBinding.projectedAddress": sharedNumberE164,
        });
      } catch (error) {
        fail("add proplane", error);
      }
    },
    async postMessage(conversationSid, body) {
      try {
        const m = await conversations(conversationSid).messages.create({ author: PROPLANE_IDENTITY, body });
        return { messageSid: m.sid };
      } catch (error) {
        return fail("post message", error);
      }
    },
    async closeConversation(conversationSid) {
      try {
        await conversations(conversationSid).update({ state: "closed" });
      } catch (error) {
        fail("close conversation", error);
      }
    },
  };
}
