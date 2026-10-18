# One-number decisions log (captain, Oct 18 2026)

Addenda to [`one-number-spec.md`](one-number-spec.md) (first spec) and the second spec
"PropLane Texting Agent & Mobile Site Plan" (house groups, preset auto-sends, delivery feel,
bookings times, onboarding/demo, homepage). Newer rows override older ones.
Implementation map: [`one-number.md`](one-number.md).

| # | Decision | Overrides |
| --- | --- | --- |
| 1 | Build both specs end to end; no plan phase; everything lands on `prakrit`. | — |
| 2 | Vendor dispatch: vendors on file get job offers (tours, cleaning, maintenance) with pay; the manager approves every vendor text first (Y / N / pick a number); per-house rules ("lockout at houses X → locksmith Y, then backups"); sequential or broadcast offers; busy / decline / no answer → next backup. Research: [`vendor-dispatch-research.md`](vendor-dispatch-research.md). | Spec "Vendor flow" auto-offer |
| 3 | 1:1 texts stay on the Programmable Messaging webhook; Twilio Conversations is used only for house group chats (no Conversations autocreate). | Second spec "run all messaging through Conversations" |
| 4 | Number model: every workspace texts on the set PropLane line by default; a personalized work number needs payment. | First spec "one number for everyone, retire all others" |
| 5 | Pro and Business include a personalized number; Free can buy the PropLane Number add-on alone (other Pro features stay locked); vendors and residents can buy their own number and channel (existing $5 PropLane Number). | #4 detail |
| 6 | Existing accounts move to this system too: nobody pays today, so every workspace — existing numbers included — texts on the shared line once it is live. Old numbers retire through the human-run cutover runbook (forward + auto-reply 60 days, then release). | "Leave existing workspaces as is" |
| 7 | The shared PropLane line IS the admin account's number: posted on the website, answers all housing (network effect), used by every PropLane Service workspace. PropLane's own service gets no exemption — same default line unless paid. | Earlier "service keeps a separate number" |
| 8 | Admin portal: Settings stays the first tab; then two halves — Property management (PropLane Service workspaces, one per city, created with the + button; the PropLane line settings; Unassigned leads) and Software (existing Accounts, Subscribers, Payments, Promo codes, Finances). People join service workspaces through the existing team invites by role. | — |
| 9 | Website: front page headline "Your AI Property Manager", 4 sections (hero, how it works, PropLane manages it for you, pricing — software and managed service). Pricing has Software and PropLane Managed tabs; a managed-service page with a contact form; Why PropLane emphasizes that PropLane manages properties (founders' Seattle Airbnb + room rentals, six-figure profit). No invented metrics. | Second spec hero copy |
| 10 | Agents never touch production data or settings; the shared number's Twilio registration and the production cutover are human steps. | — |
