import {
  Archive,
  Ban,
  ArrowDown,
  ArrowUp,
  Bell,
  CalendarClock,
  CheckCircle2,
  CircleOff,
  Copy,
  CreditCard,
  Download,
  Eye,
  ExternalLink,
  MessageSquare,
  MoreHorizontal,
  Pencil,
  PenLine,
  Phone,
  Plus,
  Receipt,
  RotateCcw,
  Undo2,
  Wallet,
  Send,
  Shield,
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
 * label (or action id). First match wins. An unmapped label falls back to the
 * "more" dots only as a safety net so the glyph column still lines up — every
 * action the app ships must resolve to a real icon (`tests/unit/record-action-icons.test.ts`).
 */
const RULES: ReadonlyArray<readonly [RegExp, LucideIcon]> = [
  [/^(approve|confirm|accept|mark( as)? (paid|done|complete(d)?)|complete)/i, CheckCircle2],
  [/^(decline|reject|deny|cancel)/i, XCircle],
  [/^unblock/i, Ban],
  [/^(delete|remove|clear)/i, Trash2],
  [/^(remind|payment reminder)/i, Bell],
  [/^pay\b/i, CreditCard],
  [/^(view|preview)/i, Eye],
  [/^open/i, ExternalLink],
  [/^(mark( as)? (signed|sign)|sign|countersign)/i, PenLine],
  [/^unlist/i, CircleOff],
  [/^move up/i, ArrowUp],
  [/^move down/i, ArrowDown],
  [/^(re-?run|run check|run screening|retry)/i, RotateCcw],
  [/^(call|phone)/i, Phone],
  [/^(screen|background)/i, Shield],
  [/^(edit|rename|change)/i, Pencil],
  [/^(message|reply|text|email)/i, MessageSquare],
  [/^(download|export)/i, Download],
  [/^(share|copy link|copy-link)/i, Share2],
  [/^(duplicate|copy)/i, Copy],
  [/^(archive|unarchive)/i, Archive],
  [/^(reschedule|schedule)/i, CalendarClock],
  [/^(send|resend|submit)/i, Send],
  [/^receipt/i, Receipt],
  [/^refund/i, Undo2],
  [/^withdraw/i, Wallet],
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

/** True when the label/id fell through to the neutral "more" dots. */
export function isPlaceholderRecordActionIcon(idOrLabel: string): boolean {
  return recordActionIcon(idOrLabel) === MoreHorizontal;
}
