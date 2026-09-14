> Source of truth for house printables — READ IT BEFORE changing code under
> `src/lib/house-printables/`, `src/app/h/`, or `src/app/print/`.

# House printables: the door card, the rules poster, the welcome sheet, and the page a QR opens

Every house already stores what a manager used to hand-build in ChatGPT for each
turnover — `houseInfo` (codes, Wi-Fi, trash day, rules; `src/lib/house-info.ts`),
the name and address, and each room's move-in notes. Printables are a rendering
of those records, so they cannot drift from what the manager typed.

| Surface | Route | Audience | May carry |
| --- | --- | --- | --- |
| Door card | `/print/door-card/<propertyId>` | anyone at the front door | name, address, QR, work number |
| Rules poster | `/print/house-rules/<propertyId>` | common areas | the above + rules + trash days |
| Welcome sheet | `/print/welcome/<propertyId>?room=&resident=` | one resident, on paper | codes, Wi-Fi, the room's notes, a QR to the resident portal |
| Public page | `/h/<token>` | anyone who scans | rules, trash days, "Text the manager", "Report an issue" |

## The invariant: a QR taped to a door is public forever

`buildHousePublicPage` (`src/lib/house-printables/model.ts`) is an **allowlist**
over `HOUSE_PUBLIC_SECTIONS = ["rules", "trash"]`. It never reads the access,
wifi, contacts, safety or laundry sections, and the bin location and
between-cleanings chores are dropped from trash too. The door card and poster
render from the same model. `tests/unit/house-printables-privacy.test.ts` fills
every field of every section with a self-naming value and asserts none reaches
the public model. Add a section to `house-info.ts` and that test decides which
side it lands on — it fails until you name it in one of the two lists.

The welcome sheet is the one surface that carries secrets, and it is the one
surface that is never a URL: it renders behind `requireManagerRouteUser` and is
printed. Its QR is the resident portal login.

## The token

`manager_house_public_links` holds one opaque random token per property
(partial unique index on `(manager_user_id, property_id) where revoked_at is
null`); `ensureHousePublicLink` reuses it so a reprint carries the same QR as the
poster already on the wall. Revoking (`DELETE /api/portal/house-public-link`)
makes every printed copy open a 404 until the next print mints a new one. The
table is service-role only; the public page resolves the token server-side and
loads the property with the service role, then renders only the public model.

Printing uses `@media print` on the route itself — no PDF library. The print
routes live at `/print/…`, outside `/portal`, so the portal shell does not print
with the sheet; the public chat bubble hides on `/print` and `/h`.
