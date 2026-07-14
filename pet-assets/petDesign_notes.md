# Household Mascot — Design Notes (in theory, not yet built)

A persistent widget-level pet, separate from the existing "pet upkeep" feature on
Tending Today (`pet:brush`). Lives at the bottom of the screen on every household
page, the same way `priority-alert.js` lives at the top of every page today —
self-contained script, injects its own DOM/CSS into `<body>`, no page's own
markup needs to change.

No dedicated page for now. All interaction happens through the widget itself
(tap-to-expand for skill selection / progress), not a nav card on `home.html`.

## Two independent progression axes

The mascot has two separate systems that render on the same sprite but never
interact with each other's math. Both are pure derivations off the existing
`household/achievements-state.counts` total (the same sum that already powers
the Star Board) — no new write hooks are needed anywhere else on the site.

### 1. Life stage (cosmetic body, resets monthly)

Four stages: **Fresh → In-Training → Rookie → Champion**.

- Driven by the household's all-time completions total, but only the portion
  earned *since the start of the current month* — the underlying lifetime
  total in `achievements-state` is never touched or decremented.
- Computed the same way the Star Board's milestones are stamped: a stored
  baseline is diffed against the live total.
  `monthProgress = liveTotal - baselineTotal`
- State: `{ monthKey: '2026-07', baselineTotal: 48213 }`
- On month rollover, the first client to notice writes a fresh baseline
  (`monthKey` = new month, `baselineTotal` = current live total) inside a
  transaction, first-writer-wins — same lazy pattern as Tending Today's
  weekly reset and the Star Board's milestone stamping. No cron/cloud
  function needed.
- **Thresholds: Fresh 0–9 → In-Training 10–79 → Rookie 80–299 → Champion
  300+.** Calibrated off an expected 250–400 tasks/month (~8.3–13.3/day
  over 30 days):
  - T1 (In-Training, 10) is crossed within the first 1–2 days regardless of
    pace, so Fresh is little more than the very start of the month.
  - T2 (Rookie, 80) is crossed by day ~6–10 depending on pace, so Rookie
    covers the bulk of the month either way.
  - T3 (Champion, 300) is crossed around day 22–23 at the high end
    (~13.3/day), leaving roughly a week as Champion before the monthly
    reset — more generous than the earlier 360 threshold, and reachable
    even at a moderately strong (not just best-case) pace. At the low end
    (~250 total) it's crossed right at the very end of the month, if at
    all — still an aspirational stretch, just a less extreme one.
  - Revisit once there's a few weeks of real data — these are calibrated
    off an estimate, not observed history yet.

### 2. Skill levels (permanent, idle-time driven)

Three skills to start: **Woodcutting, Gardening, Fishing**. User can only set
*which* skill is active — no other input. XP accrues passively based on real
elapsed time since last visit, fueled by an AFK-hour bank.

**AFK bank mechanic:**

- Every +1 to the household's all-time completions total = **+1 hour** of
  banked AFK time for the pet. (Started as a proposed 1 hour, briefly tuned
  down to 30 min when early data looked like 10–12 tasks/day, then reverted
  to 1:1 once it was clear the household is closer to ~10/day — at that
  rate the bank stays meaningfully capped without needing an artificial
  ceiling, since ~10 banked hours/day against 24 real elapsed hours/day
  means the bank drains faster than it fills most days.)
- Derived the exact same way life-stage progress is — a second baseline
  subtracted from the same live total:
  `bankedHours = liveTotal - hoursAlreadyGranted`
- **"Visit" means any page load, not opening the widget.** Since `mascot.js`
  runs on every page the same way `priority-alert.js` does, this grant math
  fires automatically in the background whenever any household page loads
  — Grocery List, Tending Today, anything — regardless of whether the pet
  widget ever gets tapped/expanded. Opening the widget only lets someone
  view progress and change their active skill; it isn't a prerequisite for
  progress happening. This matches genuine idle-game convention (Melvor,
  AFK Arena) — offline gains accrue without needing to open a special
  screen, you just eventually check in on them.
