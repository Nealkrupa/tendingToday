# Household Site — Notes

A small collection of single-file HTML pages for running the household. Every page
syncs live across devices through the same Firebase project, each writing to its
own document so the pages stay independent of one another.

## File structure

Put all of these in the same folder on your site:

| File | Purpose |
|---|---|
| `index.html` | Bare-bones directory page for your personal site root — currently just a plain link to `home.html` |
| `home.html` | The actual household hub — links out to every page below |
| `tending-today.html` | Daily foundations, zone-of-the-day, monthly rotisserie, pet upkeep |
| `grocery-list.html` | Shared running grocery list |
| `notes.html` | Household notes / corkboard |
| `meal-planning.html` | Weekly ingredients on hand, plus a permanent recipe book with a "this week's plan" toggle |
| `wishlist.html` | Gift wishlists, one section each for the two household members |
| `house-projects.html` | Home improvement projects with checklists, budgets & material costs |
| `contacts.html` | Address book with tap-to-call / tap-to-email |
| `achievements.html` | Star Board — ever-growing gold star sticker board of completions |
| `pet-customize.html` | Hat/skin-color picker for your own pet — reached via the mascot widget's "🎨 Customize" link, not a hub card |
| `auth.js` | Shared Google Sign-In gate used by every page except `index.html` |
| `visits.js` | Shared visit-counter used by every page except `index.html` — powers the hub's most-visited sort |
| `theme.js` | Shared dark mode toggle used by every page except `index.html` |
| `achievements.js` | Shared completion tracker used by every content page — powers the Star Board and each page's own permanent lifetime count next to its header icon |
| `priority-alert.js` | Shared banner used by every page except `index.html` — flags unresolved Critical/High priority notes |
| `mascot.js` | Shared household mascot widget used by every content page (also loaded by `pet-customize.html`) — persistent pixel-art pet per household member, docked at the bottom of the screen |

**Important:** `index.html` is intentionally kept separate and minimal since
this is your personal site's domain — it's just a plain-text directory link
for now, unstyled and ungated, so it can grow into a general directory later
without dragging in the household app's styling or auth. Every household
page's home button links to `home.html`, not `index.html`. If you ever rename
`home.html`, update both the link in `index.html` and the home button `href`
at the top of every other page.

## Google Sign-In (access control)

Every page is now gated behind Google Sign-In, restricted to a specific list of
email addresses — currently two household members' accounts.

That allowlist lives in **`auth.js`**, in the `ALLOWED_EMAILS` array near the
top of the file. To add or remove someone, edit that array — no other file
needs to change.

### One-time setup in the Firebase console

1. **Enable the provider:** Firebase console → your project (`tendingtoday-f30e4`)
   → Authentication → Sign-in method → enable **Google**.
2. **Authorize your domain:** still under Authentication → Settings →
   Authorized domains, add the domain your site is actually hosted on (e.g.
   `yoursite.com`). Without this, `signInWithPopup` will fail on your live site
   even though it might work on `localhost`.
3. **Lock down Firestore rules** so the database itself also requires sign-in
   (the `auth.js` gate only hides the UI — without this step, someone could
   still read/write the data directly). In Firestore Database → Rules:

   ```
   match /household/{document=**} {
     allow read, write: if request.auth != null
       && request.auth.token.email in [
         '<email 1>',
         '<email 2>'
       ];
   }
   ```

   Keep this list in sync with `ALLOWED_EMAILS` in `auth.js` — the JS gate and
   the Firestore rule are two separate checks, and both need updating together
   if you ever add someone.

### How it works on each page

Every page loads three scripts before `auth.js` runs anything:
`firebase-app-compat.js`, `firebase-auth-compat.js`, and `auth.js` itself. Each
page's own script calls `requireHouseholdAuth(load)` instead of calling
`load()` directly — so the page's Firestore code only runs after someone signs
in with an approved account. Until then, a full-screen "Household Sign-In"
card blocks the page, with a **Sign in with Google** button. If someone signs
in with a Google account that isn't on the allowlist, they see a "this account
doesn't have access" message with a sign-out option instead.

## Most-visited sorting on the hub

`home.html` sorts its cards by how often each page has been opened, most
visited first. This is powered by `visits.js`:

- Every content page calls `trackPageVisit('<page-key>')` once, right after
  signing in successfully (see the bottom of each page's script, inside
  `requireHouseholdAuth(...)`).
- Each call increments a counter in `household/page-visit-counts` (one field
  per page, e.g. `tending-today`, `grocery-list`, etc.) using Firestore's
  atomic increment, so concurrent visits from different devices don't race.
- `home.html` reads that document once on load and sorts its card list by
  count, descending. Ties (including the common "everything's at 0" case on a
  fresh install) keep the original manual order, since the sort is stable.

To add a new page later: give it a unique key, call
`trackPageVisit('that-key')` the same way the others do, and it'll start
competing for hub placement automatically — no changes needed on `home.html`
itself beyond adding its card to the `cards` array.

## "Recently updated" indicator on the hub

Every card on `home.html` shows a small "Updated 2h ago" style label under its
description, and the single most recently changed page also gets a filled
dot (●) and a highlighted color so it stands out at a glance.

This is powered by `trackPageUpdate()`, also in `visits.js`:

- Every page's `save()` function calls `window.trackPageUpdate('<page-key>')`
  right after a successful Firestore write — so this fires on genuine content
  changes (adding/editing/removing something), not just on opening the page
  (that's what `trackPageVisit` is for, used by the most-visited sort above).
- Each call writes a server timestamp into `household/page-last-updated`
  (one field per page).
- `home.html` reads that document once on load, converts each timestamp to a
  human-readable relative time ("just now", "3h ago", "2d ago", etc.), and
  compares all of them to find the single most recent one for the dot/highlight.

Note this only reflects changes made *after* this feature was added — pages
that existed before it won't have a timestamp until the next time something
on them is saved, so their card just won't show an "Updated" label until then.

## Star Board (achievements)

`achievements.html` is a permanently-growing gold star sticker board. Unlike
every other page, nothing on it ever resets — it's the one place where the
weekly/daily clearing elsewhere leaves a lasting record.

**How stars are earned.** `achievements.js` exposes
`recordAchievement(key, delta)`, and the task-completing pages call it
at the moment of checking (+1) or unchecking (−1):

- Tending Today: each daily foundation (per-task keys like `daily:bed`),
  the zone of the day (`zone:<zone name>`), each deep-clean rotisserie task
  (`deep:<task text>`), and pet brush passes (`pet:brush`).
- Household Notes: resolving a note (`note:resolved`).
- House Projects: each task (`project:task`), plus a `project:finished`
  milestone when the final open task on a project gets checked (and taken
  back if a task on a fully-complete project is unchecked).

Because unchecking decrements, mis-clicks self-correct — but once a daily or
weekly reset wipes the checkbox, that completion is locked in forever, since
there's nothing left to uncheck.

**Perfect days & streaks.** When the 7th daily foundation gets checked,
`recordPerfectDay()` (a Firestore transaction) records a `day:perfect` star,
at most once per date, and updates the streak: consecutive perfect days grow
`streak.current`, a gap resets it to 1, and `streak.best` keeps the record.
Perfect days are deliberately never revoked once earned, even if a task is
unchecked afterward — revoking would make streak math ambiguous and feels
punitive for a mis-click. `recordPerfectDay()` now also *returns* the
resulting `{current, best}` streak (previously fire-and-forget with no
return value), so a caller can tell in the same round trip whether today's
completion also closed out a 7-day run — see Tending Today's completion
effects below, its only consumer so far.

**Star math.** On the board, each achievement type shows its count as a star
cluster: small star = 1, medium = 10, large = 100 (e.g. 137 → one large,
three medium, seven small). The total across all types is shown at the top.

**Prestige laps.** The named ladder (Bronze → Radiant) is compressed into a
single 0–499 band, so reaching **Radiant (360–499)** is a clean capstone with
no numeral. Every 500 total then starts a new **Prestige lap**
(`level = floor(count / 500)`): the emblem resets to Bronze and climbs the
whole ladder again within that 500-count band. Prestige I is 500–999,
Prestige II is 1000–1499, and so on, uncapped. Each lap recolors the emblem
through a 6-palette cycle (Radiant gold → Crimson → Verdant → Azure →
Amethyst → Obsidian, then wraps) and stamps a white roman-numeral badge, so
the sticker reads like "Gold · II" — the named tier within the lap, plus which
lap. The tier still decides the emblem's *shape* (points, rays, ring); only
the colors follow the prestige palette. Within each named tier the star
cluster grows 1→4, so there's always near-term progress even deep into the
prestige laps.

**Shimmer.** Every prestige emblem (never the base 0–499 ladder) has a soft
diagonal highlight that sweeps across the star on a loop, clipped precisely
to that star's silhouette so it never spills past the points. The shimmer's
color matches the current prestige palette (e.g. pale gold for Prestige I,
soft rose for Crimson/Prestige II), and each star gets a random animation
delay so a cluster of 2–4 stars doesn't glint in unison.

**Milestone trophies.** The first time any achievement crosses 500, 1,000, or
5,000 total, that moment is captured permanently — who did it and on what
date — and never overwritten, even if the task is later unchecked and
re-checked. A trophy badge for each crossed threshold sits under that
sticker forever, showing the full detail directly on the badge itself (e.g.
"🏆 First to 1,000 — [name], [date]") rather than hidden behind a hover tooltip,
so it's just as visible on mobile as on desktop. When a milestone is crossed live, everyone who currently
has the achievements page open sees a one-time celebration banner slide in
from the top ("First to 1,000! — Made the bed — [name], [date]"), auto-dismissing
after a few seconds (or tap to dismiss early). This is powered by comparing
each Firestore snapshot against the previous one client-side — only newly
appearing milestone entries trigger a banner, so reloading the page or
receiving unrelated updates never re-shows an old one. The crossing detection
itself happens inside `achievements.js`'s existing transactions (the same
ones used for `recordAchievement`/`recordPerfectDay`), so two devices
checking things off at the same moment can't both think they were "first."

All counts live in `household/achievements-state` under a `counts` map,
using Firestore atomic increments so simultaneous check-offs from two
devices can't clobber each other.

## Tending Today completion effects

Checking off the last Daily Foundation, or (on a Saturday) closing out a full
7-day perfect-day streak, plays a full-screen celebration and leaves a
persistent, scoped visual reward for the rest of that day — all in
`tending-today.html`, no new Firestore documents.

**Trigger.** The existing click handler for `[data-daily]` already checks
`DAILY_TASKS.every(t => state.daily[t.id])` to call `recordPerfectDay()`; it
now also awaits that call's returned `{current, best}` streak and treats it
as a **perfect week** if `new Date().getDay() === 6` (Saturday) and
`current >= 7` — since a same-day-ending 7-day streak on a Sunday-anchored
week key can only mean every day since that Sunday was perfect, this needed
no new stored data beyond the existing streak. The result is stashed on
`state.perfectWeekAchieved` (reset to `false` alongside `state.daily` on the
next new day in `normalizeAndReset`) so the richer treatment survives page
reloads for the rest of that Saturday, the same lazy-reset pattern used
elsewhere on this page.

**Two-tier reward scale, not one effect scaled up.** An early version made
"perfect week" just a bigger/brighter version of "perfect day" — full-screen
tint and a longer sweep — and it didn't read as a real step up. The fix
follows the pattern the Star Board already uses (shimmer/sweep motion
reserved for genuine milestones, not every tier-up): a perfect day rings +
shimmers **only the Daily Foundations box** (gold); a perfect week does the
same to **every section box** (gold+rose together) and adds a small
faceted star badge — see below — that a plain daily completion never gets.
Scope (one box vs. all of them) carries the "bigger win" signal, not just
louder colors.

**Box-level shimmer geometry.** `.section.fx-glow` / `.fx-glow-week` add a
ring (`box-shadow`) plus a `::after` pseudo-element that sweeps a soft
diagonal gradient across the box on a loop (`box-shimmer-sweep` keyframes),
using `mix-blend-mode: screen` so the highlight lightens whatever's under it
rather than needing a hardcoded color per box background. **Known tradeoff:**
`screen` blending against a *pure white* background can never get any
lighter than white — so on the Daily Foundations box specifically (plain
white `var(--card)` in light mode), the shimmer sweep is invisible; only its
`box-shadow` ring shows. This was tried both ways: a `color-mix()`-based
direct alpha overlay fixed the visibility gap but was reverted back to
`mix-blend-mode: screen` on request. If this needs revisiting, the fix is a
direct translucent overlay (no blend mode) rather than a lightening blend,
since a lightening blend mode is mathematically inert against white
regardless of which highlight color or opacity is used.

The travel distance matters as much as the timing: the sweep's `inset` and
`translateX` range are sized to roughly match the gradient band's own width
(not a much larger virtual canvas), so nearly the whole animated duration is
actually on-screen rather than the band spending most of its cycle sliding
across empty space outside the box before ever becoming visible — that
mismatch was the real cause of an early version feeling like it had "way too
much dead time" between passes, independent of the keyframe percentages
themselves. Current pacing is a short pause at each end
(`0%,6%`/`94%,100%`) with the rest of the cycle spent crossing, 4s for a
perfect day and 2.8s for a perfect week (`FX_GLOW_DURATION` /
`FX_GLOW_WEEK_DURATION` in the JS, must stay equal to the CSS
`animation-duration` values — see sync note below).

