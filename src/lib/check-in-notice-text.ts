/** "Matthew checked in to 4709A Room 9": first name only, house and room as the manager named them. */
export function checkedInNoticeText(input: { residentName: string; propertyLabel: string; roomLabel: string }): string {
  const first = input.residentName.trim().split(/\s+/)[0] || "A resident";
  const place = [input.propertyLabel.trim(), input.roomLabel.trim()].filter(Boolean).join(" ");
  return place ? `${first} checked in to ${place}` : `${first} checked in`;
}