- On each visit: `elapsed = now - lastVisitAt` (using Firestore
  `serverTimestamp()`, never the client's local clock — same reasoning as
  `page-last-updated`, and avoids trusting a visitor's system clock even
  though cheating risk is low with just two users).
  `consumed = min(elapsed, bankedHours)`
  Grant XP for `consumed` hours at the active skill's rate.
  `hoursAlreadyGranted += consumed`
  `lastVisitAt = now`
- **Daily grant cap: 15 AFK hours/day.** This also settles the earlier open
  question of whether the bank needs a separate overall size ceiling — it
  doesn't, since the daily cap already bounds how much can be spent into XP
  in any given day, regardless of how large the underlying derived bank
  gets. Batch-completion days (grocery
  restocking, adding a bunch of fridge items at once) would otherwise hand
  the pet a large, disproportionate chunk of banked time in one sitting.
  True rate-limiting ("no more than 10 tasks in a rolling window") isn't
  possible with the data that exists today — `achievements-state.counts` is
  just a running integer per task type, with no timestamp log of individual
  completions, so there's no way to reconstruct "how many happened in the
  last hour." The cheaper equivalent that reuses the existing
  derive-by-diffing-totals approach (no new event log needed): cap how many
  AFK hours a single day's worth of grants can add, regardless of how many
  completions happened that day.
  - Needs a `dailyGrantedSoFar` counter alongside `hoursAlreadyGranted`,
    keyed to a date string, reset when the date rolls over (same lazy
    rollover pattern used for month/week keys elsewhere on the site).
  - At grant time: `grantable = min(consumed, 15 - dailyGrantedSoFar)`. Only
    `grantable` hours turn into XP. To make "doesn't roll over" actually
    true, `hoursAlreadyGranted` must still advance by the full `consumed`
    amount, not just `grantable` — otherwise the un-granted leftover stays
    sitting in the bank (`liveTotal - hoursAlreadyGranted`) and quietly
    carries into tomorrow, which defeats the point of a daily cap. The
    excess is discarded at the point it's capped, not banked for later.
- **XP curve: RuneScape's formula, flattened, then linearly rescaled so
  level 99 = 1000 AFK hours total.** RS's real curve
  (`XP(level) = floor(1/4 * sum(floor(n + 300 * 2^(n/7))))`) only makes
  sense in a game where XP/hour also climbs as you level up (better gear,
  faster training methods) — RS's actual back-loading is tempered in
  practice by that increasing rate. This system grants a flat rate (one
  AFK hour is always worth the same regardless of level), so the raw curve
  was ported with the growth rate slowed: divisor changed from RS's 7 to
  **10** in the same formula (`2^(n/10)` instead of `2^(n/7)` — i.e. XP
  requirement doubles every 10 levels instead of every 7). Verified the
  unscaled formula reproduces RS's real level-99 total (13,034,431) before
  modification, as a sanity check. Still recognizably the same shape —
  early levels are fast, the tail is the hardest stretch — just without RS's
  most extreme back-loading (where literally half the grind sits in the
  final 7 levels).

  | Level | Cumulative AFK hours |
  |---|---|
  | 10 | ~1.0 hr |
  | 20 | ~3.1 hr |
  | 30 | ~7.4 hr |
  | 40 | ~15.8 hr |
  | 50 | ~32.7 hr |
  | 60 | ~66.3 hr |
  | 70 | ~133.4 hr |
  | 80 | ~267.6 hr (~11.2 days) |
  | 90 | ~535.7 hr (~22.3 days) |
  | 92 | ~615.4 hr (~25.6 days) — the halfway point |
  | 99 | 1000 hr (by design) |

  Real-world time to 99: ~67 days (~2.2 months) per skill at the 15hr/day
  grant cap maxed out every day; more realistically ~100 days (~3.3 months)
  per skill at the household's typical ~10 banked hours/day. Since only one
  skill accrues at a time, maxing all three sequentially would be roughly
  3x that.

## Cosmetic unlocks

Combination of two unlock types, both permanent once earned (skills never
reset, only life stage does):

