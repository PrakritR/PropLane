# Vendor dispatch research (Oct 18 2026)

> Research brief behind `src/lib/vendor-dispatch/trades.ts` and the dispatch-rules build. Timings marked (rec.) are starting values, not sourced defaults.

## PropLane vendor dispatch: design brief

Sources are inline. Items marked **(rec.)** are my recommendations, not something a competitor documents. The tools I researched mostly publish marketing pages, so I found no documented timeout defaults or approval thresholds for Latchel, AppFolio, Buildium or Rent Manager. I did not find Breezeway's official docs, whether it enforces photo proof, or any no-show policy for tour tools. NARPM guidance did not turn up either. The timings below are therefore starting values to tune.

## What the market does that matters here
- **Latchel** has ranked "preferred vendors, in your order" per property, on-call calendars, and escalation to backups when a primary doesn't respond. It sends bid requests to outside Thumbtack pros only after your vendors can't take the job, and it can dispatch emergencies without manual intervention ([dispatch](https://latchel.com/maintenance-dispatch-and-scheduling/)). Its priority levels are Level 1 emergency, Level 2 urgent and Level 3 standard, judged on safety, habitability, property damage risk and time of day. Latchel says it attempts non-emergency vendor assignment within 5 days ([RentRedi help](https://help.rentredi.com/en/articles/5220417-how-long-does-it-take-latchel-to-find-a-vendor)).
- **Property Meld:** one customer reassigns a work order after 2 hours of vendor silence and sends a warning message at 1 hour ([case study](https://propertymeld.com/wp-content/uploads/2024/04/PM23-CaseStudy-Stevens-Realty.pdf)).
- **Turno:** primary cleaners are alerted first. Backups are alerted only when no primary is set, all primaries decline, or after a host-set timer. A host can make checklist completion mandatory ([Turno](https://help.turno.com/en/articles/8600303-boosting-your-business-with-turno-best-practices-for-hosts)).
- **Photo proof:** Properly blocks task completion without a photo ([Properly](https://www.getproperly.com/features/photo-checklists)).
- **AppFolio and Rentvine:** the vendor accepts or declines, and may submit an estimate on accept. A decline notifies the manager ([AppFolio vendor guide](https://support.greenresidential.com/hc/en-us/articles/17680858367639-Vendor-Portal-Guide), [Rentvine](https://help.rentvine.com/introduction-to-the-vendor-portal)).
- **Guesty and Hostaway** auto-create cleaning tasks at checkout and notify the assignee ([Guesty](https://help.guesty.com/hc/en-gb/articles/20187928852637-Managing-your-cleaning-operations-in-Guesty)).
- **Thumbtack and Angi** broadcast leads, and speed to respond decides who wins. Thumbtack reportedly caps a customer at about 4 pros in the first 4 hours, but that comes from a forum post ([community](https://community.thumbtack.com/discussion/comment/5845), [analysis](https://superdupr.com/blog/is-thumbtack-worth-it)). Broadcast fits low-stakes, fungible jobs. It burns vendor goodwill when many lose.
- **Jobber and Housecall Pro** show no documented native auto-assign. The workaround is tagging vendors by skill and primary zone ([Builts](https://builts.ai/blog/servicetitan-dispatch-automation-housecall-pro-jobber/)). That suggests a skills, zone and capacity matrix on each vendor.

## 1. Role taxonomy

Urgency classes: **E** emergency, **U** urgent, **R** routine. Response time means time to first vendor acknowledgment, then arrival or scheduled-by. All targets are **(rec.)**. Washington's repair deadlines are in section 2.

| Role | Typical jobs | Urgency / target | Pay model | Offer must include | Proof of completion |
|---|---|---|---|---|---|
| Locksmith | Lockout, rekey between tenants, broken lock | E/U: ack 5 min, arrive 45–60 min | Trip fee + flat per service | Address, door type, who is locked out, ID-verification status, price cap | Photo of working lock, invoice, receipt |
| Plumber | Active leak, sewer backup, clog, water heater | E (active flood): arrive ≤2 h. U: same day. R: 3 days | Trip fee + hourly, or flat quote | Shutoff location, photos, access, price cap | Before/after photos, parts invoice |
| Electrician | Outage, sparking, breaker, outlet | E (sparking/burning smell): arrive ≤2 h. U/R otherwise | Trip fee + hourly | Panel location, what's dead, safety flags | Before/after photos, invoice |
| HVAC / heat | No heat, AC | E/U in cold: arrive same day, ≤4 h in winter. R otherwise | Trip fee + hourly + parts | Equipment type, thermostat state, filter check done | Photo of unit and temperature reading |
| Appliance repair | Fridge, range, washer | U/R: 72 h | Diagnostic fee + repair | Make, model, symptom, photo | Invoice, photo |
| Handyman | Small repairs, locks, drywall | R: 3–7 days | Hourly or flat | Scope, photos, materials | Before/after photos |
| Pest control | Roaches, bed bugs, rodents | U/R: 24–72 h | Flat visit + recurring | Pest type, rooms, photos | Treatment report |
| Cleaner | Turnover, deep clean, recurring common area | Checkout-triggered, time-boxed | Flat per property or per room, or hourly | See section 7 | Checklist + timestamped photos |
| Landscaping / snow | Mowing, snow, ice | R, with weather-triggered U | Per visit, seasonal contract | Area, trigger, timing | Before/after photos |
| Movers / junk removal | Move-out debris | R: scheduled | Flat quote or volume | Item list, access, photos | After photo, disposal receipt |
| Tour host / showing agent | In-person tours | Time-boxed, ack within 15–30 min | Flat per showing | See section 7 | Check-in text, attendance note |

Benchmarks: [oxmaint](https://oxmaint.com/industries/property-management/-triaging-emergency-vs-routine-maintenance-property) defines an emergency as an immediate threat to health, safety, property or habitability. A US military housing contract uses 30 minutes during duty hours, 1 hour otherwise, 4 hours for urgent and 24 hours for routine ([JBSA](https://www.jbsa.mil/News/News/Article/462825/contract-defines-housing-response-times/)). Cleaning runs about $80–130 for a 2BR and $110–175 for a 3BR house, with linens extra ([bnbcalc](https://www.bnbcalc.com/blog/airbnb-business/how-to-start-airbnb/airbnb-cleaning-service)). For a co-living house, price per room plus a common-area line is the natural model.

## 2. Triage questions before dispatch

Rule **(rec.)**: the AI asks at most 3 to 4 questions, safety first, and never dispatches before the safety question is answered. **Gas smell, smoke, CO alarm or fire: call 911, leave, then utility** (Puget Sound Energy gas emergency line). The AI stops troubleshooting and notifies the manager immediately.

Washington repair clock (RCW 59.18.070): 24 hours for loss of heat, hot or cold water, or electricity, or an imminent hazard to life. 72 hours for a fridge, range/oven or major plumbing fixture. 10 days for everything else. The clock runs from written notice, so a resident's text is evidence. Log it with a timestamp. [Statute](https://lawfilesext.leg.wa.gov/Law/RCWArchive/2023/htm/RCW%20%2059%20%20TITLE/RCW%20%2059%20.%2018%20%20CHAPTER/RCW%20%2059%20.%2018%20.070.htm).

- **Lockout:**
  1. Are you safe, and is anyone inside (child, pet, stove on)? If yes, 911.
  2. Which room and address?
  3. Is a spare or lockbox code available?
  4. Send your name and a photo of ID plus the lease or house roster match. Unverified means no dispatch.
- **Leak/flood:**
  1. Is water near outlets or ceiling fixtures? If yes, switch off power at the panel if safe.
  2. Can you close the shutoff valve under the sink or toilet, or the main?
  3. Clean water or sewage?
  4. Photo, and which floor.
- **No heat:**
  1. Outside temperature and is it the whole house?
  2. Thermostat on heat and set above room temperature, and are batteries fine?
  3. Any gas smell? If yes, treat as gas.
  4. Photo of the breaker and filter.
- **No hot water:**
  1. Is it the whole house or one tap?
  2. Is the pilot lit or the breaker tripped?
  3. Any leak at the tank?
- **Electrical out:**
  1. Any burning smell, sparking or hot outlets? If yes, panel off and E.
  2. One room or the whole house?
  3. Breaker checked?
  4. Neighbors out too (utility outage)?
- **Clogged toilet/drain:**
  1. Overflowing now?
  2. Is it the only toilet in the house?
  3. Have you tried a plunger?
  4. Backed up elsewhere (sewer main)?
- **Pest:**
  1. What kind of pest and where?
  2. For bed bugs, a photo and how long.
  3. Is food storage involved?
- **Appliance broken:**
  1. Make and model?
  2. Safe to use? Any leaking, smoke or smell?
  3. Photo. Is it a landlord-supplied appliance?
- **Noise:** this is a conduct issue, not a vendor job, so route to the manager. Ask whether anyone is in danger (911) and for a time and room. Never send a vendor.
- **Smoke/CO alarm:**
  1. Is it ringing now, and do you smell smoke or feel unwell? If yes, evacuate and call 911.
  2. If it is a chirp, which unit and is it a low-battery pattern?
  3. A chirp goes to a handyman as R/U.
- **Gas smell:** 911 and the gas utility, leave the house, no switches. Never auto-dispatch a vendor.

Fixes the AI can talk through at intake, such as the breaker, thermostat, reset button or plunger, resolve a meaningful share of requests. Latchel claims 23% resolved at intake ([Latchel](https://latchel.com/emergency-maintenance-support)), which is unverified.

## 3. Dispatch rule patterns
- **Precedence (rec.):** property override, then group, then portfolio default. The first rule that matches wins. Rules are keyed on house × job type × urgency × time-of-day (business hours or after-hours).
- **Rule shape:** `primary → ordered backups[]`, each with its own mode (sequential or broadcast), timeout and not-to-exceed cap. Latchel and Turno both use primary then backup.
- **Sequential default:** one vendor at a time. Timeouts **(rec.)**: E 5–10 min, U 30 min, R 2 hours (matches Property Meld's 2-hour reassign). Send one reminder text at 50% of the timeout.
- **Broadcast:** to the top N (2 to 3). Use it only for low-stakes jobs (cleaning, tours, handyman) or when the sequential chain fails. First YES wins and the rest get "Taken, thanks." Cap losses, since vendors who lose repeatedly stop answering.
- **After-hours:** the rule carries a vendor-hours window. Outside it, skip to the on-call vendor.
- **Capacity and "busy":** a vendor reply of BUSY or NO counts as a decline. Optionally "BUSY 2h" parks the vendor, skips them for that window, and lets them resume.
- **Blackouts:** per-vendor date ranges and a snooze such as "off till Mon."
- **Spending:** every offer carries a not-to-exceed (NTE) amount. Day one is manager-approves-everything. Add auto-approve later, for example "recurring cleaning under $150 at house X," "tours under $30," "lockout under $120." Any quote above NTE re-asks the manager.
- **No-answer behavior:** if the chain is exhausted, text the manager "No one accepted. Retry, widen to broadcast, or you handle?"

## 4. Manager SMS patterns

Keep each text to one SMS segment (160 GSM-7 characters, or 70 with an emoji or smart quote). Avoid emoji and curly quotes.

- **Single approval:** `Lockout 5259 Brooklyn R3. Dispatch Sam Locksmith, cap $120? Y/N` (about 70 chars)
- **Options:** `Leak 4709A. 1 Mike Plumb $180 ETA 1h 2 FastFix $150 ETA 3h. Reply 1/2/N`
- **Price change from a vendor:** `Mike quotes $240 (was cap $180) for sewer snake. Y/N/2 other`
- **Accepted:** `Mike accepted, arrives ~2:30pm. Reply STOP-JOB to cancel.`
- **Completion:** `Cleaning 5259 done 12:40, 14 photos. Reply OK or FIX.`
- **Rules:** end every text with a verb list, always accept YES, Y, 1, OK, or NO, N. Never put free text in an approval. If a reply is ambiguous, reply once with the exact options.
- **Escalation if the manager doesn't answer:**
  1. After 5 min for E or 15 min for U, resend.
  2. Then text the second team member or backup approver.
  3. After 15 min for E, follow the portfolio default (for E only, a pre-approved "safe default": a specific vendor and cap the manager consented to in advance). Never auto-dispatch an R job.
  4. Record every approval with timestamp, approver and a verbatim reply.
- **Approval tokens:** include a short job ID so a stale "Y" can't approve the wrong job. If two approvals are pending, the number goes in the reply (`Y 2`).

## 5. Vendor onboarding data
Trade(s), service area (zip codes or radius), rate card (trip fee, hourly, flat), emergency surcharge, availability windows and on-call hours, languages, preferred mode (SMS), consent record (timestamp, wording, number), insurance COI (general liability, workers' comp where relevant) with expiry date, license number and type where required, W-9, payout setup (ACH or Stripe Connect), business name, backup contact, and capacity (jobs per day). Alert on COI expiry at 30, 14 and 7 days ([ExpirationReminder](https://www.expirationreminder.com/blog/property-management-coi-tracking-critical-guide)). A COI is a snapshot, not proof the policy is still active, so ask for cancellation-notice or periodic re-verification. Washington does not appear to license locksmiths (only a 2011 source, so confirm with L&I). Plumbers and electricians have state licensing, and construction handyman work needs contractor registration. Check L&I before assuming a trade is exempt.

## 6. Lifecycle states and messages to the resident or guest

`reported → triaged → awaiting_manager_approval → offered → accepted → scheduled/en_route → on_site → completed → verified → closed`. Exceptions: `declined`, `timed_out`, `exhausted`, `canceled`, `reschedule`, `disputed`.

| State | Message |
|---|---|
| triaged | "Got it. Checking with the house manager now." |
| approved/offered | "Finding someone for you. You'll hear back shortly." |
| accepted | "Sam from Sam Locksmith is coming at ~2:30pm." (first name only) |
| en_route | "Sam is on the way." |
| exhausted | "No one has confirmed yet. Your manager is handling it and will update you by 4pm." |
| completed | "Done. Is it fixed? Reply YES or NO." |
| NO to "fixed" | Reopen the job and notify the manager. |

Share only the vendor's first name, arrival window and trade with the resident. Never share the vendor's number. Give the vendor only what they need: address, room, first name, entry method.

## 7. Cleaning and tour specifics

**Cleaning turnover**
- A checkout creates the job from the booking calendar (Guesty and Hostaway do this). The offer carries the checkout time, the next check-in time (the deadline), and scope: rooms, kitchen, common areas.
- Same-day turnovers need a hard "done by" and a shorter timeout, plus a backup cleaner notified up front. Flag the job as tight in the offer.
- Include a per-room checklist (beds stripped and remade, bathroom, trash out, supplies restocked), linen instruction (house supply or cleaner-laundered, which costs extra), lost-and-found, and damage or missing-item reporting.
- Require timestamped photos per room, and block completion without them (Properly's model). The manager or an inspector then does a spot check before the next guest.
- Co-living: per-room turnover when one resident leaves, since the house stays occupied. Say so in the offer ("occupied house, quiet hours, enter via lockbox").

**Tour hosts**
- Offer: address, time, 30-minute length, prospect first name, entry method, and pay.
- Pay: showing agents are commonly flat per showing, anecdotally $25–75 ([BiggerPockets](https://www.biggerpockets.com/forums/899/topics/1294620-looking-to-utilize-a-showing-agent)). Showami averages $50 per showing with the agent receiving about $32 ([Showami](https://support.showami.com/hc/en-us/articles/38387065395213-Landlord-Pricing-and-Pay-Per-Showing-Costs)). A $25 offer is at the low end, so expect declines and consider $35 to $50.
- Licensing: some sources say unlicensed showing agents opening properties for buyers is illegal. For rentals the rule is unclear, so confirm Washington's rule with counsel and use a tour host who only opens the door and answers factual questions.
- Self-tour alternative: lockbox or smart-lock one-time codes after pre-screening and ID verification ([Showdigs](https://www.showdigs.com/post/self-guided-rental-tour-scams), [Persona/Rently](https://withpersona.com/customers/rently)). Scammers target self-tours, so keep ID and card checks.
- No-shows: I found no documented policy. **(rec.)** Prospect confirms by text the day before and 1 hour prior. The host waits 15 minutes and reports "no-show". The host is still paid and the prospect is flagged. If the host is a no-show, re-offer to a backup immediately and text the prospect.

## 8. Pitfalls and compliance
- **1099 classification:** a 1099 label does not control. Washington applies L&I's multi-part test (RCW 51.08.195), and a worker who fails it may be owed workers' comp and minimum wage ([L&I](https://lni.wa.gov/forms-publications/F212-250-000.pdf)). Cleaners and tour hosts who work only for you on your schedule are the highest risk. Let vendors set their own price, accept or decline freely, use their own tools, and serve other clients. Have counsel review before scale.
- **Insurance:** collect COIs, verify expiry and limits, and name PropLane and the owner as additional insureds where possible. Keep a dated record.
- **Fair housing for showing agents:** one script and one set of facts for every prospect. Hosts don't screen, steer or answer questions about neighborhood demographics, and any screening questions are asked identically. Seattle applies first-in-time ordering and source-of-income protections ([City Council](https://council.seattle.gov/?p=13233)). Do not let a host decide who is "a good fit."
- **Lockout liability:** never open a door for an unverified caller. Match the person against the lease or house roster, ask for a photo ID plus a selfie, and confirm the room. A locksmith may refuse without it ([Lockrite](https://www.lockrite.org/how-locksmiths-verify-ownership.php)). Never let a locksmith be the sole verifier. Deny and escalate to the manager if the AI can't match.
- **Privacy:** share only the minimum with vendors (first name, room, address, access method). Don't send resident phone numbers unless the resident agrees. Expire codes, and strip details after the job.
- **TCPA consent for texting vendors:** get prior express written consent at onboarding and record it. Honor STOP, QUIT, END, REVOKE, OPT OUT, CANCEL and UNSUBSCRIBE immediately across all lines, and always within the 10 business-day limit ([Infobip](https://www.infobip.com/blog/tcpa-compliance-sms)). Keep dispatch texts strictly transactional, because adding a promotion reclassifies them as marketing. Register the 10DLC campaign. A vendor who STOPs should fall out of every rule automatically, with a manager alert if they were a primary.
- **Other:** the AI never promises prices or arrival beyond what the vendor confirmed. Keep an audit log. Make emergency fallback rules explicit and pre-approved. Don't double-dispatch when broadcast and sequential rules overlap.