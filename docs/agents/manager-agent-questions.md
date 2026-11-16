# Manager agent: the questions it must answer

Captain, Nov 15: "think of all questions someone would ask the PropLane agent as a property manager." This is the
catalog. Every row names the tool that answers it; **NEW** marks a read tool added for this catalog
(`src/lib/tools/domains/manager-questions.ts`). The eval in `tests/unit/tools/manager-question-catalog.test.ts` pins a
representative subset: the tool exists in the manager registry, is on the right surfaces, and returns only this
workspace's rows.

Surfaces: **App** = `agentRegistry` (`/api/agent/chat`). **SMS** = `buildManagerSmsRegistry` (the registry minus
destructive writes, portal-only reads and the two application approvals). **Co-mgr** = a delegated seat or co-manager:
only tools in `CO_MANAGER_SCOPED_TOOLS` (`manager-co-manager-tool-scope.ts`), each narrowed by the grant for that
module and house (`smsAccessAllowsRow`). **API** = MCP / REST area in `src/lib/mcp/capabilities.ts`
(`tests/unit/mcp-tool-scope.test.ts` fails a tool with neither an area nor an explicit exclusion).

A tool answers on every surface unless the Notes column says otherwise. "Co-mgr: no" means a delegated seat is refused
before the handler runs (fail closed); that is deliberate for money and tour rollups that have no per-house grant check.

## Prospects and leads

| # | Question | Tool | Notes |
|---|---|---|---|
| 1 | Any new leads today? | `list_recent_leads` (sinceDays 1) | Co-mgr: yes, only leads tagged to their houses. API: communication |
| 2 | Who texted about 4709A? | `list_recent_leads` (q) | phone last 4 only |
| 3 | What is the budget / move-in date of the person who texted? | `list_recent_leads` | profile fields wrapped as untrusted |
| 4 | Show me the conversation with that prospect | `list_sms_conversations` then `get_thread_messages` | |
| 5 | Reply to the prospect asking about the room | `list_sms_conversations` then `reply_to_sms_conversation` (write, YES-gated) | links first via `get_property_links` |
| 6 | Which leads came in this week? | `list_recent_leads` (sinceDays 7) | |
| 7 | Who toured but never applied? | `list_toured_not_applied` **NEW** | App, SMS, API calendar. Co-mgr: no |
| 8 | Who should I follow up with after tours? | `list_toured_not_applied` **NEW** | |
| 9 | Who is waiting on a reply from me? | `list_threads_awaiting_reply` **NEW** | Co-mgr: yes, Communication gate |
| 10 | Send a prospect the apply / tour link | `get_property_links`, `share_property_link` | |

Not answerable today: lead source ("where did they find us") and a scheduled follow-up reminder. The prospect spine
does not store a source field per lead; say so rather than guess.

## Tours

| # | Question | Tool | Notes |
|---|---|---|---|
| 11 | Who is touring tomorrow? | `list_tours_on_day` | Co-mgr: no |
| 12 | Any tours today? | `list_tours_on_day` | |
| 13 | What tour requests are pending? | `list_tour_inquiries` | |
| 14 | What times are open for tours Thursday? | `list_open_tour_slots` | the only source of bookable times |
| 15 | Book Jane Thursday at 3 | `list_open_tour_slots` then `book_tour` (write) | |
| 16 | Move / cancel a tour | `reschedule_tour`, `cancel_tour` (cancel is write, YES) | |
| 17 | What is on my calendar this week? | `list_calendar_events` | |
| 18 | Did anyone not show up to a tour? | not tracked | no no-show flag exists; `list_toured_not_applied` lists tours that happened |

## Applications and screening

| # | Question | Tool | Notes |
|---|---|---|---|
| 19 | How many applications are pending? | `list_applications` (bucket pending) | Co-mgr: yes |
| 20 | Which applicants are flagged in screening? | `list_applications` (screeningStatus flagged) | |
| 21 | What is the status of Priya's application? | `list_applications`, `get_application_details` | |
| 22 | Who should I approve? | `list_applications` then `get_application_review_link` | approval is never by text; reply with the link |
| 23 | Which applications have no background check? | `list_applications` (screeningStatus not_applicable) | |
| 24 | Order a background check for Sam | `order_background_check` (write) | |
| 25 | Missing documents on an application | not exposed | the raw form and uploads are never returned to the model; send the review link |

## Leases

| # | Question | Tool | Notes |
|---|---|---|---|
| 26 | Whose lease ends in the next 30 / 60 / 90 days? | `list_expiring_leases` **NEW** | days left computed in code. Co-mgr: yes (Leases grant). API: leasing |
| 27 | Which leases are unsigned? | `list_leases` (status) | |
| 28 | Who owes a signature on their lease? | `list_leases` (Resident Signature Pending) | |
| 29 | What are the terms of Jordan's lease? | `get_resident_snapshot` **NEW**, `list_lease_sections` | |
| 30 | Send the lease for signature | `send_lease_for_signature` (write) | |
| 31 | Which renewals are coming up? | `list_expiring_leases` **NEW** | |
| 32 | Lease expiration report | `run_financial_report` (lease_expiration) | |

## Rent and money