- **Milestone hats** — unlocked at levels **25, 50, 75, 90, 99**, using a
  base + trim split so tier progress reads as a color change rather than a
  new shape, at 2 distinct hat designs per skill instead of 5:
  - **Standard hat (levels 25/50/75/90):** drawn as 2 aligned layers on the
    same 64×64 canvas — a **base layer** (crown/brim shape) and a **trim
    layer** (just the band/edge accent, transparent elsewhere). The base is
    tinted once with the skill's fixed identity color (e.g. green/brown for
    woodcutting) and stays that color at every tier. The trim is tinted per
    tier using `achievements.js`'s existing `BADGE_PALETTES` prestige cycle
    (gold → crimson → verdant → azure), reusing the same multiply-blend
    tint technique as the body's skin color. Same shape at every tier —
    only the trim color changes.
  - **Bespoke max-skill hat (level 99):** its own unique shape, not a
    recolor of the standard hat, also split into its own base + trim
    layers. Base again takes the skill's identity color; the trim gets a
    dedicated max-tier color plus a shimmer sweep applied only to the trim
    region — reusing the Star Board's existing shimmer effect (a soft
    diagonal highlight clipped to the silhouette).
  - Once unlocked, the user can choose to equip/unequip a hat regardless of
    which skill is currently active — this is the "what has this pet
    accomplished overall" layer, like an RS skill cape.
  - **Naming note:** this per-skill level-99 hat is distinct from the
    all-skills-maxed item below, which stays its own fully bespoke *shape*
    (not a recolor of any skill's hat) but reuses the same base + trim
    construction — kept as **completionist hat** to avoid confusion between
    the two.
- **Active skill item** — a prop/accessory tied to whichever skill is
  currently set as active (e.g. holding an axe while woodcutting, a rod
  while fishing). Swaps automatically with the active skill, not
  user-equipped — this is the "what is this pet doing right now" layer.

Both render on the sprite simultaneously, but the hat and the active-skill
prop sit on **opposite sides of the body's z-order**, not treated as one
group:

- **Hat: behind the body.** Deliberate choice — it means any silhouette
  detail on the body itself (e.g. ears) renders in front of a hat
  automatically, since the body is the topmost layer wherever they overlap
  — no separate ear layer or extra asset needed, it falls out of the
  ordering rather than requiring more art.
- **Active-skill prop: in front of the body.** A held tool sitting behind
  the body would defeat the point of it as a visible "the pet is working"
  indicator — it needs to actually be visible, not mostly hidden behind the
  silhouette. Full stack, back to front: **hat → body → active-skill
  prop.**

### Active-skill prop: working vs. resting states

The active-skill prop (axe/rod/trowel) reacts to whether there's actually
AFK fuel behind the selected skill, using data that already exists — no new
art, no new Firestore fields:

- **Working** (a skill is selected AND `bankedHours > 0`): the prop renders
  with a simple CSS keyframe animation — a swing or bob, distinct from the
  body's idle flicker — signaling the pet is actively earning.
- **Resting** (a skill is selected but the bank is empty): the prop still
  renders, but dims/desaturates and the animation pauses. Doubles as a
  subtle nudge — an idle-looking prop hints the household needs to knock
  out more tasks to keep the pet working, with no UI text needed to say so.
- **Hidden** (added post-launch, alongside wandering below): while a pet is
  actively gliding to a new spot on the ground strip, the prop doesn't
  render at all, regardless of `bankedHours` — a held tool mid-stride
  doesn't make sense, and hiding it outright avoids introducing a fourth
  visual state layered on top of working/resting. Originally this state
  just desaturated the prop the same way resting does, but that read as
  ambiguous with genuine "out of hours" resting, so it was changed to a
  clean hide.

All three states are pure client-side derivation off `activeSkill`, the live
`bankedHours` calculation, and (for the hidden state) the local wandering
motion state — same derive-don't-store approach used throughout this
design.

### Cosmetics are fixed overlays, not per-stage art

Hats and active-skill items are designed as a consistent overlay (badge/prop
rendered alongside the pet) rather than something hand-fit to each individual
life stage's silhouette. This keeps the art count additive instead of
multiplicative — one hat asset works across all 4 life stages, rather than
needing a separate version drawn per stage.

### Art asset count (at current scope)

- 4 life-stage bodies × 2 idle-animation frames each = 8 body frames
  (Fresh, In-Training, Rookie, Champion)
- Standard hat (base + trim layers) × 3 skills = 6 assets
- Bespoke max-skill hat (base + trim layers) × 3 skills = 6 assets
- 1 active-skill item per skill = 3 items
- Completionist hat (base + trim layers, own bespoke shape) = 2 assets

**Total: 25 assets.**

### Completionist hat unlock is derived, not stored

Uses the same base + trim construction as the skill hats — its own bespoke
shape (not built from any single skill's hat). The trim also gets a
shimmer, but a flashier treatment than any single max-skill hat's: rather
than sweeping in one fixed tier color, it cycles continuously through the
Star Board's full `BADGE_PALETTES` rotation (gold → crimson → verdant →
azure → amethyst → obsidian) instead of settling on one. No new asset
needed for this — it's the same trim layer and the same shimmer-sweep
technique already planned, just animated through the full palette instead
of a single color, which fits thematically too: this is the one cosmetic
that represents mastering every skill at once, not just one.

Because skill XP only ever increases (skills never reset, unlike life
stage), unlock status for every cosmetic — including the completionist hat
— doesn't need to be persisted as an earned flag. It's computed live each
render: `allSkillsAtMax = everySkill.level === 99`. Only which hat is
currently *equipped* is stored (an actual user choice); which hats are
*unlocked* is always a fresh check against current levels — same
derive-don't-store approach used for life stage and the AFK bank elsewhere
in this design.

This also resolves what happens if a skill is added later: there's no
explicit "re-lock" step needed, since the completionist hat's unlocked
state was never a stored true/false to begin with. Adding a 4th skill means
the next live check correctly returns false until that skill also hits 99
— no migration or special-cased logic required. (This mirrors how
RuneScape's own completionist-tier capes behave when new skills/content
raise the bar — a recognizable mechanic from the genre this is borrowing
from, not an invented penalty. Worth a UI note explaining *why* it
re-locked, so it reads as "the game added content" rather than a bug.)

## Two pets — one per household member

Since this is a two-person household, the widget shows two pets side by side,
one per user (keyed off the same email→label mapping `auth.js` already
defines for each household member).

- **Life stage is shared** — both pets show the identical stage, since it's
  derived from the one household-wide monthly baseline. No per-user split
  needed here.
- **Skills are independent per pet** — each user sets their own active
  skill, and each pet levels up on its own XP track with its own equipped
  hat.
- **Both pets draw AFK hours from the same source total, independently.**
  Because the bank is *derived* (`liveTotal - hoursAlreadyGranted`) rather
  than a resource that gets spent down and subtracted from a shared pot,
  each pet can keep its own `hoursAlreadyGranted` / `lastVisitAt` /
  `dailyGrantedSoFar` and independently derive its own bank off the same
  shared completions total — like two meters reading the same water main,
  not two people splitting one bucket. There's no need to attribute
  individual task completions to whoever actually did them (the existing
  `recordAchievement(key, delta)` doesn't track who triggered it, and
  doesn't need to change). Net effect: total combined pet output roughly
  doubles versus a single-pet system, since both pets independently earn
  from the same household activity — a deliberate tradeoff, not an
  oversight.

## Data model (all in a new `household/mascot-state` doc)

```
{
  monthKey: '2026-07',
  baselineTotal: 48213,        // life-stage baseline, shared by both pets

  pets: {
    userA: {
      hoursAlreadyGranted: 512,
      dailyGrantKey: '2026-07-13',
      dailyGrantedSoFar: 6,      // out of the 15/day cap
      lastVisitAt: <serverTimestamp>,

      activeSkill: 'woodcutting',
      skillXP: {
        woodcutting: 12345,
        gardening: 0,
        fishing: 6200
      },
      equippedHat: 'woodcutting-25'  // or null
    },
    userB: {
      hoursAlreadyGranted: 340,
      dailyGrantKey: '2026-07-13',
      dailyGrantedSoFar: 15,     // capped out for today
      lastVisitAt: <serverTimestamp>,

      activeSkill: 'fishing',
      skillXP: {
        woodcutting: 0,
        gardening: 890,
        fishing: 22110
      },
      equippedHat: null
    }
  }
}
```

Kept as its own document rather than folded into `achievements-state`, since
it's a distinct concern (derived/cosmetic state vs. the permanent completion
ledger) and avoids adding write contention to a document every other page
already transacts against constantly.

## Expanded widget UI (skill selection / progress)

Progressive disclosure, three levels, all within the persistent widget —
no dedicated page needed for this either.

- **Level 0 — collapsed (default):** both pets shown small, side by side,
  each with current life-stage body + equipped hat + active-skill prop,
  idling.
- **Level 1 — tap/touch a pet:** expands to show 3 pills, one per skill.
  Each pill contains a small art icon representing that skill and the
  pet's current level in it, as a number, to the right of the icon. The
  icon reuses the already-planned active-skill prop art (axe/rod/trowel) —
  no new icon assets needed, same image just doubling as both "what the pet
  is holding while working" and "the UI symbol for that skill." This level
  also shows the pet's currently banked AFK hours, once, above/alongside
  the pill row — it's a pet-level resource (fuels whichever skill is
  active, not owned by any one skill), so it doesn't belong nested inside
  a specific skill's detail view. No new data needed, just surfacing the
  same derived `bankedHours` value already computed for the grant math.
  This is a more precise companion to the working/resting prop cue already
  planned — that one's an ambient hint with no numbers, this gives the
  actual figure for anyone who wants it.
