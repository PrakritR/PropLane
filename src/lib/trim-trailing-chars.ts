/**
 * Strip a trailing run of any of `chars` without a regex. `/[.,]+$/` is quadratic on a long run
 * that is not at the end of the string; this is one linear pass.
 */
export function trimTrailingChars(text: string, chars: string): string {
  let end = text.length;
  while (end > 0 && chars.includes(text[end - 1]!)) end -= 1;
  return end === text.length ? text : text.slice(0, end);
}
