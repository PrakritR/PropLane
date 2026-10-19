/** A green Messages-style tile with a white speech bubble, drawn inline (no trademarked image file). Decorative. */
export function MessagesTile({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="9" fill="#34c759" />
      <path d="M20 9c-6.6 0-12 4.2-12 9.4 0 2.9 1.6 5.4 4.2 7.1-.2 1.4-.8 2.7-1.7 3.7 2-.2 3.9-1 5.1-2 .8.2 1.6.3 2.4.3 6.6 0 12-4.2 12-9.5S26.6 9 20 9Z" fill="#fff" />
    </svg>
  );
}