- **Level 2 — tap a pill:** expands further to show that skill's full name
  and current total XP (i.e. AFK hours banked into it so far, out of the
  1000-hour curve to level 99). If this is the viewer's own pet, this is
  also where they set that skill as active — a "train this skill" control.
  If it's the other household member's pet, this level is view-only (name
  + XP visible, no training control) — personal choices like active skill,
  equipped hat, and skin color are things you'd set for your own pet, not
  someone else's, even though nothing in the site's existing Firestore
  rules technically prevents it.

Setting a skill active is the one genuine user-initiated write in this
whole system beyond cosmetic preferences (equipped hat, skin color) —
everything else (life stage, AFK bank, XP, unlock status) is derived, not
chosen. Should update only the `activeSkill` field on that user's pet, not
the whole `pets` map, to avoid clobbering the other person's pet state on
write.

## Art spec

Low-res pixel art, in the spirit of the original Digimon virtual pet, sized
to stay readable once hats/props are layered in rather than going full
LCD-toy-crude.

- **Canvas: 64×64px per asset, exported as PNG.** 32×32 (closer to the
  original Digivice's dot-matrix look) reads as too abstract once hats and
  held props need to be distinguishable from the body. 64×64 is the
  "readable pixel art" sweet spot — small and unmistakably retro, but large
  enough that a hat silhouette or a held axe/rod/trowel is actually legible.
- **Every layer shares the same 64×64 canvas and anchor point** — the 4
  life-stage bodies, all 14 hat layers (3 standard base + 3 standard trim +
  3 max-skill base + 3 max-skill trim + 1 completionist base + 1
  completionist trim), and all 3 active-skill props are all drawn on
  identically-sized transparent canvases with the same origin. This is what makes the "fixed overlay, not baked into the
  body" decision work in practice: a hat just gets absolutely-positioned
  behind the body with zero per-stage offset math, since nothing shifts
  between assets.
- **PNG-8, indexed/limited palette** — roughly 16–32 colors total across
  the whole mascot, not full 24-bit color. A genuinely constrained palette
  is what makes pixel art read as art rather than a small blurry image, and
  keeps file sizes tiny (loads on every page).
- **Transparent background on every asset**, always — these composite over
  whatever accent color each page uses.
- **Export at native 64×64 only; scale up via CSS `image-rendering:
  pixelated`** rather than pre-exporting multiple sizes. Keeps crisp pixel
  edges at whatever display size the widget ends up using, and avoids
  needing to re-export art if the widget's size changes later.
- **2-frame idle animation, body only — overlays stay static.** In the
  spirit of the original Digivice toy, which just alternated between two
  near-identical poses in place (no real displacement, more like a blink
  or a subtle shift), each of the 4 life-stage bodies gets a second idle
  frame — 4 becomes 8 body frames, not all 25 assets doubling. Hats and
  the active-skill props stay single static overlays, since the animation
  has no meaningful silhouette displacement, so a hat sitting behind the
  body never looks detached across the swap. If the animation ever grew into real
  bounce/displacement instead of a subtle idle flicker, overlays would need
  matching second frames to stay visually attached — worth avoiding, both
  for cost and to keep it authentic to the toy's crude style.
  Implementation is a simple `setInterval` or CSS `steps(2)` keyframe
  toggling between the two body frames — no new data model or architecture,
  same order of complexity as the Star Board's existing shimmer animation.
- **Confirmed: heads move vertically a couple pixels, distance varies per
  stage.** This is the cheap case — a rigid shift, not a reshape. Each
  stage gets one more small number alongside its head anchor coordinate:
  how far the head moves between frame 1 and frame 2 (varies per stage,
  which costs nothing extra since it's just one more value bundled with
  data each stage already needs). That offset gets applied as a CSS
  transform to the **hat** overlay only, synced to whichever body frame is
  showing, so the hat rides along with the head as a rigid unit without
  needing a second hat image. Since only the head moves — not the whole
  body — the **hand** anchor and the active-skill prop are untouched by
  this and need no synced transform at all.

### Tintable body (user-selectable skin color)

Body art (the 4 life-stage sprites, 8 frames with idle animation) is drawn
in **grayscale**, not flat color, so users can pick their own skin color per
pet. Hats and active-skill props stay fixed-palette — they represent an
earned skill achievement and should look consistent regardless of which
color the underlying pet is, the same way equipped gear in most games keeps
its own colors even on a customizable character.

- **Technique: color-multiply, not hue-shifting.** CSS `hue-rotate()`
  doesn't work on grayscale art (no hue to rotate). Instead: a solid
  rectangle in the user's chosen color sits underneath the grayscale sprite,
  which renders on top with `mix-blend-mode: multiply`. Because the art has
  real midtone shading (not flat black/white), this produces proportional
  darkening across the whole gradient — white areas take the tint at full
  strength, black outlines/shadows stay black, and every gray value between
  produces a naturally shaded version of that color. Real highlights and
  shadows come through in whatever color gets picked, not just a flat fill.
- **Clipping wrinkle:** multiply blend doesn't respect transparency by
  default — the color rectangle would render as an opaque block outside the
  body's silhouette unless clipped first. Solved with `mask-image` using the
  sprite's own alpha channel as the mask (needs the `-webkit-mask-image`
  prefix for Safari).
