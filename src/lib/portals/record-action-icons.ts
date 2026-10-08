import {
  Archive,
  Bell,
  CalendarClock,
  CheckCircle2,
  Copy,
  CreditCard,
  Download,
  ExternalLink,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  Plus,
  RotateCcw,
  Send,
  Share2,
  Star,
  Tag,
  Trash2,
  UserPlus,
  XCircle,
  type LucideIcon,
} from "lucide-react";

/**
 * The 16px glyph leading a record ⋯ menu item, chosen from the item's visible
 * label (or action id). First match wins; an unmapped label gets the neutral
 * "more" dots so every item still has a glyph column and the labels line up.
 */
const RULES: ReadonlyArray<readonly [RegExp, LucideIcon]> = [
  [/^(approve|confirm|accept|mark( as)? (paid|done|complete(d)?)|complete)/i, CheckCircle2],
  [/^(decline|reject|deny|cancel)/i, XCircle],
  [/^(delete|remove|clear)/i, Trash2],
  [/^(remind|payment reminder)/i, Bell],
  [/^pay\b/i, CreditCard],
  [/^(open|view|preview)/i, ExternalLink],
  [/^(edit|rename|change)/i, Pencil],
  [/^(message|reply|text|email)/i, MessageSquare],
  [/^(download|export)/i, Download],
  [/^(share|copy link|copy-link)/i, Share2],
  [/^(duplicate|copy)/i, Copy],
  [/^(archive|unarchive)/i, Archive],
  [/^(reschedule|schedule)/i, CalendarClock],
  [/^(send|resend)/i, Send],
  [/^(add|new|create|upload)/i, Plus],
  [/^(assign|invite)/i, UserPlus],
  [/^(promo|tag)/i, Tag],
  [/^(set as default|default|star)/i, Star],
  [/^(reset|restore|undo|refresh|move to pending)/i, RotateCcw],
];

export function recordActionIcon(idOrLabel: string): LucideIcon {
  const text = idOrLabel.trim().replace(/[-_]+/g, " ");
  for (const [pattern, icon] of RULES) if (pattern.test(text)) return icon;
  return MoreHorizontal;
}