**Staying in sync across re-renders.** `render()` rebuilds `app.innerHTML`
from scratch on *every* interaction, even ones unrelated to Daily
Foundations (checking a Zone or Pet Upkeep box, for instance) — which
recreates every `.section` DOM node and would otherwise restart each box's
CSS animation from frame zero, letting multiple boxes' shimmer sweeps drift
out of phase with each other after enough unrelated clicks. Fixed by
`syncedAnimationDelay(durationSec)`: computes `-(Date.now()/1000 %
durationSec)` and sets it as each box's `--fx-delay` custom property (read
by `animation-delay: var(--fx-delay, 0s)`) every time `renderFoundationsFx()`
runs. A negative delay phase-locks the animation to wall-clock time instead
of to whenever the element happened to be created, so freshly recreated
boxes always resume mid-cycle at the same point their siblings are at.

**The perfect-week star badge.** `weekEmblemSVG()` builds a small faceted
star (7 points, rays, a ring, a gold→rose radial gradient body) directly
reusing the silhouette-clipped shimmer technique from `achievements.html`'s
own `emblemSVG` — a diagonal highlight bar clipped to the star's exact
outline via an SVG `clipPath`, so the "big win" state visibly borrows the
Star Board's own prestige marker rather than inventing a new one. It appears
as a fixed corner badge (bottom-right, `#foundations-week-badge`) with a
spring-scale entrance, persists for the rest of a perfect-week Saturday, and
uses a fixed gold/rose palette rather than cycling through the Star Board's
6-palette prestige rotation (a deliberate simplification — this badge marks
one specific milestone, not an open-ended lifetime ladder).

**One-shot intro vs. persistent state.** `playFoundationsEffect(isPerfectWeek)`
plays once, on the click that completes the day/week: a still radial bloom
plus a centered Fraunces message card for a plain day, or a two-tone
diagonal sweep (the same gold→rose motif) plus the star badge's entrance for
a perfect week. `renderFoundationsFx()` is the separate, idempotent
persistent-state function — called at the end of every `render()` — that
derives whether the day/week glow should currently be showing purely from
`state`, with no separate "is it showing" flag to drift out of sync with
the underlying data.

## Permanent per-page progress counts

Every content page's header icon (the plant, basket, pinboard, pot, gift
boxes, house, book) now has a small number to its right — a permanent,
reversible lifetime count of "how many times has this page's core action
happened here," independent of the icon's own fill/empty animation (which
only reflects the *current* list state, and can go back down as items are
checked off or cleared).

This reuses `achievements.js` rather than standing up a second data store.
Each page calls `recordAchievement(key, delta)` at the same moment it
already did for the Star Board (or, for the four pages that had no Star
Board hooks before this, at a newly added trigger point) — the count ticks
up on completion and down if it's undone, exactly like the Star Board's
existing mis-click self-correction. Nothing about the Star Board's own
counts or math changed; this just reads the same `household/achievements-state`
document from a second place.

**Keys, one per page:**

| Page | Key(s) | Fires on |
|---|---|---|
| Tending Today | `daily:*`, `zone:*`, `deep:*`, `pet:brush` (summed together) | Same triggers as the Star Board — already existed |
| Household Notes | `note:resolved` | Same trigger as the Star Board — already existed |
| House Projects | `project:task` | Same trigger as the Star Board — already existed |
| Grocery List | `grocery:item` *(new)* | Checking an item off (not deleting it or bulk-clearing checked items) |
| Wishlist | `wishlist:item` *(new)* | Adding an item (+1) or removing one (−1) |
| Meal Planning | `meal:recipe` *(new)* | Adding a recipe to the recipe book (+1) or deleting one (−1) — not the "this week's plan" checkbox |
| Contacts | `contact:added` *(new)* | Adding a contact (+1) or deleting one (−1) |

**Reading it back.** `achievements.js` exposes two helpers for this:

- `window.subscribeAchievementCounts(cb)` opens a live `onSnapshot` on
  `household/achievements-state` and calls `cb(counts)` immediately with
  whatever's cached, then again on every change from any device — same
  live-sync pattern as `priority-alert.js`.
- `window.sumAchievementCounts(counts, matchers)` sums every key that
  matches an exact key or a prefix ending in `:` (e.g. `'daily:'` matches
  `daily:bed`, `daily:dishes`, etc.), so a page whose number combines
  several achievement keys (like Tending Today) doesn't need to hand-roll
  the same reduce.

Each page stores the latest counts in a local `achievementCounts` variable
(set via `subscribeAchievementCounts` inside `requireHouseholdAuth(...)`,
alongside `initTheme()`/`trackPageVisit()`), and computes its own number
with `sumAchievementCounts` inside `render()`.

**Markup.** The count sits next to the icon inside a shared `.icon-progress`
flex wrapper, styled with a shared `.progress-count` class (IBM Plex Mono,
muted color, tabular numerals) — both added to every page's `<style>` block.

To add this to a new page later: include `achievements.js` (right after
`visits.js`, same as the other four pages that just added it), pick a new
key, call `recordAchievement('your:key', +1)` / `(-1)` at the relevant
add/complete and remove/undo points, subscribe with
`subscribeAchievementCounts` inside `requireHouseholdAuth(...)`, and wrap
the header icon in `.icon-progress` + `.progress-count` like the others.

## Priority alert banner

Every page (except `index.html`) shows a bright red banner at the very top —
sticky, so it stays visible while scrolling — whenever there's at least one
unresolved Critical or High priority note. It reads something like
"2 Critical · 3 High priority notes unresolved" and tapping it goes straight
to `notes.html`. When there's nothing Critical or High outstanding, the
banner simply doesn't render — no empty space, no placeholder.

This is powered by `priority-alert.js`:

- It subscribes live (`onSnapshot`) to `household/household-notes-state` from
  whichever page you're on, independent of that page's own data — so even on
  Grocery List or House Projects, it knows the second a note becomes
  Critical/High (or gets resolved) anywhere in the household.
- It's completely self-contained — it injects its own `<style>` block and
  creates its own DOM element (inserted at the very top of `<body>`, before
  `#app`), so no page's own CSS or markup needed any changes to support it.
- Each page calls `window.initPriorityAlertBanner()` once, right alongside
  `initTheme()`/`trackPageVisit()` in the `requireHouseholdAuth(...)` callback.
- Same two-layer pattern as dark mode: `priority-alert.js` is the **second**
  script tag on every page (right after `theme.js`, before Firebase even
  loads) and immediately paints a cached last-known count from
  `localStorage` the moment it runs — before auth, before the page's own
  "Getting things ready..." loading state. This is what makes the banner
  persist through the sign-in check and the loading flash between pages,
  instead of disappearing and reappearing each time. The live Firestore
  subscription then corrects it with the real count (and refreshes the
  cache) once it loads.

To add this to a new page later: include `<script src="priority-alert.js">`
right after `theme.js` and call `initPriorityAlertBanner()` alongside the
other init calls — no other wiring needed.