- **Fallback if CSS blend-mode quirks become annoying:** do the recolor in
  a small offscreen `<canvas>` with plain JS instead — draw the sprite,
  remap grayscale values to the chosen tint directly. More code, but fully
  consistent across browsers.
  **Update: this is what actually shipped.** The CSS `mix-blend-mode` +
  `mask-image` route worked in Chromium but stayed silently broken in
  Firefox (its default `mask-image` masking mode wasn't the culprit it
  first appeared to be — the real fix was abandoning the CSS approach
  entirely). `getTintedImage()` now does the canvas recolor for both the
  body and hat trims, with every plausible (image, color) combination
  precomputed up front so there's no async decode stall the first time a
  given combo is actually needed mid-render.
- **Storage:** one more small per-account field, `pets.<user>.skinColor` —
  same pattern as the existing `theme-preferences` doc (a stored per-account
  preference, read once and subscribed live).

### Asset file naming

Kebab-case, lowercase, matching the site's existing HTML page naming style
(`grocery-list.html`, `house-projects.html`). Category prefix first (`body-`,
`hat-`, `prop-`) so files group and sort together in a folder. Recommend a
dedicated `pet-assets/` folder rather than adding 25 files to the repo root,
which is otherwise flat per `notes.md`'s file structure table.

**Body (8) — `pet-body-{stage}-{frame}.png`:**
`pet-body-fresh-1.png`, `pet-body-fresh-2.png`,
`pet-body-in-training-1.png`, `pet-body-in-training-2.png`,
`pet-body-rookie-1.png`, `pet-body-rookie-2.png`,
`pet-body-champion-1.png`, `pet-body-champion-2.png`

