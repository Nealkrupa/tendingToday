# Household Mascot — Design Notes (shipped)

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

> **Superseded.** Everything below in this subsection (the AFK-hour bank,
> `hoursAlreadyGranted`, the 15hr/day cap, the ×1000 displayed-XP scaling)
> describes the *original* design and no longer matches what's live — kept
> here only for historical rationale (the XP curve math it derives is still
> accurate). See "Progression system redesign (shipped)" further down for
> the tiered-XP + token system that actually shipped and replaced this.

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

**[Superseded by the redesign — the "resting" state described below is
being retired. See "Prop (tool) visual state simplifies to two states, not
three" in "Progression system redesign" near the end of this doc.]**

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

**[Superseded by the redesign for the `pets.<user>` fields specifically —
`monthKey`/`baselineTotal` below are still current. See "New data model &
grant mechanism" in "Progression system redesign" near the end of this doc
for the shape actually being built now.]**

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
  Each pill contains a small icon representing that skill and the pet's
  current level in it, as a number, to the right of the icon. Originally
  planned to reuse the active-skill prop art (axe/rod/trowel) as this
  icon, so no new icon assets would be needed — **superseded: shipped
  with a plain emoji per skill instead** (`SKILL_EMOJI`,
  [mascot.js:46](../mascot.js), 🪓/🪴/🐟), also reused for the XP popup
  and the skill-detail panel header. Prop PNGs render only as the
  in-sprite held-tool overlay now, never at icon size — see
  [petCosmetics_notes.md](petCosmetics_notes.md)'s "Icon use for art
  assets that double as icons" for the current icon approach. This level
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
(originally planned to also double as the Level 1 pill icon — **superseded,
see the note in "Expanded widget UI" above:** pill/popup/panel icons
shipped as plain emoji instead, so these render only as the in-sprite
held-tool overlay.)

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

**This applied to the original build only.** Real usage after launch found
real bugs in the skills/AFK-bank system described here — see "Progression
system redesign" near the end of this doc, which has its own current "Still
open" list. Life stage, cosmetics, and the two-pet split are unaffected and
still accurately described by everything above.

## Resolved (kept for history, not re-litigated)

- Bank overall size ceiling → not needed; the 15hr/day grant cap already
  bounds it. **[Superseded — this reasoning was wrong; see "Progression
  system redesign" below.]**
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
  pace). **[Superseded — same curve shape kept, but retargeted to XP
  directly instead of hours, and the pace target deliberately slowed to
  ~200 days; see "Progression system redesign" below.]**
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

## Progression system redesign (shipped)

Real usage surfaced a problem with the AFK-bank/skill-XP half of the
progression system (see "Two independent progression axes" above — that
section now describes the *original* system this one replaced). Everything
below is implemented in `mascot.js` as of this writing: `UNIVERSAL_AFK_XP_PER_HOUR
= 1000`, the XP tiers/token-block prices/premium-swatch prices match the
tables below exactly, and the migration reset (full reset, not a
conversion — see below) runs automatically the first time an old-shape pet
is touched. Verified end-to-end in a local mock harness (tiered grants,
token math, AFK-block purchase + time-based grant + auto-clear, skin-color
purchase, and the legacy-pet reset) before shipping — see this doc's own
numbers below for what's still a placeholder pending real usage data
(mainly the XP-tier values and the token base rate) versus what's a
confirmed, locked-in constant now that it's live.

**Life stage: no changes proposed.** Fresh → In-Training → Rookie →
Champion is working as intended so far. The thresholds (0/10/80/300, see
"Resolved" above) were calibrated off an *estimated* 250–400 tasks/month
with an explicit "revisit with real data" caveat — we don't have a full
month of real data yet, so it's too early to tell whether Champion gets hit
too early/late in a typical month. Revisit this specific axis once there's
at least one full month to look back on; don't touch it preemptively.

**The AFK bank/skill-XP axis has an actual bug, not just a tuning
question.** `bankedHours = liveTotal - hoursAlreadyGranted` treats *every*
tracked action anywhere on the site (checking a daily task, checking a
grocery item, adding a recipe, resolving a note, adding a bill...) as
literally "1 hour" of pet fuel, 1:1, uncapped on the production side. The
only cap in the whole system is on the *drain*: `DAILY_CAP_HOURS = 15`,
how much banked time can convert into XP per pet per day. A moderately
active household clears 15+ tracked actions on an ordinary day (the 7 daily
foundations alone get most of the way there), so the bank's production
rate structurally exceeds its drain rate and the backlog only ever grows —
it doesn't oscillate around some steady state, it's a one-way ratchet. This
directly contradicts the "Resolved" note above claiming "the 15hr/day grant
cap already bounds \[the bank\]" — it bounds the *grant*, not the *bank
size*, which is the actual bug: that resolved note's reasoning was wrong.

**A second, worse bug was found by reading the real production data
directly** (via the live `household/mascot-state` and `household/
achievements-state` docs, ~5 days after launch): `hoursAlreadyGranted`
(75.24 for one pet, 79.20 for the other) is far larger than that same pet's
total `skillXP` across all three skills (22.24 and 24.74 respectively) — only
about 30% of "granted" hours actually became XP. The cause was in the old
`runVisitGrant` (this exact code no longer exists in `mascot.js` — it was
deleted as part of this redesign, quoted here for the historical record):

```js
const consumed = Math.min(elapsedHours, bankedHours);
const grantable = Math.max(0, Math.min(consumed, DAILY_CAP_HOURS - dailyGrantedSoFar));
...
// hoursAlreadyGranted advances by the FULL consumed amount (not just
// grantable) so the capped excess is discarded, not banked forward.
const newHoursAlreadyGranted = hoursAlreadyGranted + consumed;
```

`elapsedHours` is real, uncapped wall-clock time since the pet's last visit.
Stay away from any page for a couple of days and `elapsedHours` can easily
exceed the whole day's 15-hour cap in one shot — `consumed` absorbs all of
it (removing it from the bank), but `grantable` (what actually becomes XP)
stays capped at 15. The difference is gone forever, silently, the instant
the page reloads — not backlogged, not visible anywhere, just deleted. This
is worse than the production/drain imbalance above because the bank's own
displayed size (`liveTotal - hoursAlreadyGranted`) already absorbs the loss
before a person ever sees it, so there's no visible symptom pointing at it —
it can only be found by comparing `hoursAlreadyGranted` against actual
`skillXP` directly, which is how this was caught. This is an additional,
independent confirmation that decoupling skill XP from the hours/bank
mechanism entirely (below) is the right call, not just a tuning fix — the
leak can't exist in a system where nothing is "granted" from a bank in the
first place.

**Direction: keep the bank, but stop treating it as the only thing that
produces skill XP.** Full removal (pure per-action RS-style XP, no bank at
all) was considered and rejected — the bank is worth keeping, just not as
the sole XP pipeline. New shape:

- **Skill XP decouples from the bank entirely.** Specific real actions grant
  small, fixed XP amounts directly to a specific skill the moment they
  happen — closer to actual RuneScape (chop a log, get Woodcutting XP on
  the spot) than the current "hours slowly drip out of a bank" model. No
  daily cap needed here since there's no bank to overflow; each action's
  XP is granted and done. **Amounts vary by page/action type** — a daily
  foundation checkbox, a grocery item, a house-project task, etc. each get
  their own XP value rather than one flat number, so meaningfully bigger
  actions can be worth proportionally more. See the recommended tier
  values below, grounded in real completion-rate data. **Decided: skills
  stay generic for now** — any tracked action still feeds whichever skill
  is currently active (Woodcutting/Gardening/Fishing, unchanged roster),
  same as today. Mapping skills onto specific real pages (e.g. a Cooking
  skill trained only by Meal Planning) was considered and explicitly
  deferred — a separate future idea, not part of this redesign's scope, so
  it doesn't block implementation here.

  **Real completion-rate data** (pulled directly from the live
  `household/achievements-state` doc, 5.02 days after launch — `createTime
  2026-07-10T12:22` to `updateTime 2026-07-15T12:54`): 93 total tracked
  actions across both people, but 23 of those are one-time
  `subscription/bill/amazon/chewy:added` entries from setting up the new
  Subs & Bills page that same day, not steady-state behavior. Excluding that
  setup burst: **70 actions / 5.02 days ≈ 14/day combined**, broken down —

  | Category | Actions (5 days) | ≈/day |
  |---|---|---|
  | Daily foundations (`daily:*`) | 33 | 6.6 |
  | `note:resolved` | 13 | 2.6 |
  | `grocery:item` | 9 | 1.8 |
  | `zone:*` | 4 | 0.8 |
  | `meal:recipe` | 4 | 0.8 |
  | `pet:brush` | 2 | 0.4 |
  | `deep:*` | 1 | 0.2 |
  | `day:perfect` | 5 | ~1.0 (hit nearly every day so far) |
  | `wishlist:item` | −1 | — (stray decrement predating this key's tracking, not real activity) |

  Rows sum to 70, matching the "70 actions" figure above — the table
  wouldn't balance without that last row, since a couple of near-zero keys
  (`project:task`, `project:finished`, `contact:added`, all 0 this period)
  are omitted entirely rather than listed at 0.

  This is a thin, early sample — 5 days, includes an atypical one-time setup
  burst, and a 5-for-5 perfect-day streak that may not hold over a full
  month — so treat the ratios above as a rough seed, not ground truth.
  Revisit once there's a full month to look back on, same posture as the
  life-stage thresholds and the token base rate.

  **Target pace: ~200 days to level 99, deliberately slower than the old
  system's ~100-day typical pace** — a conscious choice for a slower grind,
  not derived from the data above. 1,000,000 XP over 200 days ≈ 5,000
  XP/day needed toward whichever skill is active. Grouping the real actions
  above into three tiers and solving for ~5,000 XP/day:

  | Tier | Actions/day | XP each | ≈XP/day |
  |---|---|---|---|
  | Quick (`daily:*`, `grocery:item`, `zone:*`) | 9.2 | 125 | 1,150 |
  | Standard (`note:resolved`, `meal:recipe`, `pet:brush`, `deep:*`) | 4.0 | 300 | 1,200 |
  | Perfect-day bonus (`day:perfect`) | ~1.0 | 2,500 | 2,500 |
  | **Total** | | | **≈4,850/day → ~206 days to 99** |

  Recommendation, not yet finalized — the perfect-day bonus alone is over
  half the daily total, which only looks reasonable because this household
  has hit it every day so far; if that streak doesn't hold over a full
  month, real daily pace will be slower than 206 days and these numbers
  should get revisited then.
- **Displayed purely as XP, not hours.** Since skill progress no longer
  comes from continuous banked hours, there's no reason to keep rescaling
  the level curve to "1000 hours at level 99" — the curve now just targets
  a level-99 XP total directly, same RuneScape-flattened shape as today,
  just measured in XP from the start instead of hours-then-×1000-for-display.
  AFK-block purchases (below) grant XP at their own flat, universal XP/hr
  rate (same rate regardless of which skill is active), separate from the
  per-action values above.
- **The bank becomes a separate, uncapped currency: 1 tracked action = 1
  token.** Same production source as today (every `recordAchievement` call
  sitewide), but tokens no longer produce XP directly — they're pure
  currency now. No daily cap on token *earning* — that's intentional, not
  the bug being fixed, since the actual problem was an uncapped source
  feeding an under-capped sink. Once tokens have real spending options
  (below), unlimited production is fine because there's finally something
  for it to drain into. Display name settled as simply "tokens" (🪙 in the
  UI) rather than inventing a fancier name. Spendable on:
  - **Cosmetics — v1 scope is skin colors only.** Tool skins and hat
    variants are explicitly out of scope for this redesign, revisited
    later once the token-purchase pattern is proven with something small.
    Shipped as `PREMIUM_SWATCHES` ([mascot.js:65](../mascot.js)), later
    reworked into a full color-tier system — see "Skin color tiers &
    smooth color-cycling" below for the current shape.
  - **Purchasable AFK-time blocks, on a discount curve.** Four fixed block
    sizes — 1hr / 2hr / 5hr / 10hr — priced off a 5-tokens-per-hour base
    rate, with the discount growing from 0% at the 1hr block up to 30% at
    the 10hr block. Confirmed price table (all whole-number token costs,
    no rounding needed):

    | Block | Base cost (5/hr) | Discount | Price (tokens) | Effective tokens/hr |
    |---|---|---|---|---|
    | 1 hr  | 5  | 0%  | 5  | 5.0 |
    | 2 hr  | 10 | 10% | 9  | 4.5 |
    | 5 hr  | 25 | 20% | 20 | 4.0 |
    | 10 hr | 50 | 30% | 35 | 3.5 |

    **The block itself is the only limiter — no separate daily-cap concept
    for purchases.** Buying a block starts it running immediately; no new
    block (of any size) can be bought again until the active one's own
    remaining duration reaches zero. This replaces the old always-on
    "banked hours drip into XP whenever you have any" behavior with an
    intentional, opt-in purchase — you decide when to spend tokens on a
    block, rather than it happening automatically and unboundedly in the
    background.
- **Prop (tool) visual state simplifies to two states, not three.** The
  current working / resting (desaturated, paused) / hidden-while-walking
  three-state model retires the "resting" state entirely. New behavior:
  **working** (animated) while a purchased AFK block is currently active,
  *and* briefly (2–3 seconds) right after any direct action grants XP —
  a lightweight "you just earned XP in this skill" flourish distinct from
  the existing floating "+N XP" popup. **Hidden** at every other time (no
  block active and no just-happened grant).
  Walking interacts with the two working reasons differently, not
  uniformly: an AFK block is a sustained, ambient state, so it still hides
  during a walk (a held tool doesn't make sense mid-stride) — but the
  post-action flourish is a brief, time-critical cue tied to a specific
  moment, same as the floating "+XP" popup (which was never gated on
  walking at all). Hiding the flourish during a walk the same way the
  block does meant it could get lost entirely: the flourish's own window
  is fixed relative to the grant moment, not to when the pet next stops
  walking, so a walk that outlasts the window (easy — walks can run
  several seconds) left nothing to show once the pet finally stopped. So
  the flourish always shows regardless of walking, only the ambient
  AFK-block state still respects the walking-hide rule.
  **Follow-up: a grant mid-glide now stops the glide, rather than letting
  the flourish just ride along on top of an already-moving pet.**
  `interruptGlideForFlourish()` reuses the exact freeze-in-place technique
  `addResizeClampListener` already established: read the CSS transition's
  live interpolated position via `getComputedStyle`, cancel the transition,
  pin `left` to that exact point (so nothing visibly jumps), then mark the
  pet stationary for a normal randomized 8–15s wait — the same wait a glide
  ending naturally already uses, so the interruption doesn't read as a
  different kind of stop. Guarded by a per-pet `lastFlourishInterruptAt`
  (keyed on the grant's own timestamp) so repeated re-renders during the
  still-open flourish window don't re-snap the pet or fight a legitimate
  next glide. The "flourish always shows regardless of walking" rule above
  is kept as a defensive fallback (in case the interrupt doesn't fire on
  some particular render — e.g. very first tick after a grant arrives on a
  device that wasn't the one which triggered it), not because it's still
  the primary mechanism.

### New data model & grant mechanism

The original "Data model" section above (`hoursAlreadyGranted`,
`dailyGrantKey`, `dailyGrantedSoFar`, `lastVisitAt`, `skillXP` in raw hours)
describes the *old* system being replaced. New per-pet shape:

```js
pets: {
  userA: {
    tokensBaseline: 93,        // liveTotal at last reset (pet creation, or this migration)
    tokensSpent: 120,          // tokens = max(0, liveTotal - tokensBaseline - tokensSpent), never stored

    lastGrantedCounts: {       // per-key cursor, see "Grant mechanism" below
      'daily:bed': 4, 'grocery:item': 9, /* ...one entry per achievements-state key... */
    },

    activeSkill: 'woodcutting',
    skillXP: { woodcutting: 12345000, gardening: 0, fishing: 6200000 },  // raw XP, not hours
    equippedHat: 'woodcutting-25',
    purchasedSkinColors: [],   // hex codes (or 'rainbow') owned beyond the free 4 SWATCH_COLORS

    activeAfkBlock: null,      // or { hours: 10, startedAt: <ts>, xpGrantedSoFar: 0 }
    lastBlockGrantAt: null,

    lastActionGrantAt: <serverTimestamp>  // drives the 2–3s post-action prop flourish
  }
}
```

`hoursAlreadyGranted` / `dailyGrantKey` / `dailyGrantedSoFar` / `lastVisitAt`
are gone entirely — nothing left needs elapsed-real-time bookkeeping except
the AFK block itself (below).

**Grant mechanism: diff `achievements-state.counts` per-key, not a new
write hook per page.** mascot.js already holds a live `onSnapshot` on that
doc (see the earlier fix in "Post-launch additions" below — before that fix
this diffing wouldn't have been reliable on every page anyway). On each
incoming snapshot, compare against `lastGrantedCounts`: for every key whose
count went up, look up that key's tier (Quick/Standard/Perfect-day, see
table above), multiply by the delta, credit the total to `activeSkill`,
then advance `lastGrantedCounts`. Two things fall out of this for free,
which is why it beats adding a write hook to every page's own click
handler:
- **No new write hooks anywhere else on the site** — same rule this whole
  design has followed throughout. Every other page keeps calling
  `recordAchievement()` exactly as it does today; mascot.js is the only
  thing that needs to change.
- **The post-action prop flourish falls out of the same diff** — any
  positive delta also sets `lastActionGrantAt = now`, which is exactly the
  "just earned XP" trigger the prop's working state needs. A write-hook
  approach would need a second, separate signal just for this.

**`lastGrantedCounts` is a per-key high-water mark, not just "the last
value seen" — this closes a real farming exploit, not a hypothetical one.**
A plain last-seen cursor is spammable: check a task (count 0→1, grants
125 XP), uncheck it (count 1→0 — `recordAchievement`'s own -1 delta is
normal, expected behavior everywhere else on the site, "mis-clicks
self-correct" — but naively advancing the cursor to match would drop it
back to 0), check it again (count 0→1 now reads as a *fresh* positive
delta from the lowered cursor, grants another 125 for the same click).
Repeat indefinitely for unlimited XP. The fix: `lastGrantedCounts[key]`
only ever moves up (`Math.max(before, after)` on every write, never a bare
overwrite), so re-checking back up to a value already reached and paid out
for isn't a delta above the high-water mark and grants nothing — while a
genuine new completion (the underlying lifetime count climbing past its
own all-time peak, e.g. tomorrow's instance of the same daily task, which
increments the same counter further since it never resets) still grants
normally, since that's a real excursion past the mark. This is the same
"skills never reset, only go up" philosophy the rest of this design already
follows, just applied to the grant mechanism itself and not only the
stored total. Verified directly: a check→uncheck→check→uncheck→check
sequence against an established pet granted exactly once (125 XP), and a
subsequent genuine new peak (count reaching a value never seen before)
still granted normally on top of that.

Tokens don't need the per-key diffing above — they're not tiered, every
action is worth the same 1 token — but they do still need a baseline, same
reasoning as `hoursAlreadyGranted` in the old system and `baselineTotal`
for life stage: without one, a freshly-created pet (or a freshly-migrated
one) would derive `tokens` off the household's *entire* all-time total on
its very first read, not 0. So: `tokens = max(0, liveTotal - tokensBaseline
- tokensSpent)`, derived and never stored directly, same shape as
`bankedHours` today — just `tokensBaseline` instead of
`hoursAlreadyGranted`, and no daily cap since nothing needs discarding.
`tokensBaseline` is set once, at pet creation or at this migration, and
never touched again — spending tokens only ever changes `tokensSpent`.

**AFK block grant**: while `activeAfkBlock` is set, a transaction (same
shape as today's `runVisitGrant`, much simpler) grants
`min(elapsed × universalXpPerHour, remaining)` to `activeSkill` on each
visit, where `elapsed` is real time since `lastBlockGrantAt`. The block
clears — becomes purchasable again — the moment either `xpGrantedSoFar`
reaches `hours × universalXpPerHour` *or* real elapsed time since
`startedAt` reaches `hours`, whichever comes first, so a block can't be
stretched by staying away longer than what was actually purchased.

**Migration for pets that already exist under the old system**: full reset,
not a conversion. `skillXP: { woodcutting: 0, gardening: 0, fishing: 0 }`
for every pet, unconditionally — the mascot feature is still WIP, so no
real user is losing anything they'd notice or expect to keep unless that's
called out explicitly, and it isn't here. A one-time, lazy, first-writer-wins
reset (same pattern as every other rollover on this site) is simpler to
reason about and implement than a conversion, and there's no real cost to
choosing the simpler option while nothing's shipped yet:
- `tokensBaseline = liveTotal` (at migration time), `tokensSpent = 0` — so
  `tokens` reads as 0 immediately after migration and only accrues from
  actions going forward, full reset, consistent with the `skillXP` reset
  above. Tokens are a brand-new currency as of this redesign, so there's no
  "old progress" to preserve here in the first place.
- `lastGrantedCounts` initializes to the *current* `achievements-state.counts`
  snapshot, not zero — so the household's pre-redesign activity doesn't
  retroactively dump a burst of tiered XP the moment this ships. Only counts
  that change *after* migration earn tiered XP. Same baseline-snapshot idea
  already used for brand-new pets and the monthly life-stage rollover.
- `activeAfkBlock: null`, `purchasedSkinColors: []`, `equippedHat: null` —
  reset alongside `skillXP`, not left alone: `resolveHat()` doesn't
  re-validate that an equipped hat is still unlocked at the pet's current
  level, it just renders whatever id is stored, so an un-reset
  `equippedHat` would keep showing a hat the reset `skillXP` no longer
  actually earns. `activeSkill` carries over unchanged — it's just a
  selector (which skill trains next), not something the reset invalidates.

**Tokens (and `skillXP`) persist through the monthly reset — only the body
(life stage) runs on a monthly cycle.** The monthly rollover only ever
touches `baselineTotal`/`monthKey` (life stage's own baseline pair,
[mascot.js:301-304](../mascot.js)); it never resets `liveTotal` itself,
which is the *all-time* `achievements-state` sum. Since both `tokens`
(`liveTotal - tokensBaseline - tokensSpent`) and `skillXP` derive from that
same all-time total, they keep accumulating across month boundaries
automatically, with no special-casing needed — this was already true of
`skillXP`/`hoursAlreadyGranted` in the old system too, it just wasn't
stated explicitly until now. The distinction that matters: `baselineTotal`
is a *monthly-scoped* cursor (resets every month), `tokensBaseline` and
`lastGrantedCounts` are *lifetime-scoped* cursors (set once, at pet
creation or this migration, never reset again) — same underlying
`liveTotal`, two different cursor lifetimes layered on top depending on
which axis (permanent skills/currency vs. monthly body) is asking.

**Still open / needs real data, even though shipped:**
- The AFK block's `UNIVERSAL_AFK_XP_PER_HOUR` shipped at `500`, then raised
  to `1000` — still a floated anchor, not a number that's been through the
  same real-usage pass as the token/action numbers below. At `500` the
  10hr block's total (5,000 XP) landed near a typical day's tiered-action
  total (~4,850 XP/day, see the target-pace table above); at `1000` the
  same block is worth roughly *two* days of real activity instead of one —
  a deliberate move away from that original 1:1 anchor, not a recalibration
  off new data. Revisit once there's actual data on how often blocks get
  bought and whether they feel worth the tokens.
- XP-per-action tier values (125 / 300 / 2,500, see table above) are a
  recommendation targeting ~200 days to level 99, not finalized — revisit
  once there's a full month of real data, same posture as everything else
  marked "revisit with real data" in this section.
- The block price table above (5 / 9 / 20 / 35 tokens) is now confirmed,
  not a placeholder — but the underlying 5-tokens-per-hour *base rate*
  itself is still just a starting guess. Whether 5 tokens/hr actually feels
  right depends on how many tokens/day a typical household really produces
  (1 tracked action = 1 token), which needs real usage data to know —
  same "revisit once there's real usage to look at" posture as the
  life-stage thresholds. If the base rate ever changes, the four block
  prices should be recomputed from the same 0/10/20/30% discount curve
  rather than picked independently.
- Post-action "just earned XP" working flourish duration: confirmed at
  2–3 seconds.

## Skin color tiers & smooth color-cycling (shipped)

Reworks the flat "8 free + 4 premium, all 40 tokens" skin-color catalog
from the redesign above into an escalating-price/escalating-flair tier
system, and fixes a real rendering bug uncovered along the way in the
completionist hat's shimmer.

- **Free tier (4 colors) — on-theme by construction.** `SWATCH_COLORS`
  ([mascot.js:56](../mascot.js)) shrank from 8 arbitrary colors to 4,
  reusing the site's own core sage/blue/rose/gold accent colors (`#7C9075`
  / `#5B7B9A` / `#B4636F` / `#C08A2E`) rather than an invented palette —
  genuinely "green/blue/red/yellow" and guaranteed to match the site's own
  look. `DEFAULT_SKIN_COLORS` ([mascot.js:55](../mascot.js)) now assigns
  each pet one of these (blue for userA, rose for userB) instead of the old
  ad hoc defaults. Existing pets' current `skinColor` isn't force-migrated
  — an "orphaned" old color still renders correctly, it just won't show as
  selected in the picker until a new one is chosen; low-risk enough not to
  warrant a migration for a cosmetic-only change.
- **Premium tier (7 entries across 4 price/flair tiers).**
  `PREMIUM_SWATCHES` ([mascot.js:65](../mascot.js)) now carries
  `{ color, price, flair, tierLabel }` per entry instead of a flat 40-token
  list:

  | Tier | Price | Flair | Colors |
  |---|---|---|---|
  | Common | 5 | none | clay `#C97064`, slate `#5C6E78` |
  | Uncommon | 20 | subtle glow pulse | plum `#8B6FA8`, teal `#3F7F73` |
  | Rare | 40 | shimmer pulse | amethyst `#9B59B6`, emerald `#2ECC71` |
  | Legendary | 80 | rainbow cycle | `rainbow` (sentinel `skinColor` value) |

  Common reuses two more of the site's own page accents (continuing the
  original design's approach); Uncommon/Rare use two new colors each,
  picked deliberately distinct from `paletteAt()`'s badge-prestige colors —
  skin color is a cosmetic choice, badge palettes are an earned-skill-tier
  signal, and conflating the two would blur what a viewer is actually
  looking at. The panel groups swatches by `tierLabel` (Common/Uncommon/
  Rare, each with its own price line) instead of one flat "Premium" row.
  Flair is CSS on the swatch itself — Uncommon's pulse is a `filter:
  brightness()` keyframe animation on the swatch (`.mascot-swatch-pulse`);
  Rare's shimmer (and the rainbow swatch) is a small absolutely-positioned
  child bar clipped by the swatch's own circular `overflow: hidden`
  (`.mascot-swatch-shimmer-sweep`), the same sweep-clipped-to-silhouette
  technique the completionist hat's own shimmer uses, scaled down. An
  earlier version used an *outer* `box-shadow` glow for both tiers, which
  read as a stray halo rather than a shimmer — especially against a
  dark-mode panel background — and, due to a copy-paste-shaped bug, never
  actually applied to the rainbow swatch at all (its flair name mapped to
  a CSS class that only ever defined the gradient background, not the
  shimmer animation). Both are fixed now: the sweep is contained entirely
  inside the circle in both themes, and the rainbow swatch gets it too.
  This is the in-picker preview only, not the equipped pet's own
  rendering, which reads from the color/cycle logic below.
- **Bug fix: completionist hat's color cycle was a hard jump-cut, not
  smooth.** The original code picked a single discrete tint every 1.5s
  (`Math.floor(Date.now()/1500)%6`, indexing into the same 6-color
  prestige cycle `paletteAt()` already uses for badges) — every 1.5s the
  hat's trim color would visibly snap to the next color with no
  transition. Root cause: the trim recolor is a canvas multiply-tint
  (`getTintedImage`, since the source art is grayscale and CSS
  `hue-rotate()` has nothing to rotate on grayscale pixels), which only
  ever produces static, discrete images — there's no native way to
  interpolate between two canvas-tinted PNGs.
- **Fix technique: stacked crossfade layers (`buildCyclingLayers`,
  [mascot.js](../mascot.js)).** Rather than genuinely interpolating pixel
  colors (would mean re-tinting on nearly every animation frame — cache-
  blowing and likely laggy), the fix stacks one pre-tinted `<img>` per
  color in the cycle, all sharing one `@keyframes mascot-cycle-fade` rule,
  phase-offset by one slot each via `animation-delay` — the same
  negative-delay/`Date.now()`-based continuity trick `phaseDelay()`
  already uses elsewhere in the file, extended from one layer to N. No
  per-frame canvas work, no new caching strategy needed (`getTintedImage`'s
  existing cache just gets warmed for `CYCLE_LAYERS` colors instead of 1).
  **Revised after initial shipping** (see "Rainbow smoothing + hat/skin
  color sync" below) to remove the flat "hold" plateau the first version
  had, so it's now a true continuous linear crossfade rather than
  hold-then-snap. The max-skill hat's shimmer (a single fixed Amethyst
  tint, never time-based) was untouched by any of this — it had no
  discrete-jump bug to fix.
- **Rainbow skin reuses the same fix.** `pet.skinColor === 'rainbow'` is a
  sentinel value (`RAINBOW_SKIN`, [mascot.js:57](../mascot.js)) checked in
  `renderSprite`'s body-rendering branch — when set, the body renders via
  `buildCyclingLayers` instead of a single `getTintedImage` call. Same
  cycle timing and (as of the revision below) same color source as the
  completionist hat, no separate code path. `precomputeBodyTints` extends
  to warm the tint cache for all `PREMIUM_SWATCHES` colors and all cycle
  colors up front (previously only the free `SWATCH_COLORS` were
  precomputed — a pre-existing gap, not introduced by this change, that
  would have flashed the plain untinted body for one frame the first time
  any premium color was actually equipped).
- **Verified in the offline devtools harness**
  ([mascot-devtools.html](../mascot-devtools.html)): set a pet's skillXP to
  max on all three skills, equipped `completionist`, set `skinColor` to
  `rainbow` via the (now free-text, not `<input type="color">` — that
  input type can't hold a non-hex sentinel) skin-color field, and confirmed
  both the hat trim and the body visibly cycle through colors smoothly
  rather than jump-cutting. Purchased the rainbow swatch through the real
  UI (`purchaseSkinColor`) and confirmed `purchasedSkinColors` and
  `tokensSpent` updated correctly in the mock Firestore doc — no changes
  needed to the purchase/grant transaction logic itself, since it already
  treated skin colors as opaque strings.

## Rainbow smoothing + hat/skin color sync (shipped)

Three follow-up refinements to the color-tier work above, all in
`mascot.js`, prompted by using the shipped feature: the completionist hat
and rainbow skin didn't actually show matching colors when both were
equipped (only matching *cadence*), the rainbow cycle read as a series of
named colors with a quick snap between them rather than a smooth scroll,
and the Rare-tier swatch flair had both a cosmetic problem (outer glow
looked like a stray halo in dark mode) and an actual bug (the rainbow
swatch never got the shimmer animation at all).

- **One shared color array, not two.** Before this, the completionist hat
  cycled through `paletteAt()`'s 6-color badge-prestige palette (gold →
  crimson → verdant → azure → amethyst → obsidian) while the rainbow skin
  cycled through a separate hand-picked 6-hue set — both used identical
  timing constants and the same wall-clock phase anchor, so they were
  always in *lockstep* (same layer index active at the same instant), but
  since the two arrays held different color values, a pet with both
  equipped never actually showed the same color on its hat and body at the
  same time, even though the animations were technically synchronized.
  Fixed by deleting `RAINBOW_CYCLE_COLORS` and the hat's `paletteAt(i)`
  loop in favor of one shared `CYCLE_COLORS` constant
  ([mascot.js:118](../mascot.js)), used by both `buildCyclingLayers` calls.
  Since `getTintedImage`'s cache key is `srcUrl|color`, the same color
  values naturally still produce independently-tinted images for the hat
  trim vs. the body art — no cache collision, just a shared color list.
  This is a deliberate reversal of this doc's own earlier "distinct from
  paletteAt() on purpose" rationale for the rainbow skin (still true for
  the Common/Uncommon/Rare *static* colors, which are unaffected) — once
  synchronization was the explicit goal, sharing one array was the only
  way to guarantee it by construction rather than by coincidence of two
  arrays happening to stay the same length.
- **12 evenly-spaced hues instead of 6.** `CYCLE_COLORS` is generated at
  30° steps around the full hue wheel (`hslToHex(h, 68%, 58%)` for
  `h = 0, 30, 60, ..., 330`) rather than hand-picked named colors — genuine
  full-saturation "RGB lighting" hues (red, orange, yellow, chartreuse,
  green, spring green, cyan, azure, blue, violet, magenta, pink) with no
  low-saturation or near-black outliers (the old badge palette's Obsidian
  entry was near-black, which would have read as a jarring dip in an
  RGB-strip-style scroll). `CYCLE_LAYERS` doubled from 6 to 12 and
  `CYCLE_SLOT_MS` halved from 1500 to 750, keeping the same 9-second total
  cycle length while doubling the color resolution.
- **Continuous linear crossfade, no hold plateau.** The original
  `@keyframes mascot-cycle-fade` faded a layer in over `CYCLE_FADE_MS`
  (400ms), held it at full opacity for the rest of its slot, then faded
  out — meaning most of each slot showed one static color with only a
  brief transition at the boundary, which read as discrete named colors
  rather than a scroll. `CYCLE_FADE_MS` is gone entirely; each layer now
  ramps `0% → 1` linearly over exactly one slot-width and `1 → 0` linearly
  over the next slot-width (keyframe stops at `0%`, `100/CYCLE_LAYERS%`,
  `200/CYCLE_LAYERS%`, `100%`), with no flat region at all. Because every
  layer shares this identical triangular shape just phase-shifted by one
  slot from its neighbors, the rising edge of one layer and the falling
  edge of the adjacent layer occupy the exact same real-time window with
  equal-and-opposite linear slopes — their opacities sum to a constant 1
  throughout the overlap, which is the standard definition of a true
  linear crossfade (the same math a physical two-channel audio crossfader
  or an RGB LED strip's smooth-scroll mode uses), not an approximation of
  one.
- **Swatch flair: outer glow → inner effects, plus a real missing-shimmer
  bug fix.** The Uncommon tier's "pulse" and Rare tier's "shimmer" were
  both an *outer* `box-shadow` glow — visually read as a stray halo rather
  than a shimmer, and looked especially off in dark mode where a white
  halo has much more contrast against the panel's dark background than it
  does in light mode. Pulse is now a `filter: brightness()` keyframe
  animation on the swatch itself (no box-shadow, nothing can bleed outside
  the circle). Shimmer is now a genuine inner sweep: `.mascot-swatch` grew
  `position: relative; overflow: hidden`, and a small diagonal
  `.mascot-swatch-shimmer-sweep` child bar sweeps across, clipped to the
  circle — the same sweep-clipped-to-silhouette technique the
  completionist hat's own shimmer bar already used, just scaled to swatch
  size. Separately, a real bug: the flair-to-class mapping was
  `s.flair ? 'mascot-swatch-' + s.flair : ''`, so the `rainbow` flair value
  produced class `mascot-swatch-rainbow` — which only ever defined the
  conic-gradient background, never the shimmer animation. The peak-tier
  rainbow swatch had *no* animated flair at all, despite being priced and
  positioned as the top option. Fixed by giving any swatch with
  `flair === 'shimmer' || color === RAINBOW_SKIN` both the gradient class
  (rainbow only) and the sweep child.
- **Verified in the offline devtools harness**: with `completionist`
  equipped and `skinColor: 'rainbow'`, screenshotted the pet twice a few
  seconds apart and confirmed the hat trim and body always showed the same
  color as each other at both moments (teal+teal, then pink+pink) — not
  just visually similar, the same hue. Inspected the rendered swatch
  markup directly and confirmed the Rare-tier and rainbow swatches all
  carry `.mascot-swatch-shimmer-sweep` in the DOM.

## Flair-on-equipped-body fix + Legendary tier split (shipped)

Two more follow-ups, both in `mascot.js`.

- **Bug: Uncommon/Rare flair only ever showed on the picker's swatch
  preview, never on the actually-equipped pet.** `renderSprite`'s body
  branch only ever called `getTintedImage` (or `buildCyclingLayers` for
  rainbow) — nothing there looked up `PREMIUM_SWATCHES` at all, so a pet
  wearing a Rare-tier color rendered identically to one wearing a Common
  color, and the "shimmer"/"pulse" flair only existed inside the
  Customize panel's own markup. Fixed with a new `skinFlairFor(color)`
  helper (looks up the matching `PREMIUM_SWATCHES` entry's `flair`) called
  from `renderSprite`: Rare-tier and rainbow colors get the shimmer-bar
  overlay described above (same masked-to-`bodySrc` technique, applied
  directly to the equipped body rather than a swatch); Uncommon-tier
  colors get a `filter: brightness()` pulse (`.mascot-body-pulse`, a
  gentler 1.2× version of the picker swatch's 1.35× pulse — same intensity
  read as too flashy sustained over a whole body sprite rather than an
  18px picker dot) applied directly to the body `<img>`. Both use
  `phaseDelay()` for the same reason every other repeatedly-recreated
  animated element in this file does (see the swatch-picker stutter fix
  above) — render() rebuilds the sprite on every idle tick, so a delay-less
  `animation` would restart from frame 0 each time.
- **Legendary tier split off from Rare, prices adjusted.** Uncommon rose
  from 18 to 20 tokens; the rainbow entry split out of the Rare tier (was
  40 tokens, sharing a tier label with the two static shimmer colors) into
  its own **Legendary** tier at 80 tokens — it's the one skin option with
  genuine ongoing motion (the color cycle itself), not just a static
  color plus a highlight effect, so pricing and labeling it above Rare
  reflects that it's doing something categorically flashier, not just
  "one more Rare color." No code changes were needed beyond the
  `PREMIUM_SWATCHES` data itself — the panel already groups swatches by
  whatever `tierLabel` values are present, so a fourth distinct label
  automatically gets its own price-labeled row.
- **Verified in the offline devtools harness**: set an owned Uncommon
  color as equipped and confirmed via `getComputedStyle` that the body
  `<img>` carries `animation-name: mascot-body-pulse` with a live
  `phaseDelay()`-derived delay (not `0s`). Inspected the rendered picker
  markup and confirmed a standalone "Legendary (80🪙️)" group containing
  only the rainbow swatch, separate from "Rare (40🪙️)"'s two static
  colors.

## Hat/skin-color picker moved to its own page (shipped)

The Customize panel (hat buttons + free/premium/legendary skin-color
swatches) no longer expands inline inside the widget — it's now
`pet-customize.html`, a standalone page reached via a "🎨 Customize" link in
your own pet's panel.

- **Why:** `precomputeBodyTints()`/`precomputeHatTints()` eagerly warmed
  every (image, color) combination the Customize panel could ever need —
  every life stage × every free/premium/legendary color, plus every hat tier
  × every skill — the instant `mascot.js` loaded, on *every* page, whether
  or not anyone ever opened the panel. That's 100+ synchronous canvas
  tint passes (`getImageData`/pixel-loop/`putImageData`/`toDataURL` each)
  burning real main-thread time with zero network activity involved — this
  turned out to be the actual cause of a page-load stall noticed on real
  devices (worse in Chrome than Firefox, much worse on mobile CPUs), not
  anything network- or script-loading-related.
- **Fix:** both precompute functions now only run from the new
  `window.initPetCustomizer()` entry point on `pet-customize.html`, and even
  there they're spread across idle time via `requestIdleCallback`
  (`runIdleQueue`) rather than blocking in one burst. Every other page's
  widget only ever needs the color/hat combo a pet is *currently* wearing —
  one or two combos, not a hundred — which `getTintedImage()`'s existing
  lazy on-demand caching already covers with no code changes needed there.
- **What moved vs. stayed:** skill levels, token balance, the "?" help note,
  and the "train this skill" / AFK-time-purchase controls all stayed
  inline in the widget panel exactly as before — only the hat/color
  pickers moved. The panel's `renderPanel()` customize section shrank to a
  single link; the actual picker markup (hat buttons, free swatches,
  tier-grouped premium/legendary swatches) was extracted into a shared
  `buildCustomizeMarkup(pet)` used only by the new page now.
- **Reused, not duplicated:** `pet-customize.html` loads `mascot.js` like
  every other page and calls straight into its existing
  `setEquippedHat`/`setSkinColor`/`purchaseSkinColor` and `mascotRef()`/
  `achievementsRef()` Firestore helpers — no parallel data-access path, so
  equipping/purchasing from the new page writes to `household/mascot-state`
  exactly the same way the old inline panel did.

## Large static preview + circular back button on the customize page (shipped)

Two follow-ups to `pet-customize.html`, both in service of making it feel
like a real page rather than a bare picker bolted onto a link.

- **Back button restyled to match every other page's home button** — was a
  plain text "‹ Back" link, now the same circular icon-button treatment
  (`.home-btn`'s exact dimensions/shadow/active-scale) with a back-arrow
  SVG glyph instead of the house icon, so the page doesn't look visually
  orphaned from the rest of the site.
- **Large (180×180px) static pet preview**, rendered below the picker in
  the page's normal document flow (not a fixed overlay — it scrolls with
  everything else), with a themed, similarly-scaled-up ground strip behind
  it. Both reuse existing mascot.js machinery rather than anything new:
  - The preview calls `renderSprite()` — the exact same function
    `initMascotWidget`'s roaming pets use — passed a bigger container.
    `renderSprite` was already scale-agnostic (every child element is
    percentage-sized to whatever box it's given), so no changes were
    needed there for sizing.
  - What *did* need a change: `renderSprite` gained a `showProp` parameter
    (default `true`, so the roaming widget's own call site is unaffected)
    that fully suppresses the tool/prop overlay when `false`, since a
    frozen preview mid-tool-swing reads as a rendering bug, not the
    deliberate working flourish it is on the live, animated widget. The
    2-frame idle body-breathing swap is kept (own 650ms tick, same cadence
    as the roaming widget's) — the one animation this preview allows.
  - The ground strip reuses the same two-layer light/dark tile technique
    (`ground-tile-light-mode.png`/`ground-tile-dark-mode.png`, both mounted
    and opacity-toggled rather than swapping `background-image`, to avoid
    the exact decode-stall the two-layer approach exists to prevent) and
    wraps `window.onThemeChange` the same non-clobbering way
    `initMascotWidget`'s own ground-texture hook does.
  - `initPetCustomizer(opts)`'s signature grew from a single `containerId`
    string to `{ pickerContainerId, previewSpriteId, previewGroundId }` —
    the preview args are optional, so the function still works picker-only
    if a future caller only wants that.
- **Note for later, same as above:** tool skins, if they ever ship, are
  exactly the feature this static preview exists to show off — swap
  `showProp: false` for "render whatever tool skin is equipped, statically"
  rather than continuing to hide the prop outright.

## Tints persisted to localStorage (shipped)

Going lazy (see the precompute section above) fixed the page-load stall but
introduced a smaller, ongoing regression: since `getTintedImage`'s in-memory
`tintCache` starts empty on every fresh page load, every color/hat combo
flashed its plain untinted frame for one render *every single time*, not
just the very first time ever — noticeably worse than before, since it used
to never flash at all (everything was pre-warmed).

- **Fix:** `getTintedImage` now checks `localStorage` (one key per combo,
  `mascotTint:<srcUrl>|<color>`) before starting the canvas pass, and writes
  every freshly computed tint there too. A given (image, color) pair's
  correct output is deterministic and never needs invalidating, and
  `srcUrl` already carries `ASSET_VERSION`, so replacing the underlying art
  later busts the cache automatically via a new URL — no expiry logic
  needed. One `localStorage` key per combo rather than one shared JSON
  blob, specifically so writing a new tint never has to re-serialize every
  tint cached before it (that would've reintroduced a smaller version of
  the exact perf problem this whole line of fixes started with). Wrapped
  in try/catch — a full or unavailable `localStorage` (private browsing,
  quota) just means that one combo flashes again next load, nothing breaks.
- **Verified:** a two-pass test (mocked Firestore + mascot.js, no real
  network) confirmed the exact intended behavior — pass one starts with no
  `localStorage` entry, flashes once, and persists a ~700-byte entry after
  settling; pass two (simulating a fresh page load against that same
  `localStorage`) shows the sprite's `<img src>` as a `data:` URL the
  instant `initPetCustomizer` returns, before any async work could
  possibly have finished — i.e., zero flash from the second load onward.
- **Already covers everything tintable, current and future.** Body art,
  hat trims, and the completionist/rainbow cycling layers all flow through
  this one `getTintedImage()` function — there is no second tinting or
  caching path anywhere in `mascot.js`. The cache key is purely
  `(srcUrl, color)`, with no notion of *what kind* of cosmetic it's for, so
  any future tintable customization slot — a buyable-body set, tool skins,
  anything else from `pet-assets/petCosmetics_notes.md`'s open ideas —
  gets this same once-ever-per-browser persistence for free, provided it's
  rendered through `getTintedImage()` rather than a new ad hoc path.