## Cancel-alert ticker

A second sticky banner, docked directly below the priority-alert banner
(same row-stacking, not overlapping), shows whenever a Bill or Subscription
on `subscriptions.html` is both checked **"Mark for cancellation"** and
renewing within the next 7 days (including anything already overdue). It
reads something like "1 subscription marked to cancel — ✂️ Netflix (renews
in 3 days)" and tapping it goes straight to `subscriptions.html`.

This is powered by `cancel-alert.js`, a deliberate sibling of
`priority-alert.js` rather than a generalized/shared version of it — same
ticker mechanics (pause, then scroll), same self-contained inject-your-own-
DOM approach, same cache-then-correct-live two-layer pattern, but its own
color (amber, not red), its own icon, and its own Firestore doc
(`household/subscriptions-state`), so each banner stays simple and
independently removable.

- Since both banners use `position: sticky; top: 0`, and CSS doesn't
  auto-stack sticky siblings (a second sticky element at the same `top`
  would just overlap the first, not sit below it), `cancel-alert.js` polls
  `priority-alert-banner`'s rendered height every 300ms and keeps its own
  `top` in sync — 0 when that banner is hidden, its height when shown. A
  cheap poll was simpler and more robust here than coordinating via
  MutationObserver/ResizeObserver across two independently-loading scripts.
- The banner is purely derived from live data — there's no separate
  "dismiss" state. Unchecking "Mark for cancellation," deleting the item, or
  its renewal date rolling outside the 7-day window all make it disappear
  on the next Firestore snapshot, the same way it appeared.
- Include `<script src="cancel-alert.js">` right after `priority-alert.js`
  and call `initCancelAlertBanner()` alongside `initPriorityAlertBanner()`
  to add this to a new page.

## Household mascot

Every content page (everything except `index.html` and `404.html`) shows a
small pixel-art pet widget docked to the **bottom** of the screen — one pet
per household member, side by side. It's self-contained the same way
`priority-alert.js` is: `mascot.js` injects its own `<style>` block and its
own DOM node at the end of `<body>`, so no page's own markup needed to
change. Each page calls `window.initMascotWidget()` once, right alongside
`initPriorityAlertBanner()` inside the `requireHouseholdAuth(...)` callback.

Two progression systems render on the same sprite but never share math, and
both are pure derivations off `household/achievements-state.counts` — the
same lifetime completion total that already powers the Star Board. No new
write hooks were needed anywhere else on the site.

`mascot.js` subscribes to that doc directly (`achievementsRef().onSnapshot(...)`)
rather than through `achievements.js`'s `window.subscribeAchievementCounts` —
it already talks to that same doc directly elsewhere (the AFK/XP grant
transaction), so doing the live read the same way keeps the widget truly
self-contained. This used to be a real bug: `achievements.html` is the one
page that doesn't load `achievements.js` (it reads/renders that doc inline
instead), so `window.subscribeAchievementCounts` was undefined there, and
the mascot widget's life stage and AFK-bank popups silently froze on that
page since its live counts never arrived.

- **Life stage (Fresh → In-Training → Rookie → Champion)** is shared by both
  pets and resets every month. It's driven by completions *since the start
  of the current month*: a stored baseline is diffed against the live
  total (`monthProgress = liveTotal - baselineTotal`), and on month
  rollover the first page load to notice writes a fresh baseline inside a
  transaction — the same lazy, first-writer-wins pattern as Tending
  Today's weekly reset and the Star Board's milestone stamping.
- **Skill levels (Woodcutting / Gardening / Fishing)** are permanent and
  independent per pet. Each user picks which skill is active. Every tracked
  action anywhere on the site grants that skill XP directly and immediately
  — no idle/bank step — tiered by action type (`tierXpForKey()`: a quick
  daily/grocery/zone check-off is worth less than a note/meal/deep-clean
  action, and a perfect day is worth far more). A per-key high-water-mark
  cursor (`lastGrantedCounts`) makes each grant monotonic, so rapidly
  checking and unchecking the same task can't be farmed for repeat XP. The
  level curve is RuneScape's formula, flattened and rescaled so level 99 =
  1,000,000 XP.
- **Tokens** are a separate, uncapped currency — every tracked action also
  earns 1 token (🪙), independent of which skill is active. Tokens spend on
  purchasable AFK-time blocks (1h/2h/5h/10h, priced on a discount curve from
  5 to 35 tokens — while a block is active the prop animates and XP trickles
  in on its own based on real elapsed time, capped to what was actually
  purchased) and on skin colors (see Cosmetics below). Both spends are gated
  behind a native `confirm()` prompt ("Spend N 🪙️ tokens on…") right before
  the click handler calls `purchaseAfkBlock`/`purchaseSkinColor` — the
  purchase functions themselves are unchanged (still transactional, still
  re-check affordability against a fresh Firestore read), the prompt just
  sits in front of the click so a mis-tap can't silently drain the balance.
  Whenever XP or tokens increase — detected by diffing each live Firestore
  snapshot against the
  previous one, same client-side comparison technique the Star Board's
  milestone banner uses — a floating "+&lt;emoji&gt;N" or "+N🪙" popup
  appears over the relevant pet/widget. This fires for both pets
  symmetrically, from whichever device happens to be open when the sync
  lands — it's not limited to "my own pet, only when I personally triggered
  the grant."