**Standard skill hats (6) — `hat-{skill}-{layer}.png`:**
`hat-woodcutting-base.png`, `hat-woodcutting-trim.png`,
`hat-gardening-base.png`, `hat-gardening-trim.png`,
`hat-fishing-base.png`, `hat-fishing-trim.png`

**Max-skill hats (6) — `hat-{skill}-max-{layer}.png`:**
`hat-woodcutting-max-base.png`, `hat-woodcutting-max-trim.png`,
`hat-gardening-max-base.png`, `hat-gardening-max-trim.png`,
`hat-fishing-max-base.png`, `hat-fishing-max-trim.png`

**Completionist hat (2) — `hat-completionist-{layer}.png`:**
`hat-completionist-base.png`, `hat-completionist-trim.png`

**Active-skill props (3) — `prop-{skill}.png`:**
`prop-woodcutting.png`, `prop-gardening.png`, `prop-fishing.png`
(also doubles as the Level 1 pill icon — no separate icon files needed.)

**Extends cleanly for a future skill** (e.g. mining): just 5 more files
following the same pattern — `prop-mining.png`, `hat-mining-base.png`,
`hat-mining-trim.png`, `hat-mining-max-base.png`, `hat-mining-max-trim.png`
— no changes to the naming scheme itself.

**Ground strip (2, added post-launch with the wandering feature) —
`ground-tile-{theme}-mode.png`:** `ground-tile-light-mode.png`,
`ground-tile-dark-mode.png` — outside the original 25-asset count above,
since wandering wasn't part of the initial scope.