| # | Question | Tool | Notes |
|---|---|---|---|
| 33 | Who hasn't paid rent this month? | `list_unpaid_rent` | Co-mgr: no; use `get_overdue_charges` (Payments grant) |
| 34 | Who hasn't paid October rent? | `list_unpaid_rent` (month 2026-10) | |
| 35 | Who is late, and by how much? | `get_overdue_charges`, `run_financial_report` (delinquency) | |
| 36 | How much is overdue in total? | `list_unpaid_rent` (unpaidTotal) | the total is the tool's |
| 37 | Remind everyone who is late | `get_overdue_charges` then `send_rent_reminder` (write) | |
| 38 | Does Sam owe anything? | `get_resident_snapshot` **NEW** | balance is null without the Payments grant |
| 39 | What charges does a resident have? | `list_charges` | |
| 40 | What late fees were charged? | `list_charges` (kind filter in the answer) | |
| 41 | How much rent did we collect this month? | `get_portfolio_status` | |
| 42 | Deposits held | `run_financial_report` (rent_roll deposits) | deposits are a liability |
| 43 | Income vs expenses per house this month | `get_house_profit_loss` **NEW** | ledger income minus expenses; API: financials. Co-mgr: no |
| 44 | Which house makes the most? | `get_house_profit_loss` **NEW** | sorted by net |
| 45 | Profit and loss for the quarter | `run_financial_report` (income_statement) | |
| 46 | What are my expenses by category? | `run_financial_report` (expenses) | |
| 47 | Payouts: when do I get paid, set up payouts | `set_up_payouts` | |
| 48 | Outstanding bills I owe vendors | `list_vendor_invoices` is vendor-side; for manager bills use `run_financial_report` (vendor_spend) | gap: no "unpaid manager bills" read yet (finance phase A) |
| 49 | Record an expense / income | `record_expense`, `record_income` (write) | |

## Occupancy

| # | Question | Tool | Notes |
|---|---|---|---|
| 50 | What is vacant right now? | `list_vacant_rooms` | Co-mgr: no |
| 51 | What is vacant next month / opens soon? | `list_vacant_rooms` (opening) | |
| 52 | Is room 3 free from Dec 1? | `check_room_availability` | |
| 53 | Who is moving in / out this week? | `list_stay_moves` (per day), `list_expiring_leases` | |
| 54 | Who checks in tomorrow? | `list_stay_moves` | |
| 55 | Any double bookings? | `list_bookings` | the room-capacity trigger refuses overlap; a conflict shows as two rows |
| 56 | Occupancy by house | `get_portfolio_status` | |
| 57 | Mark room 3 rented to Sam | `mark_room_rented` (write) | |

## Bookings and channels

| # | Question | Tool | Notes |
|---|---|---|---|
| 58 | Stays by channel (Airbnb, Booking, PropLane) | `list_bookings` | |
| 59 | Guest names for next weekend | `list_bookings` | untrusted |
| 60 | Any channel sync problems? | `listing_syndication_status` | posting status only; the channel-sync health card is portal-only |
| 61 | Block a room for repairs | `block_room_dates` (write) | |

## Residents

| # | Question | Tool | Notes |
|---|---|---|---|
| 62 | Who lives at 5259 Brooklyn? | `list_residents` (property) | Co-mgr: yes |
| 63 | Tell me about Priya | `get_resident_snapshot` **NEW** | house, room, rent, lease, balance. API: excluded |
| 64 | What does room 3 pay? | `get_resident_snapshot` **NEW** | |
| 65 | How do I reach Sam? | `get_resident_snapshot` **NEW** (email) | phone is not returned |
| 66 | Who has pets? | not stored | pet policy is on the listing, not per resident; say so |
| 67 | Record a move-out | `record_move_out` (write) | |

## Services and maintenance

| # | Question | Tool | Notes |
|---|---|---|---|
| 68 | What maintenance is open? | `summarize_open_services` **NEW** | counts by house; Co-mgr: yes (Services grant) |
| 69 | Which house has the most open issues? | `summarize_open_services` **NEW** | |
| 70 | Any urgent services? | `summarize_open_services` **NEW** (urgent) | |
| 71 | Who is assigned to the leak at 4709A? | `list_work_orders` | |
| 72 | What did that repair cost? | `list_work_orders` (cost) | |
| 73 | Which add-on requests are pending? | `list_service_requests` | |
| 74 | Suggest a vendor for a plumbing job | `suggest_vendors_for_work_order` | |

## Vendors

| # | Question | Tool | Notes |
|---|---|---|---|
| 75 | Who are my plumbers and what do they charge? | `list_vendors` | |
| 76 | How much have I paid each vendor? | `run_financial_report` (vendor_spend) | |
| 77 | Invite a vendor | `invite_vendor` (write) | |

## Communication, house info, reports

| # | Question | Tool | Notes |
|---|---|---|---|
| 78 | Any unread messages? | `list_inbox_threads` (unreadOnly) | |
| 79 | Which threads are waiting on me? | `list_threads_awaiting_reply` **NEW** | |
| 80 | Message everyone at 5257 | `broadcast_to_residents` (write) | |
| 81 | What is the Wi-Fi / door code at 4709A? | `lookup_property_knowledge` | codes follow the existing reveal and staff-only rules; the agent never invents one |
| 82 | How are my houses doing? | `get_portfolio_status` | |
| 83 | What is my average rent? | `run_financial_report` (rent_roll) | the tool's totals, never an average the model computes |
| 84 | Flagged assistant replies / delivery issues | portal Communication filter | owned by the comms lane, not a tool here |

## Gaps left on purpose

Lead source, tour no-shows, per-resident pets, missing application documents, manager-bills-unpaid, and a "follow-ups
due" queue are not stored (or not exposed to the model), so no tool pretends to answer them. The prompt tells the agent
to say that plainly.