- **Cosmetics** are three independent overlays, not per-life-stage art.
  **Milestone skill unlocks (levels 25/50/75/90/99, plus a "completionist"
  tier when every skill hits 99) render as a WoW-style title next to the
  pet's name, not a worn image** — a skill emoji badge, then the tier's
  own title word (e.g. "Ace-Angler"), colored in that skill's fixed hue at
  an escalating vividness per tier, with a `background-clip: text` shimmer
  sweep added only at max tier and a full-hue-cycle shimmer for the
  completionist title ("Pinnacle"). This replaced an earlier version where
  the same unlocks rendered as an actual hat image on the sprite — that
  image-compositing pipeline (`resolveHat`, hat anchors, the hat PNGs) is
  kept in `mascot.js`, not deleted, since it's earmarked for a still-
  unbuilt **purchasable cosmetic hats** feature that reuses the same
  base+trim construction. An **active-skill prop** (axe/rod/trowel) swaps
  automatically with whichever skill is currently set active, rendering
  **in front of** the body. The prop is a simple two-state toggle:
  **working** (animated) for 10 seconds right after an action grants XP, or
  continuously while an AFK block is active; **hidden entirely** otherwise,
  including while the pet is actively wandering (see below), since a held
  tool mid-stride doesn't make sense. Skin color has 4 free, on-theme
  colors plus 7 token-purchasable colors across four price/flair tiers
  (Common/Uncommon/Rare, 5–40 tokens, escalating from no flair to a shimmer
  glow — visible on the equipped pet itself, not just the picker), topped
  by an 80-token Legendary tier (currently just the Rainbow option) that
  smoothly cycles through hues. Title unlock status and the completionist
  check are always computed live from current skill levels, never stored
  as an earned flag — only which title/skin color is currently *equipped*
  is persisted, the same derive-don't-store approach used for life stage.
  Each pet also has an optional **custom display name** (falls back to the
  signed-in household member's own name until set), so an equipped title
  reads as "🐟 Ace-Angler Nibbles" rather than prefixing a person's name.
- **Tinting & smooth color-cycling:** body art ships as grayscale pixel art
  so each pet can have a user-chosen skin color; hat trims (grayscale) get
  their tier color from `achievements.js`'s existing `BADGE_PALETTES`
  prestige cycle. Recoloring is done in an offscreen `<canvas>`
  (`getTintedImage()`): draw the source PNG once, scale each opaque pixel's
  grayscale value by the target color's channels (the same math a CSS
  multiply blend would do), and cache the result as a data URL per (image,
  color) pair. Every plausible (image, color) combination used to be
  precomputed up front on every page load so nothing ever waited on an async
  decode mid-render — but warming ~100+ combinations synchronously the
  moment `mascot.js` loaded turned out to be the actual cause of a real
  page-load stall (a long CPU-bound stretch with zero network activity,
  worse on Chrome and dramatically worse on mobile). That exhaustive
  precompute (`precomputeBodyTints`/`precomputeHatTints`) now only runs on
  `pet-customize.html`, spread across idle time via `requestIdleCallback`
  (see `runIdleQueue`) rather than all at once — the one place someone's
  actually about to browse every option. Everywhere else, the widget only
  ever tints whatever color/hat a pet is *currently* wearing, via the same
  `getTintedImage()` lazy on-demand path (falls back to the plain untinted
  frame for one render if that exact combo isn't cached yet). Since
  canvas-tinted images are static, "smooth" color-cycling (the completionist
  hat's trim, and the Rainbow skin) is simulated rather than a true
  per-pixel interpolation: `buildCyclingLayers()` stacks one pre-tinted
  image per color in the cycle, all sharing one crossfade `@keyframes`
  animation staggered by `animation-delay` so exactly one layer is ever at
  full opacity at a time.
- **Tints persist across page loads, not just within one.** Going lazy
  (above) traded the old page-load stall for a smaller but recurring
  regression: every color/hat combo re-flashed its plain untinted frame for
  one render on every fresh page load, forever, since the in-memory
  `tintCache` starts empty each time. `getTintedImage()` now also checks
  `localStorage` (key `mascotTint:<srcUrl>|<color>`) before falling back to
  the async canvas pass, and writes every freshly computed tint there too —
  one `localStorage` key per combo, not one big JSON blob, so adding a new
  cached tint never has to re-serialize every previously cached one. A
  given (image, color) pair's correct output never changes, and `srcUrl`
  already carries `ASSET_VERSION`, so a future art replacement busts this
  automatically via a new URL rather than ever needing manual invalidation.
  Wrapped in try/catch so a full or unavailable `localStorage` (private
  browsing, quota) just means that one combo re-flashes next load instead
  of failing anything. **This covers every current tinted asset already**
  (body art, hat trims, the completionist/rainbow cycling layers) because
  they all call this one shared function — there's no separate tinting or
  caching path anywhere in the file. It also covers **any future
  customization slot for free**: the cache doesn't know or care what kind
  of asset it's tinting, only the `(srcUrl, color)` pair, so a future
  buyable-body set, tool skins, or any other tintable cosmetic (see
  `notes/mascotScratch_notes.md`'s open ideas) gets the same
  once-ever-per-browser caching automatically, as long as it's rendered
  through `getTintedImage()` rather than a new ad hoc path.
- **Two pets, one household:** both pets earn skill XP and tokens
  independently off the same shared completion total (like two meters
  reading the same water main), so total pet output roughly doubles versus a
  single-pet system — a deliberate tradeoff, not an oversight. Life stage is
  the one thing kept shared, since it's derived from one household-wide
  monthly baseline rather than anything either pet does individually.
- **Widget interaction** is progressive disclosure within the persistent
  widget for everything except cosmetics: tap a pet to see its 3 skill
  levels plus its token balance, a circular "?" button that reveals a brief
  explainer of what tokens/AFK time/skin colors/titles do, and tap a skill
  pill to see that skill's full XP progress and, only on your own pet, a
  "train this skill" control. Setting a skill active and buying AFK time are
  user-initiated writes handled right there in the widget panel.
- **Title/skin-color/name picker lives on its own page**, `pet-customize.html`,
  reached via a "🎨 Customize" link inside your own pet's panel (own-pet-only,
  same as the rest of the pet-editing controls) — not a hub card, since it's
  only ever reached from the widget itself. This used to be an expandable
  section inline in the panel, but rendering every unlocked title and every
  premium color's swatch (each with its own canvas-tinted or gradient
  preview) on every page load meant warming ~100+ tint combinations up front
  just in case someone tapped "Customize" — see the tinting note above for
  why that was actually a real page-load bottleneck, not just a theoretical
  one. Moving the picker to its own page means the exhaustive precompute
  only runs when someone's actually there to use it; every other page only
  ever needs the one color/title combo the pet is currently wearing. The
  page reuses `mascot.js`'s existing helpers directly
  (`window.initPetCustomizer`, `setEquippedTitle`/`setPetName`/
  `setSkinColor`/`purchaseSkinColor`, the same `household/mascot-state`
  writes) rather than duplicating any logic, and its back button (same
  circular icon-button treatment as every other page's home button, just
  with a back-arrow glyph) defaults to `home.html` but upgrades to
  `document.referrer` when that's same-origin, so it returns you to
  whichever page you actually came from. Setting a skill active, buying AFK
  time, and equipping a title/color/name are the user-initiated writes in
  the system beyond life stage — each updates only that one field on your
  own pet, never the whole `pets` map, so it can't clobber the other
  person's pet state.
- **Large static preview on the customize page:** below the picker,
  `pet-customize.html` shows the pet at a much bigger scale (180×180px vs.
  the roaming widget's 56×56px) than anywhere else on the site, sitting in
  the page's normal scrolling flow near the bottom (not a fixed overlay) —
  a themed, similarly-scaled-up ground strip renders behind it using the
  same two-layer light/dark tile technique the roaming widget's own ground
  strip uses, and a dedicated spacer after it guarantees room to scroll and
  see the whole thing regardless of viewport quirks. It's rendered with
  `renderSprite()` — the exact same function the roaming widget uses,
  since that function was already scale-agnostic (pure percentage sizing
  within whatever box it's given) — just with a new `showProp` parameter
  passed as `false`, so the tool/prop never appears: a still preview mid-
  swing would read as a rendering glitch, not the deliberate flourish it is
  live. The one animation kept is the same 2-frame idle breathing swap the
  roaming widget does; no wandering, no tool-working animation. **Note for
  later:** if tool *skins* (alternate prop art, not just the existing
  fixed-per-skill prop) ever ship, this preview is exactly where someone
  would want to see them equipped/compared — `showProp: false` would need
  to become "show the currently-equipped tool skin, statically" instead of
  hiding the prop outright.
- **Wandering:** the widget is a full-width, short ground strip rather than
  a small fixed corner cluster — kept short specifically so it still
  clears centered bottom-of-page controls like home.html's dark mode
  toggle. The ground art is theme-aware: `pet-assets/ground-tile-light-mode.png`
  and `pet-assets/ground-tile-dark-mode.png` are both mounted as stacked
  layers from the start (each already decoded/painted via `opacity`, not
  `display:none` — a `display:none` element defers its own image decode
  until shown, which reintroduces the exact swap delay this two-layer setup
  exists to avoid), and a theme change just toggles which layer is opaque.
  That toggle is wired directly to `window.onThemeChange` (wrapping, not
  overwriting, since that's a single global hook `home.html` already uses
  for its own icon refresh) so it reacts the instant the theme actually
  changes, rather than waiting for the widget's own next incidental
  re-render.
  Each pet glides to a random spot along the strip at a **constant speed**
  (no ease-in/out — duration is purely distance ÷ a fixed px/sec, so a short
  hop and a long traverse move at identical speed), then stays put for a
  random 8–15s — long enough to actually see the tool-working animation —
  before picking a new spot. The glide is driven by a real CSS `transition`
  on `left` (set once per move) rather than recomputed every tick in JS,
  and the sprite mirrors horizontally (`scaleX(-1)`, applied to the whole
  hat+body+prop stack so attachment points stay aligned) based on which way
  it's currently heading. This is purely a local visual flourish: not
  persisted anywhere, not synced across devices/tabs, and resets fresh on
  every page load. The active-skill prop is hidden entirely (not just
  paused) while a pet is actively gliding, regardless of `bankedHours` — see
  the working/resting/hidden note above. The expanded panel is a separately
  fixed-position element (bottom-right corner) rather than anchored to
  whichever pet was tapped, so both pets can keep wandering underneath it
  without the panel itself moving.
  `#mascot-ground` uses `overflow: visible`, not `hidden` — the champion
  life stage's hat is anchored high enough on the sprite (see `STAGES`'
  `head.y` vs. `HAT_ANCHOR_STANDARD`) that it renders above the ground
  strip's own box, so `hidden` was clipping it. This is safe because the
  ground texture layers don't need the clip: background-image painting is
  already confined to an element's own box regardless of `overflow`.
  Picking each pet's next wander target also actively avoids the other
  pet's current spot (`pickWanderTarget`, min separation ~1.3× the sprite
  size, retried a few times and falling back to the largest free gap) so
  the two pets don't settle visually on top of each other.
  Each pet's name/title label renders **above** its sprite (not below —
  the sprite stays anchored to the ground line either way, since `bottom:
  4px` sits on the slot as a whole and the label is just the flex item
  stacked above it). A wide title/name label can still visually brush the
  next pet's even while both sprites sit at their normal, separated resting
  spots (the ~17px gap `MIN_PET_SEPARATION_PX` leaves is comfortable for
  the sprites but not always for text), so `updateMascotNameStacking()`
  deliberately keys off the **sprites'** own live overlap, not the labels' —
  checking label overlap instead made names hop apart well before the pets
  actually met. Sprite overlap only happens transiently while one pet
  glides past the other, i.e. only at the moment they're actually crossing.
  It runs every render tick: sorts pets left-to-right and, for any sprite
  that horizontally overlaps the previous one, nudges that pet's name up an
  extra 14px via `translateY` (cascading further for a third pet if one's
  ever added), snapping back down the moment the sprites clear each other.
  The XP/token "+N" drop
  popups (`showXpPopup`/`showTokenPopup`) spawn from that same name
  label's live bounding rect rather than the sprite's, so they always
  clear the label — including a stacked one — before floating upward,
  instead of rising up through the text.
  When two sprites overlap, the viewer's own pet always paints on top —
  `PET_KEYS` (and so DOM/paint order) is the same fixed `['userA',
  'userB']` on every device, so without this the same pet would always win
  regardless of who's looking. Each slot's `z-index` is set once at
  creation to `1` for `key === widgetState.myPetKey` and `0` otherwise, so
  "on top" follows the viewer rather than being a global, device-
  independent ordering. Separately, a
  debounced `resize` listener re-clamps any pet whose `x` has fallen
  outside the ground's current walkable width (e.g. after a mobile
  orientation change or address-bar collapse/expand) — without it, a pet
  already near the old, wider edge could render past the new, narrower one
  until its next move happened to start, up to `MAX_STATIONARY_MS` later.
  The snap-back bypasses the CSS transition so it doesn't visibly glide in
  from off-screen.