**If tier recolors get pre-baked instead of tinted live** (optional,
per the Art Spec's "either way" note): `hat-{skill}-tier-{level}.png`, e.g.
`hat-woodcutting-tier-25.png` — 4 extra files per skill, only needed if the
live CSS/canvas tint route ends up not being used.

### Attachment points (hats/props across differently-sized life stages)

Life stages likely differ in height/proportions (Fresh a squat blob, Champion
taller), so a single global fixed offset for hats/props would misalign once
the body changes shape. Fixed with per-stage anchor points instead of
per-stage art:

- Each of the 4 life-stage bodies gets its own small anchor coordinates — a
  **head point** (where hats sit) and a **hand point** (where the
  active-skill prop sits) — noted once when that stage's art is drawn.
  8 coordinate pairs total (4 stages × 2 points), not new art, not a
  multiplier on the 25-asset count.
- Every hat/prop is drawn with its own attachment pixel at a consistent
  relative position within its 64×64 canvas (e.g. a hat's brim bottom-center
  always lands at the same spot regardless of design). This applies equally
  to the 3 active-skill props — the axe, rod, and trowel should each have
  their grab point at the same relative pixel within their own canvas,
  regardless of how different the tool shapes look, for the same reason:
  positioning becomes pure translation math at render time rather than
  needing per-tool offset tuning. Align the fixed attachment point to
  whichever stage's head/hand point is currently active.
- Net effect: the same hat file renders correctly on a squat Fresh-stage
  body and a tall Champion body, no per-stage hat variants needed. Only
  extra requirement is noting head/hand points while drawing the 4 bodies —
  not a separate task, just something to track during that pass.

## Open questions / not yet decided

None currently — every major system (life stage, skills/AFK bank, cosmetics,
two-pet split) has a resolved shape. Remaining work is execution-level:
picking exact hour-rate for the active-skill XP grant math, finalizing art
direction/style for the 25 assets, and building the widget itself.

## Resolved (kept for history, not re-litigated)

- Bank overall size ceiling → not needed; the 15hr/day grant cap already
  bounds it.
- One pet vs. two → two, one per household member, shared life stage,
  independent per-user skill/AFK/hat state.
- Life stage count → 4 (Fresh, In-Training, Rookie, Champion).
- Cosmetic art strategy → fixed overlays (rendered behind the body, not on
  top — resolves ears-in-front-of-hat with zero new assets), not
  per-life-stage art. Hats also consolidated: 1 base design recolored
  across levels 25/50/75/90 (reusing the Star Board's existing prestige
  palette), plus a bespoke max-skill hat at 99 and a bespoke completionist
  hat — every hat (standard, max-skill, completionist) built as a base +
  trim layer pair, so tier/color changes never require redrawing the whole
  shape. Asset count now 25 total (down from an original 38).
- Completionist hat re-lock on new skill → not a stored flag; always
  derived live from current skill levels, so it self-corrects
  automatically.
- Life-stage thresholds → Fresh 0–9 / In-Training 10–79 / Rookie 80–299 /
  Champion 300+ (calibrated off an estimated 250–400 tasks/month; revisit
  with real data).
- Skill XP curve → RuneScape's formula, flattened (divisor 7→10, i.e.
  doubling every 10 levels instead of 7) to suit a flat-rate AFK system
  with no faster-training-method unlocks, then rescaled to 1000 AFK hours
  at level 99 (~67 days fastest-possible per skill, ~100 days at typical
  pace).
