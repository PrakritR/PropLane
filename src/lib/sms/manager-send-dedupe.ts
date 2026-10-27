/**
 * `sms_outbox.dedupe_key` of a text a PERSON typed in the Communication inbox (`sendManagerSms`). It is the one writer
 * of this prefix: every assistant tool, agent, reminder, welcome and router send uses a key of its own. Read it back to
 * tell a manager's own reply from the assistant's (a resident's conversation labels the second one "PropLane"), and to
 * find a manager's prior vendor text.
 */
export const MANAGER_SEND_DEDUPE_PREFIX = "manager:";
