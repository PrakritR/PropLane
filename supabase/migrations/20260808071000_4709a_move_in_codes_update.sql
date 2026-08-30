-- 4709A 8th Ave NE: front door code 001000, per-room locker combos, drop pantry/backup from houseDescription.
-- Idempotent: safe to re-run (scoped to a single property id).
--
-- FIX: the original revision quoted every string literal with double quotes,
-- which Postgres reads as identifiers, so `to_jsonb("...text..."::text)` failed
-- with `column "..." does not exist` and the migration never applied on any
-- project. Rewritten with `E'...'` literals so the embedded `\n` render as
-- newlines exactly like the sibling Brooklyn migrations; content is unchanged.

update public.manager_property_records
set
  property_data = jsonb_set(
    jsonb_set(
      jsonb_set(
        property_data,
        '{listingSubmission,generalHouseInfo}',
        to_jsonb(E'Front door code: 001000\n\nWiFi Username: 4709A\nWiFi Password: 4709A4709A$$\n\nHouse Groupchat: https://chat.whatsapp.com/JVe6jPceStL8pGDBSsVQBB?mode=gi_t\n\nServices:\nIf something in your room or the house breaks or needs attention, this is how you flag it. Head to Services, hit "Report maintenance," describe the issue, set a priority, and note when you''re free for someone to come by. Your property manager gets notified automatically — no need to text or call anyone.\nNeed something extra during your stay? Services lets you request add-ons directly through the portal. Current offerings include luggage storage ($5/piece), room cleaning ($10), and a bedding set (free for short stays under 5 days, $30 for long-term). Just select what you need and send the request — no chasing down the manager.\n\nPayments, Lease & Inbox:\nPay rent, review your lease terms, and communicate with your property manager all in one place — everything documented and accessible anytime. Additionally if you want to extend lease can do through lease tab.'::text),
        true
      ),
      '{listingSubmission,houseDescription}',
      to_jsonb(E'Front door code: 001000.'::text),
      true
    ),
    '{listingSubmission,rooms}',
    (
      select coalesce(
        jsonb_agg(
          case elem->>'id'
            when 'seed-4709a-room-1' then jsonb_set(elem, '{moveInInstructions}', to_jsonb(E'Assigned to Room 1.\n\nAccess codes:\nFront door code: 001000\n\nLocker box combination: 8916566666\n\nUse front door code 001000. Your bedroom is Room 1.'::text), true)
            when 'seed-4709a-room-2' then jsonb_set(elem, '{moveInInstructions}', to_jsonb(E'Assigned to Room 2.\n\nAccess codes:\nFront door code: 001000\n\nLocker box combination: 7820341022\n\nUse front door code 001000. Your bedroom is Room 2.'::text), true)
            when 'seed-4709a-room-3' then jsonb_set(elem, '{moveInInstructions}', to_jsonb(E'Assigned to Room 3.\n\nAccess codes:\nFront door code: 001000\n\nLocker box combination: pending — your property manager will send it before move-in.\n\nUse front door code 001000. Your bedroom is Room 3.'::text), true)
            when 'seed-4709a-room-4' then jsonb_set(elem, '{moveInInstructions}', to_jsonb(E'Assigned to Room 4.\n\nAccess codes:\nFront door code: 001000\n\nLocker box combination: 9031576091\n\nUse front door code 001000. Your bedroom is Room 4.'::text), true)
            when 'seed-4709a-room-5' then jsonb_set(elem, '{moveInInstructions}', to_jsonb(E'Assigned to Room 5.\n\nAccess codes:\nFront door code: 001000\n\nLocker box combination: 2216261232\n\nUse front door code 001000. Your bedroom is Room 5.'::text), true)
            when 'seed-4709a-room-6' then jsonb_set(elem, '{moveInInstructions}', to_jsonb(E'Assigned to Room 6.\n\nAccess codes:\nFront door code: 001000\n\nLocker box combination: 9187794484\n\nUse front door code 001000. Your bedroom is Room 6.'::text), true)
            when 'seed-4709a-room-7' then jsonb_set(elem, '{moveInInstructions}', to_jsonb(E'Assigned to Room 7.\n\nAccess codes:\nFront door code: 001000\n\nLocker box combination: 8357106792\n\nUse front door code 001000. Your bedroom is Room 7.'::text), true)
            when 'seed-4709a-room-8' then jsonb_set(elem, '{moveInInstructions}', to_jsonb(E'Assigned to Room 8.\n\nAccess codes:\nFront door code: 001000\n\nLocker box combination: 3282362130\n\nUse front door code 001000. Your bedroom is Room 8.'::text), true)
            when 'seed-4709a-room-9' then jsonb_set(elem, '{moveInInstructions}', to_jsonb(E'Assigned to Room 9.\n\nAccess codes:\nFront door code: 001000\n\nLocker box combination: 0831979973\n\nUse front door code 001000. Your bedroom is Room 9.'::text), true)
            when 'seed-4709a-room-10' then jsonb_set(elem, '{moveInInstructions}', to_jsonb(E'Assigned to Room 10.\n\nAccess codes:\nFront door code: 001000\n\nLocker box combination: 7088326848\n\nUse front door code 001000. Your bedroom is Room 10.'::text), true)
            else elem
          end
          order by ord
        ),
        '[]'::jsonb
      )
      from jsonb_array_elements(property_data #> '{listingSubmission,rooms}') with ordinality as t(elem, ord)
    ),
    true
  ),
  updated_at = now()
where id = 'mgr-seed-4709a-8th-ave-ne';