- Milestone hat count/levels → 5 unlock levels per skill (25, 50, 75, 90,
  99). Standard hats use a base + trim split (1 shape, trim recolored
  across the first 4 tiers); the max-skill (99) hat and the completionist
  hat are their own bespoke shapes, each also built as base + trim so their
  tier color/shimmer treatment doesn't require redrawing the shape. Asset
  count now 25 total (down from an original 38), including 2
  idle-animation frames per life-stage body.

## Post-launch additions (not in the original scope above)

Two systems were added after the initial build, driven by direct feedback
rather than pre-planned in this doc. Recorded here for history same as
everything else.

- **Displayed XP + popups.** The design above only ever measured skill
  progress in raw AFK hours. A separate, purely cosmetic ×1000 scaling
  (`xpForHours(hours) = hours * 1000`) was added so on-screen numbers read
  like a game currency (level 99 = 1,000,000 XP) without touching the
  underlying hour-based level curve, grant math, or daily cap at all. Two
  floating-text popups ride on top of this: a per-pet "+&lt;skill
  emoji&gt;N" popup whenever that pet's displayed XP increases by at least
  1 (detected by diffing consecutive `mascot-state` Firestore snapshots —
  same technique as the Star Board's milestone banner), and a separate,
  single "+N hr" popup over the whole widget whenever the shared household
  completion total itself increases (since that one total feeds both
  pets' banked hours identically, showing it per-pet would be redundant).
  Both are pure local rendering — nothing new stored.
- **Wandering.** The widget moved from a small bottom-right corner cluster
  to a full-width, short ground strip so both pets can slide around a
  tiled ground texture instead of sitting in fixed slots. Each pet picks a
  random spot, glides there at a **constant speed** (distance ÷ a fixed
  px/sec — no easing, so short and long moves feel identically brisk, not
  proportionally slower/faster), then sits still for a random 8–15s
  (enough time to actually notice the tool-working animation) before
  repeating. The glide is driven by a genuine CSS `transition` on `left` —
  earlier JS-interpolated attempts stuttered, since the sprite's markup
  gets rebuilt on every idle-frame tick far more often than a multi-second
  glide's own duration, resetting any JS-driven animation partway through.
  The sprite mirrors horizontally based on travel direction (flipping the
  whole hat+body+prop stack together, not just the body, so attachment
  points stay correctly aligned). The ground art itself is theme-aware
  (separate light/dark tile PNGs, both mounted and pre-painted from the
  start via `opacity`, not `display:none`, so a theme switch is an instant
  visibility toggle rather than waiting on a fresh image decode) and reacts
  to the real theme-change event rather than the widget's own next
  incidental re-render. None of this wandering state is persisted or
  synced — it's a local-only flourish that resets on every page load. The
  expanded panel stayed a separately fixed-position element (not tied to
  wherever a pet currently is), so it never has to chase a moving sprite.
  Two ground-strip bugs surfaced post-launch and were fixed in place rather
  than redesigned: (1) the strip's `overflow: hidden` was clipping the
  champion life stage's hat, since that stage's head anchor sits high
  enough on the sprite to render above the strip's own box — changed to
  `overflow: visible` (harmless for the ground texture layers, since
  background-image painting is already confined to an element's box
  regardless of `overflow`); (2) each pet's random target picked
  independently of the other could land the two pets on top of each other,
  and there was no listener for viewport-width changes, so a pet parked
  near the old edge before a mobile orientation change or address-bar
  collapse/expand could render off-screen until its next move happened to
  start. Target-picking now rejects spots too close to the other pet
  (falling back to the largest free gap if none qualify), and a debounced
  `resize` listener snaps any out-of-bounds pet back inside immediately,
  bypassing the transition so it doesn't visibly glide in from off-screen.