- All of this lives in its own `household/mascot-state` document rather
  than folded into `achievements-state`, since it's a distinct concern
  (derived/cosmetic state vs. the permanent completion ledger) and keeps
  write contention off a document every other page already transacts
  against constantly.

Current spec (thresholds, data model, art spec, asset naming) lives in
`notes/mascotSpec_notes.md`; the full design rationale/history (why
each number is what it is, bugs found and fixed, XP curve math) lives in
`notes/mascotHistory_notes.md`.

## Dark mode

The dark/light toggle lives in a single place: a pill button at the **bottom
of the home page** (`home.html`). The other pages have no toggle of their own
— they still load `theme.js` and call `initTheme()`, so they apply whatever
theme is active, but you change it from the hub. It's all powered by
`theme.js`.

When the theme changes, `theme.js` calls an optional `window.onThemeChange`
hook if the page defines one; the home page uses this to re-render so the
bottom toggle's icon (sun vs. moon) and label stay in sync after theme.js's
async Firestore fetch resolves. This fixes an earlier bug where returning to
the home page in dark mode showed a stale moon icon.

**Two layers, so the sign-in screen isn't stuck in light mode:**

- **Instant local guess:** `theme.js` is loaded as the very first script on
  every page (before Firebase, before `auth.js`) and, the moment it runs,
  applies whatever theme this browser used last time — read from
  `localStorage` — to `<html data-theme="...">`. This is a same-browser cache
  only, used purely so the very first thing painted (the sign-in screen, the
  loading state) already looks right, not the canonical answer.
- **Authoritative account preference:** once someone's signed in, each page
  calls `window.initTheme()`, which fetches the real preference for that
  *account* from `household/theme-preferences` in Firestore and corrects the
  theme if it's different from the local guess (e.g. you changed themes on
  your other device). This is what makes the preference follow a person
  across devices — the localStorage cache never syncs anywhere on its own.

