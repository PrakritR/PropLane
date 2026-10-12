import Link from "next/link";
import type { ReactNode } from "react";

const LINK = /\[([^\]]+)\]\((\/[^)\s]*)\)/g;

/**
 * Renders a blog paragraph. The only markup a post string may carry is an
 * internal link, `[label](/path)`; everything else is plain text.
 */
export function renderInline(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(LINK)) {
    const at = m.index ?? 0;
    if (at > last) out.push(text.slice(last, at));
    out.push(
      <Link key={at} href={m[2]} className="font-semibold text-primary underline underline-offset-2">
        {m[1]}
      </Link>,
    );
    last = at + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}
