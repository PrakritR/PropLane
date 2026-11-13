export * from "@/lib/prospect-replies/types";
export { PROSPECT_INTENTS, classifyProspectIntents, prospectIntentDef, prospectIntentPlaybook } from "@/lib/prospect-replies/intents";
export {
  PROSPECT_REPLY_MAX_SEGMENTS,
  PROSPECT_REPLY_TARGET_SEGMENTS,
  composeProspectReply,
  ensureProspectReplyLinks,
  finalizeProspectReply,
  fixRotatedHomeLinks,
  isSendableProspectUrl,
  linkKindOfUrl,
  linkKindsPresentIn,
  requiredLinkKinds,
} from "@/lib/prospect-replies/compose";
export { homesFromListEvidence, prospectContextFromEvidence } from "@/lib/prospect-replies/facts";
export { availabilityLine, composeAvailabilityRundown, composeFirstReply, composeHomePickerReply, identifyHome, type FirstReply, type HomePick, type PickableHome } from "@/lib/prospect-replies/home-pick";