**Why `<html>` and not `#app`:** the sign-in overlay from `auth.js` is
attached directly to `<body>`, outside `#app`, so an override scoped to
`#app[data-theme="dark"]` never reached it. Every page's dark CSS is scoped
to `html[data-theme="dark"] { ... }` instead, and `auth.js`'s own gate styles
were rewritten to use `var(--bg)`, `var(--card)`, `var(--ink)`, `var(--muted)`,
`var(--line)`, and `var(--sage)` — the same variables each page already
defines at `:root` — so the sign-in screen inherits whichever theme is active
automatically, with no separate dark styling to maintain in `auth.js` itself.

**Mechanics recap:**
- Clicking the toggle calls `window.toggleTheme()`, which flips the theme,
  updates the button's icon, writes the new value to Firestore for that
  account, and refreshes the local cache.
- Because every style rule on every page already references colors via
  `var(--x)`, one `html[data-theme="dark"] { --bg: ...; --card: ...; }` block
  per page re-themes everything on it — no need to touch individual
  component styles.
- The one exception is `home.html`, which has four hardcoded (non-variable)
  background colors on its Meal Planning / Wishlist / House Projects /
  Contacts cards. Those get their own explicit dark-mode override lines
  right after the main variable block.

To add dark-mode support to a new page later: copy the
`html[data-theme="dark"] { ... }` block from an existing page (adjusting only
the extra accent variables that page defines), add the toggle button markup
next to the home button, wire up its click handler in `bindEvents()`, and
call `initTheme()` alongside `trackPageVisit()`. Keep `theme.js` as the very
first script tag on the page.

## "Added by" attribution

Grocery items, notes, wishlist entries, recipes, and House Projects
(both the project itself and each task) now show a small tag noting who
added them — e.g. "— [name]" or "Added by [name]" — using whoever is currently
signed in.

This is powered by two things working together:

- **`auth.js`** exposes `window.getHouseholdUserLabel()`, which maps the
  signed-in account's email to a short display name via the `EMAIL_LABELS`
  map near the top of the file (mapping each household member's email to
  their first name). If an email isn't in that map, it falls
  back to the Google account's first name, or the raw email as a last resort.
  Keep this map in sync with `ALLOWED_EMAILS` if you ever add a third person.
- Each page's "add" function calls `window.getHouseholdUserLabel()` at the
  moment something is created and stores it on that item as `addedBy`. It's
  a snapshot taken once at creation — editing an item later doesn't change
  who it's attributed to, and there's no attribution on edits, only on the
  original add.

Attribution is intentionally **not** included on Contacts, House Projects'
materials list, or ingredients/meal-plan selections in Meal Planning — those
felt more like shared reference data than "who submitted this" data. Follow
the same `addedBy` pattern (default it to `''` in `normalize()`, stamp it at
creation, render it conditionally) if you'd like to extend it to those later.

## How syncing works

Each page loads the Firebase compat SDK from a CDN and talks to **Cloud
Firestore**. There's no login — every visitor reads/writes the same documents,
which is what makes the live cross-device sync work with zero setup on your end
beyond the Firestore rules below.

- **Project:** `tendingtoday-f30e4`
- **Collection:** `household`
- **One document per page**, all in that same collection:

| Page | Firestore document |
|---|---|
| Tending Today | `household/tending-today-state` |
| Grocery List | `household/grocery-list-state` |
| Household Notes | `household/household-notes-state` |
| Meal Planning | `household/meal-planning-state` |
| Wishlist | `household/wishlist-state` |
| House Projects | `household/house-projects-state` |
| Contacts | `household/contacts-state` |
| Subs & Bills | `household/subscriptions-state` |
| Star Board | `household/achievements-state` — permanent completion counts + streak, also read by every page's own header count |
| *(hub sorting)* | `household/page-visit-counts` — one field per page, incremented on each visit |

Each page does a one-time `get()` on load, then subscribes with `onSnapshot()`
so changes from any other open tab/device show up instantly. Every write is a
full `.set()` of that page's whole state object (simple last-write-wins — fine
for a household-scale app, not built for heavy concurrent editing).

### Firestore rules

Rules need to allow read/write across the **whole `household` collection**, not
just one hardcoded document ID, since each page uses its own document:

```
match /household/{document=**} {
  allow read, write: if true; // replace with real auth rules if you ever add login
}
```

If a page ever shows "Couldn't connect — check your connection and reload,"
the most likely cause is Firestore rules scoped too narrowly to a single
document ID rather than the collection wildcard above.

## Page-by-page notes

**Tending Today** — daily checklist resets each day; the "zone of the day"
rotates by day of week; the monthly rotisserie cycles through 12 deep-clean
tasks one per week; pet brushing tracks 3 passes/week. Weekly items reset based
on an ISO-ish week key computed from the date. Completing all Daily
Foundations (and, on Saturday, a full 7-day streak) triggers a full-screen
celebration and a persistent scoped shimmer — see "Tending Today completion
effects" above.

**Grocery List** — plain add/check/remove list. Checked items sink to the
bottom and can be bulk-cleared with "Clear checked."

**Household Notes** — styled as a corkboard, with three independent active
sections stacked in a fixed order: **On our minds**, **Nat's thoughts**, then
**Website requests**. Each has its own add form and its own priority pill
(Critical/High/Medium/Low, driving auto-sort within that section), and a
note's `section` field is set once at creation and doesn't change afterward.
Checking a note off in any of the three moves it into one shared **Completed
this week** list at the bottom (sorted the same priority-first way, tagged
with which section it came from) — that combined list is what clears itself
automatically at the start of each new week, not each section individually.

**Meal Planning** — two independent stores:
- *Ingredients on hand* (`state.ingredients`) clears itself automatically at
  the start of each new week (same week-key logic as Tending Today). Each
  ingredient can optionally carry a **category tag** (small inline-editable
  pill, same treatment as Contacts' category tag) and a **comment** (same
  dashed-top-border textarea style used for recipe notes) — both are set
  after adding, not part of the quick add form, and both clear along with
  the ingredient itself at the weekly reset since they live on the same
  object.
- *Recipe book* (`state.recipes`) is permanent — recipes accumulate
  indefinitely until manually deleted. Each entry has a title, an optional
  link, optional details/notes, and who added it. If a page is still running
  on older data from before this was unified (separate `mealIdeas` and
  `recipeLinks` arrays), it auto-migrates into this single array on next load.
- Checking a recipe's checkbox sets `selected: true`, which adds it to
  "This Week's Plan" at the top of the page; unchecking removes it from the
  plan without deleting the recipe itself. The plan isn't stored separately —
  it's just the recipe book filtered by `selected`, and it clears itself the
  same way ingredients do at the start of a new week.
- A search box filters the recipe book by title, details, or link.

