/**
 * The first text from a new number on the PropLane line always gets a reply. A bare greeting ("hey", "hi there", "hello?")
 * is answered at once with a fixed line instead of waiting out the burst window and a model turn: while that turn ran, a
 * second text superseded the greeting's burst and the greeting was never answered.
 */
export const PROPLANE_FIRST_TEXT_REPLY = "Hi, this is PropLane. Looking for a place to rent? Tell me the area, budget and move-in date.";

const GREETINGS = new Set([
  "hi", "hey", "hello", "hola", "yo", "sup", "hiya", "heya", "howdy", "hi there", "hey there", "hello there", "good morning", "good afternoon",
  "good evening", "morning", "afternoon", "evening", "hi pls", "hey pls", "hi team", "hey team", "hi proplane", "hey proplane", "hello proplane",
  "anyone there", "anybody there", "is anyone there", "are you there", "test", "testing",
]);

/** "heyyy" and "hellooo" match "hey" and "hello": compare with repeated letters collapsed on both sides. */
const squash = (value: string): string => value.replace(/(.)\1+/g, "$1");
const GREETINGS_SQUASHED = new Set([...GREETINGS].map(squash));

/** True when the whole text is a greeting and nothing else. A greeting plus a question is a question and goes to the agent. */
export function isGreetingOnly(value: string): boolean {
  const normalized = value
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!normalized || normalized.length > 40) return false;
  return GREETINGS_SQUASHED.has(squash(normalized));
}
