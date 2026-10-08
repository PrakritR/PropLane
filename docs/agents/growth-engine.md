# Growth engine (PropLane's own social content pipeline)

Admin-only feature at `/admin/growth`. It publishes PropLane's marketing posts, not managers' listings
(that is listing syndication, `docs/agents/listing-syndication.md`; the growth engine only reuses its
Meta Graph client). Plan of record: studio plan `claude-1/growth-engine-1007`.

## The loop

1. **Ideas** (`growth_ideas`): seeded from positioning/features/tips/local/founder angles; weights
   re-set nightly by the learn step.
2. **Draft** (cron `growth-draft`, nightly): picks 3 ideas by weight, Claude writes hook, script,
   scenes, per-platform captions in the voice guide (below). Post → `drafted` → `review`.
3. **Assets / render** (Phase 2, on the cockpit Mac via launchd): Veo clips, product shots, voice,
   Remotion render → `growth_assets` in the public storage bucket `growth`.
4. **Review** (admin UI): approve → `approved` (+ `scheduledFor`) → `scheduled`. Send back → `drafted`
   with `reviewNote`. **Nothing publishes without an admin approval row.**
5. **Publish** (cron `growth-publish`, every 5 min): every `scheduled` post whose time has passed →
   one `growth_publications` row per platform → the configured publisher driver. Per-platform
   failure never fails the others; a paused/disconnected account pauses only its platform.
   Idempotent on `(post_id, platform)`; retries with backoff up to 3 attempts, then `failed`.
6. **Insights** (cron `growth-insights`, nightly): pull metrics into `growth_metrics` for publications
   published in the last 30 days, at most 50 per publisher per tick (newest first), so the vendor call
   count stays bounded; write one `growth_learned` line per clear signal; re-weight ideas. A per-media
   fetch failure is logged (`console.warn`, never the token) and retried next run.
7. **Digest** (part of `growth-draft`): 8am PT email to admins listing posts in `review` with links
   into the admin UI. Approval always happens in the UI with an admin session; no token-approve links.

## Publishers

`GROWTH_PUBLISHER` env selects the default driver: `log` (default when unset; writes the DB row and a
fake id, for local dev and proofs), `late` (getlate.dev REST, `GROWTH_LATE_API_KEY`),
`upload_post` (`GROWTH_UPLOAD_POST_API_KEY`), `meta` (Instagram/Facebook direct, image posts only in
Phase 1, reusing `src/lib/listing-channels/meta/graph.server.ts`). A `growth_accounts.publisher`
value overrides the default per account.

## Security

- Every `/api/admin/growth/*` route calls `requireAdminRoute()` first; crons use the same
  `CRON_SECRET` bearer check as `dispatch-reminders`.
- `growth_*` tables: RLS enabled, **no** policies for `anon`/`authenticated` (deny all); server code
  uses the service-role client after the admin check. The PostgREST surface is public, so this is a
  hard requirement, not a default.
- No tokens in `growth_accounts`; vendor keys live in env only. Prompts never include customer data.
- Generated media never depict real properties or people as customers.

## Voice guide (in the draft prompt)

Plain, specific, a little dry. Says what the product does; never invents stats, customer names or
testimonials. Roles, not people ("the manager", "the resident"). One ask per post. No emoji walls,
no "game-changer". Regulated notices are never claimed to be automated. Product name is PropLane.
Positioning line: a property manager's main job is relaying messages between residents, vendors and
owners; PropLane's assistant drafts every relay and the manager approves.

## Cadence (Decision 2, approved)

1 reel per weekday (Instagram + TikTok + YouTube), 2 carousels/week, 3 LinkedIn/week, 1 X/day.
Default slots: reels 09:00 PT, X 12:30 PT, LinkedIn 08:00 PT, carousels 17:00 PT.

## Admin UI

`/admin/growth` with tabs `queue` (default), `calendar`, `post/[id]`, `accounts`, `analytics`.
Lists use `PortalRecordListSurface` (admin borrows, never invents); the queue is a status board of
cards, not a table. Empty, loading and error states as drawn in the plan.

## API (admin session required)

- `GET  /api/admin/growth/posts?status=…`            list
- `POST /api/admin/growth/posts`                      create manual post `{title, format, platforms}`
- `GET/PATCH /api/admin/growth/posts/[id]`            read / edit fields (title, hook, script, scenes, captions, platforms, scheduledFor)
- `POST /api/admin/growth/posts/[id]/approve`         `{scheduledFor?}` → approved/scheduled
- `POST /api/admin/growth/posts/[id]/send-back`       `{note}` → drafted
- `POST /api/admin/growth/posts/[id]/archive`
- `POST /api/admin/growth/posts/[id]/regenerate`      re-run the draft step for this post
- `POST /api/admin/growth/publications/[id]/retry`
- `GET/POST /api/admin/growth/accounts`, `PATCH /api/admin/growth/accounts/[id]` (status/paused)
- `GET  /api/admin/growth/ideas`, `POST` (manual idea), `PATCH /[id]` (weight/notes)
- `GET  /api/admin/growth/analytics`                  totals + per-post table + learned lines
- `POST /api/admin/growth/draft-now`                  run the draft step on demand (admin)

