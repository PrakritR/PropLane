# Sharing listings to a prospect (Send listing modal)

Moved out of the root `AGENTS.md` to keep it loadable; this is the
authoritative copy. Read it before changing code in this area.

## Sharing listings to a prospect (Send listing modal)

`ShareLeadLinkModal` (`share-lead-link-modal.tsx`) is the one "Send listing /
Invite to apply / Share tour" surface, mounted from Properties (header **Share**
and each listed row's ACTIONS **Send to prospect**), Applications, and Calendar.
**listing** and **apply** are multi-select (a manager can send several/all
properties at once via `CheckboxMultiSelect`; a multi-property apply share links
to `/rent/apply?ids=…` via `buildManagerPortfolioApplyUrl`, where the prospect
picks a home before entering the wizard). **tour** stays single-property because
the modal targets one tour flow. Rules baked into the modal +
`/api/portal/send-lead-invite`:

- **Single listing → direct listing page** (`buildManagerListingUrl` →
  `/rent/listings/{id}`). **Several listings → filtered browse link**
  (`buildManagerBrowseUrl` → `/rent/browse?ids=a,b,c`). The public browse page
  reads that param (`BROWSE_IDS_PARAM` / `parseBrowseIdsParam` in
  `manager-property-links.ts`) and restricts the grid via the
  `PropertyBrowseFilters.propertyIds` set in `buildPropertyBrowseCards`
  (`room-listings-catalog.ts`). The other manual filters still apply within the
  set; an id not in the public catalog is simply absent (same visibility rule as
  everywhere — a listing that isn't publicly active never appears on browse).
- The **room selector only shows for exactly one selected property** — it is
  meaningless (and hidden) for a multi-send.
- The email builder (`lead-invite-email.ts`) takes an optional `listingCount`;
  `>1` switches subject + body/html to the multi-listing "browse these N homes"
  copy instead of the single-listing summary.
- A share goes out over **email and/or SMS** (`viaEmail` / `viaSms`; at least one,
  else 400). SMS sends the short `buildLeadInviteSmsText` copy through
  `sendFromManagerWorkNumber`, so it obeys the one outbound rule in
  [`docs/agents/sms-system.md`](sms-system.md) — a manager with no
  provisioned work number is refused (400), never texted from another number, and
  the modal only offers the SMS channel once one exists.
- The server **re-authorizes every requested id** via
  `getShareablePropertyForUser` and rejects the whole send (403) if any id is
  not owned/assigned — never silently drops one. Client sends both `propertyId`
  (first, back-compat) and `propertyIds` (full list).
- **Email and/or SMS, chosen per send.** The modal's Send via picker sets
  `viaEmail` / `viaSms` (+ `phone`) on the request; SMS is offered only when
  `/api/manager/sms-conversations` reports a work number, and the route sends it
  through `sendFromManagerWorkNumber` (`counterpartyRole: "prospect"`, so it
  threads like any other prospect SMS — see
  [`docs/agents/sms-system.md`](sms-system.md)). SMS copy is its own
  short builder, `buildLeadInviteSmsText`, not a trimmed email body.

## Studio redesign 0929

Listing, application and tour shares now use `ListingWizardOverlay` and
`WizardShell`: Home → Recipient → Review. Contact fields follow the selected
Email/Text channels; the review sends through the existing authorized endpoint.
The listing intro is `listing:shared:resident` in the existing scoped
`automatedMessages` settings namespace. It is the sole editable exception to
fixed automated notices; Settings → What PropLane sends → Leasing edits it.
The first selected property resolves the intro for a multi-property share.
`listing-shared-template.ts` expands `{homes}`, `{property}`, `{first_name}`.
The server reconstructs listing cards from authorized properties and derives
From/signature from authenticated work identity. Client intro text grants no
additional property access. Email and SMS still use their existing delivery
paths; a new prospect's two contact identities are not automatically merged.