**Wishlist** — two independent sections, one per household member, each with
its own add form (name + optional link). Deliberately has **no "purchased"
checkbox** — since everyone views the same synced page, marking something
bought would spoil the surprise for the person whose list it is.

**House Projects** — create any number of projects. Each has an editable
title, a task checklist with a progress bar, an optional budget, and a
materials list where each cost is independently editable and optional (blank
shows as "—", not $0). The header art is a house that's built stage-by-stage
(foundation → walls → roof → door/windows → chimney) based on the fraction of
tasks completed **across all projects combined**.

**Contacts** — name (required) plus optional phone, email, and category.
Every field is inline-editable — click in, edit, then click away to save.
Phone numbers are `tel:` links, emails are `mailto:` links, and there's a
search box that filters by name/category/phone/email. Sorted alphabetically
by name.

**Subs & Bills** (`subscriptions.html`) — four independent flat lists, in
order: **Subscriptions**, **Amazon** (autoship), **Chewy** (autoship), and
**Bills**. Same fields on all four: name, cost, a billing cadence, renewal
date, optional category, optional notes, and a "Mark for cancellation"
checkbox. A page-wide total sits above all four sections — combined item
count plus one blended monthly/yearly figure across everything, e.g. "8
recurring costs for $142 a month, $1,704 a year" — separate from each
section's own cost line, since "how much am I spending overall" and "how
much is each category" answer different questions; both reuse the same
`costSummary()` function (called once per section, once again over all
sections concatenated together), just with a generic "recurring cost(s)"
noun for the page-wide one instead of a section-specific noun. The `SECTIONS`
array drives everything generically — normalization, rendering, the add
form, achievement keys (`<section-key>:added`) — so adding a fifth section
later is one array entry, not scattered special-casing. Each item also has a
"Move…" dropdown (next to its remove button) listing every *other* section —
picking one splices the item out of its current section's array and pushes
it, fields intact, onto the target section's array, and shifts that one
item from the old section's `<section-key>:added` achievement count to the
new one's (a re-categorization, not a delete+re-add, so nothing about the
item itself — cost, cadence, notes, "marked for cancellation" — is touched).
The cadence is a custom interval —
`cycleUnit` (week/month/year) + `cycleInterval` (any positive integer) — not
a fixed monthly/yearly toggle, so "every 3 months" or "every 5 weeks" is
just `{cycleUnit: 'month', cycleInterval: 3}` / `{cycleUnit: 'week',
cycleInterval: 5}`. Older data saved before this existed (a fixed
`cycle: 'monthly'|'yearly'` field) is migrated in place on load — mapped to
`cycleInterval: 1` in the matching unit, then the old field deleted.
Each section sorts by soonest renewal date and shows one true cost total
expressed in both units — "3 subscriptions for $45 a month, $540 a year" —
rather than separate per-cycle sums, so a mix of weekly/monthly/yearly items
still collapses into a single comparable figure; every cadence is converted
through `occurrencesPerYear(unit, interval)` (e.g. every 3 months = 4/year,
every 5 weeks ≈ 10.4/year) to get there. `renewalDate` always holds the
*next* upcoming due date: any date that's fallen into the past gets rolled
forward one cadence-interval at a time on page load (handles a
long-untouched app catching up several cycles at once), the same lazy-reset
pattern Tending Today's weekly reset and the mascot's monthly baseline
already use — there's no manual "mark as paid/renewed" step. Checking "Mark
for cancellation" on an item renewing within the next 7 days surfaces it in
the site-wide cancel-alert ticker (see above) until it's unchecked, deleted,
or its renewal date moves back outside that window. Deleting an item that
was marked for cancellation (as opposed to just unmarking or deleting one
that wasn't) also records one permanent `cancel:completed` Star Board
milestone — a "cancellation actually followed through," never decremented,
same one-way semantics as the mascot's perfect-day streak.

## Visual system

Every page shares the same base tokens (Fraunces for display type, Inter for
body, IBM Plex Mono for eyebrows/labels/counts) and card-on-tinted-background
layout, but each has its own accent color and a small "growing/filling" icon in
the header that reflects that page's progress, plus (as of the permanent
progress counters above) a lifetime number just to its right:

| Page | Accent | Header icon behavior |
|---|---|---|
| Tending Today | Sage green | Plant grows as daily tasks are checked off |
| Grocery List | Warm gold | Basket fills with unchecked items, empties as they're checked off |
| Household Notes | Rose | Pinboard fills with pins as unresolved notes pile up |
| Meal Planning | Dusty blue | Pot fills with veggies as the ingredients list grows |
| Wishlist | Plum | Stack of gift boxes builds as items are added across both lists |
| House Projects | Clay/terracotta | House builds in stages as tasks are completed |
| Contacts | Teal | Address book fills with tabs as contacts are added |
| Subs & Bills | Slate blue-gray | Stack of receipts builds as bills/subscriptions are added |

## Cache-busting shared scripts

Every shared `.js` file (`theme.js`, `priority-alert.js`, `cancel-alert.js`,
`auth.js`, `visits.js`, `achievements.js`, `mascot.js`) is referenced with a
version query string, e.g. `<script src="theme.js?v=1"></script>`.

This is because browsers cache `.js` files aggressively and have no way to
know the *contents* changed just because you re-deployed — the URL
`theme.js` looks identical to the browser whether it's today's version or
last month's, so it may keep serving a stale cached copy indefinitely. A
version query string forces a fresh fetch, because `theme.js?v=2` is a
completely different URL from `theme.js?v=1` as far as the browser's cache
is concerned.

**Whenever you edit any of these shared files, bump its version number in
every page that references it**, e.g. change every `theme.js?v=1` to
`theme.js?v=2`. Otherwise people's browsers may keep running the old version
of that script indefinitely, even after a successful deploy — this is a
different problem from a failed deploy, and much harder to notice, since
everything *looks* like it worked.

The same problem applies to the `pet-assets/*.png` files `mascot.js` loads,
since the filename itself never changes when the art does. Those go through
a separate `ASSET_VERSION` constant near the top of `mascot.js` (currently
`'v=7'`) rather than a `<script>` tag's query string — every `assetUrl()`
call appends it automatically. **Whenever any pet-assets PNG is replaced in
place, bump `ASSET_VERSION`** (and, since that's an edit to `mascot.js`
itself, bump its own script-tag version too, per the rule above).

## Extending this later

- To add a new page: copy an existing page as a starting point, give it its own
  Firestore document name (don't reuse one), include `auth.js` and `visits.js`
  and gate it with `requireHouseholdAuth` (calling `trackPageVisit('key')`
  inside that callback), add a home button pointing at `home.html`, and add a
  card for it on `home.html`.
- All state is plain JSON in Firestore — you can view/edit it directly in the
  Firebase console under Firestore Database → `household` collection if you
  ever need to fix something by hand.