## Env

`GROWTH_PUBLISHER`, `GROWTH_LATE_API_KEY`, `GROWTH_UPLOAD_POST_API_KEY`, `GROWTH_DIGEST_TO`
(comma list; defaults to admin emails), `ANTHROPIC_API_KEY` (existing), `CRON_SECRET` (existing).

## Phases

Phase 1 (this): tables, ideas, draft, review UI, publish (log/late/meta-image), digest, insights
shell. Phase 2: reel studio (Veo/Kling, ElevenLabs, Playwright shots, Remotion, Meta Reels
container flow). Phase 3: learn loop + engage list. Auto-follow/auto-like/auto-DM are out of scope
permanently (platform terms).

## Phase 2 contract: reel studio

- **Scenes** stay `GrowthScene` (kinds generated / template / shot / still). Each scene produces one
  `growth_assets` row of kind `clip` (generated), `shot` (Playwright recording), or none (template,
  rendered inside Remotion). The voice track is one asset of kind `voice`; the final reel is kind
  `video` with `meta.captions` (word timings) and `meta.sceneAssetIds`.
- **Drivers** (`src/lib/growth/video/`): `veo.server.ts` (Gemini API, `GEMINI_API_KEY`),
  `kling.server.ts` (fal.ai, `FAL_KEY`), `elevenlabs.server.ts` (`ELEVENLABS_API_KEY`,
  `GROWTH_VOICE_ID`). Each exports a pure function taking a prompt/text and returning
  `{ url | buffer, durationMs, meta }`; each throws a typed `MissingKeyError` when its key is unset so
  the orchestrator can skip the scene (fallback: a template scene with the same text).
- **Product shots** (`scripts/growth-shots.mjs`): Playwright against the showcase account on a local
  server, 1080×1920 device scale, records the route + action named in `scene.direction`, writes
  `mp4`/`webm` to `output/growth/<postId>/scene-<n>.webm`.
- **Render** (`remotion/growth/`): one `Reel` composition (1080×1920, 30 fps) that takes the post,
  its scene assets and the voice timings as props; burned captions (word-timed when voice exists,
  per-scene text otherwise), brand cobalt, PropLane mark end card, no music unless
  `meta.music` is set. `scripts/growth-render.mjs <postId>` fetches the post via the service client,
  runs the drivers for missing assets, records shots, renders, uploads the mp4 to the `growth` bucket,
  inserts the `video` asset, and flips the post from `review` to `review` with `meta.rendered=true`
  (never changes approval). Also renders 1080×1350 stills for carousel/image posts.
- **Host**: `ops/launchd/com.proplane.growth-render.plist` runs `scripts/growth-render.mjs --pending`
  at 02:00 local on the cockpit Mac; Vercel never renders.
- **Publishing reels**: `publishers/meta.server.ts` gains the Reels container flow
  (`POST /{ig}/media media_type=REELS video_url=…`, poll `status_code` until FINISHED, then
  `media_publish`); `late`/`upload_post` pass the video URL through.
- **Admin UI**: a `Reel studio` tab on the post detail (scenes with kind, status pill, thumbnail,
  Regenerate / Swap for product shot / Render buttons, estimated cost line) and a muted video player
  of the rendered reel.
- **Proof without keys**: a reel whose scenes are template + shot renders to a playable mp4 locally
  with burned captions; drivers unit-tested with mocked HTTP; Meta container flow unit-tested with a
  fake fetch.

## Render runbook

- Render one post: `node scripts/growth-render.mjs <postId>`; nightly set: `--pending` (review/approved/scheduled
  reel/carousel/image posts not rendered for their current content, by `growth_posts.meta.renderSignature`, plus any
  post the Reel studio's Render button flagged with `meta.renderRequested`, which a successful render clears). It never
  changes approval status. Output: `output/growth/<postId>/final.mp4` (Reel 1080x1920) or `final.png` / `final-<n>.png` (Card 1080x1350).
- No AI keys needed: a `generated` scene falls back to a template scene (`meta.fallbacks` on the video asset), voice is
  skipped (per-scene burned captions). With keys, `veo`/`kling`/`elevenlabs` drivers are loaded by dynamic import.
- Product shots need the showcase manager (`npm run app-store:seed`, SHOT_EMAIL/SHOT_PASSWORD) and a dev server on :3007
  (`--base`); direction format `route:/portal/dashboard action:click[data-demo-target=approve]`. Non-localhost refused.
- Rendering uses Playwright's Chromium (no Remotion browser download); bundled ffmpeg lacks the `fps` filter.
- Needs migration `20261008120000_growth_posts_meta.sql` (applied to dev/test with `supabase db query --linked -f`).
- Launchd: `ops/launchd/com.proplane.growth-render.plist` (02:00 daily; edit WORKTREE_PATH; not loaded by default).
- Remotion is free for companies of 3 or fewer; revisit its license when the team grows.
