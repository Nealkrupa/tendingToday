# Household Mascot — Current Spec

Current behavior and data model only — no rationale, no history, no
superseded systems. For *why* any of this is shaped this way, see
[mascotHistory_notes.md](mascotHistory_notes.md), which this doc points into
per-section below. Split out from a single combined doc on 2026-07-20.

A persistent widget-level pet, separate from the existing "pet upkeep"
feature on Tending Today (`pet:brush`). Self-contained: `mascot.js` injects
its own DOM/CSS at the bottom of every content page (like `priority-alert.js`
does at the top), no page markup changes needed. No hub card — reached only
through the widget itself, plus a dedicated `pet-customize.html` for the
hat/title/skin-color/name picker.

## Two pets, one per household member

One pet per person (`PET_KEYS = ['userA', 'userB']`), shown side by side.
Life stage is shared (one household-wide monthly baseline); skills, tokens,
cosmetics, and AFK blocks are independent per pet, each drawing off the same
shared `household/achievements-state.counts` total. History:
[Two pets](mascotHistory_notes.md#two-pets--one-per-household-member).

## Life stage (cosmetic body, resets monthly)

Four stages, driven by completions *since the start of the current month*
(`monthProgress = liveTotal - baselineTotal`, `baselineTotal` reset on month
rollover, first-writer-wins):

| Stage | Range |
|---|---|
| Fresh | 0–9 |
| In-Training | 10–79 |
| Rookie | 80–299 |
| Champion | 300+ |

Calibrated off an estimated 250–400 tasks/month — not yet revisited against
a full month of real data. History:
[Life stage thresholds](mascotHistory_notes.md#1-life-stage-cosmetic-body-resets-monthly).

## Skills (permanent) — Woodcutting, Gardening, Fishing

Generic roster — any tracked action feeds whichever skill is currently
active. Two independent XP sources, both crediting `skillXP[activeSkill]`
directly (raw XP, level 99 = 1,000,000 XP, RuneScape's curve flattened —
divisor 7→10):

- **Per-action tiered grants**, diffed off `achievements-state.counts` per
  key against a per-key high-water-mark cursor (`lastGrantedCounts`, `Math.max`
  only — closes a check/uncheck/re-check farming exploit):

  | Tier | XP | Example keys |
  |---|---|---|
  | Quick | 125 | `daily:*`, `grocery:item`, `zone:*` |
  | Standard | 300 | `note:resolved`, `meal:recipe`, `pet:brush`, `deep:*` |
  | Perfect-day | 2,500 | `day:perfect` |

  Still a placeholder pending a full month of real data (target pace ~200
  days to level 99). History:
  [Tiered XP + grant mechanism](mascotHistory_notes.md#progression-system-redesign-shipped).

- **Purchased AFK-time blocks**, run one at a time, granting
  `UNIVERSAL_AFK_XP_PER_HOUR = 1000` XP/hr (flat, skill-agnostic) to
  `activeSkill` while active. Clears (becomes purchasable again) at whichever
  comes first: the block's full XP granted, or real elapsed time reaching the
  block's hour count.

  | Block | Price (tokens) | Tokens/hr |
  |---|---|---|
  | 1 hr | 5 | 5.0 |
  | 2 hr | 9 | 4.5 |
  | 5 hr | 20 | 4.0 |
  | 10 hr | 35 | 3.5 |

  Both the XP/hr rate and the 5-tokens/hr base price are still floated
  guesses, not confirmed against usage. History:
  [AFK blocks](mascotHistory_notes.md#progression-system-redesign-shipped).

## Tokens

Separate, uncapped currency: every tracked action = 1 token
(`tokens = max(0, liveTotal - tokensBaseline - tokensSpent)`, derived, never
stored directly). Spent on AFK blocks (above) and skin colors (below), each
gated behind a native `confirm()` prompt before the purchase call. History:
[Post-launch fixes](mascotHistory_notes.md#post-title-system-fixes--art-update-shipped).

## Cosmetics

- **Titles** (`equippedTitle`) — skill-tier unlocks at levels 25/50/75/90/99,
  plus a `completionist` tier when every skill hits 99, render as a colored
  badge + title word next to the pet's name (`titleHtml`/`titleTextStyle`),
  wrapped in a low-opacity same-color pill for contrast. Standard tiers: flat
  color. Max tier: `background-clip: text` gradient shimmer (2600ms). Max
  tier and completionist both loop the shimmer seamlessly via a doubled-stop
  `background-size: 200%` gradient. Unlock status is always computed live
  from current skill levels — never stored as an earned flag; only which
  title is *equipped* is stored, and self-clears to `null` if it no longer
  resolves against current unlocks. History:
  [Title rendering system](mascotHistory_notes.md#title-rendering-system-shipped).
- **Custom pet name** (`petName`) — falls back to the signed-in household
  member's own name until set.
- **Skin color** (`skinColor`, plus `purchasedSkinColors`) — 4 free
  on-theme colors (`SWATCH_COLORS`) plus a tiered premium catalog
  (`PREMIUM_SWATCHES`):

  | Tier | Price | Flair |
  |---|---|---|
  | Common | 5 | none |
  | Uncommon | 20 | brightness pulse |
  | Rare | 40 | inner shimmer sweep |
  | Legendary | 80 | full rainbow color-cycle (`rainbow` sentinel) |

  Body art is two layers (`pet-body-{stage}-{frame}-{base|trim}.png`): base
  is fixed-color and never recolored, trim is grayscale and tinted live via
  `getTintedImage()` (canvas multiply, cached to `localStorage` keyed
  `srcUrl|color`). Champion's trim is still an empty placeholder — Champion
  pets currently render with no skin tint. Rainbow/completionist cycling
  uses 12 evenly-spaced hues (`CYCLE_COLORS`) shared by both the body trim
  and the completionist hat trim, so anything cycling always shows matching
  colors, via a continuous linear crossfade (`buildCyclingLayers`, no hold
  plateau). Flair (pulse/shimmer) renders on the actually-equipped pet too,
  not just the picker swatch. History:
  [Skin color tiers](mascotHistory_notes.md#skin-color-tiers--smooth-color-cycling-shipped),
  [Rainbow smoothing](mascotHistory_notes.md#rainbow-smoothing--hatskin-color-sync-shipped),
  [Body base/trim split](mascotHistory_notes.md#body-art-split-into-base--trim-layers-shipped).
- **Hats** (`equippedHat`) — the base+trim image-hat pipeline (`resolveHat`,
  `hatHtml`, hat anchor constants) still exists in `mascot.js`, fully intact
  but dormant: skill-tier unlocks no longer render as a worn hat (that's
  titles, above), so nothing sets `equippedHat` today. Reserved for the
  still-unbuilt purchasable-hats idea — see
  [mascotScratch_notes.md](mascotScratch_notes.md). Currently cleared to
  `null` unconditionally on every grant.
- **Active-skill prop** (axe/rod/trowel) — swaps automatically with
  `activeSkill`, renders in front of the body. Two states: **working**
  (animated) while an AFK block is active, or for 10 seconds
  (`POST_ACTION_FLOURISH_MS`) right after any direct-action XP grant;
  **hidden** otherwise. The AFK-block "working" state hides while a pet is
  actively wandering (a held tool mid-stride doesn't make sense); the
  post-action flourish shows regardless of wandering, and a grant that
  arrives mid-glide stops the glide in place
  (`interruptGlideForFlourish()`) rather than showing the flourish on a
  moving pet.

## Data model (`household/mascot-state`)

```js
{
  monthKey: '2026-07',       // life-stage baseline, shared by both pets
  baselineTotal: 48213,

  pets: {
    userA: {
      tokensBaseline: 93,      // liveTotal at pet creation/migration; tokensSpent tracks spend
      tokensSpent: 120,
      lastGrantedCounts: { 'daily:bed': 4, /* one entry per achievements-state key */ },

      activeSkill: 'woodcutting',
      skillXP: { woodcutting: 12345000, gardening: 0, fishing: 6200000 },  // raw XP

      equippedTitle: 'woodcutting-25',   // or null — skill-tier ids
      equippedHat: null,                  // reserved for buyable hats, unused today
      petName: null,                      // falls back to signed-in user's name

      skinColor: '#5B7B9A',
      purchasedSkinColors: [],            // hex codes / 'rainbow' owned beyond the 4 free

      activeAfkBlock: null,               // or { hours, price, startedAt, xpGrantedSoFar }
      lastBlockGrantAt: null,
      lastActionGrantAt: <serverTimestamp> // drives the 10s post-action prop flourish
    },
    userB: { /* same shape */ }
  }
}
```

Kept as its own document (not folded into `achievements-state`) to avoid
write contention on a doc every other page already transacts against.
History: [New data model & grant mechanism](mascotHistory_notes.md#new-data-model--grant-mechanism).

## Widget UI

Progressive disclosure, all within the persistent widget:

- **Collapsed (default):** both pets small, wandering a full-width ground
  strip, idling with current life-stage body + equipped title + active-skill
  prop.
- **Tap a pet:** expands to 3 skill pills (emoji + level) plus that pet's
  token balance.
- **Tap a pill:** shows that skill's full XP total; on your own pet only,
  a "train this skill" control (sets `activeSkill`).

`pet-customize.html` (reached via a "🎨 Customize" link, own-pet-only) holds
everything else: title picker, tier-grouped skin-color swatches, pet-name
field, AFK-block purchase buttons, and a large (180×180px) static preview
(`renderSprite(..., showProp: false)`) with a themed ground strip behind it.

**Wandering:** each pet glides to a random spot on the ground strip at a
constant px/sec speed, rests 8–15s, repeats. Ground art is theme-aware
(two pre-mounted, opacity-toggled tile layers). Name/title label renders
above the sprite; `updateMascotNameStacking()` lifts a label higher only
when the *sprites* (not the labels) are currently overlapping, to avoid
premature separation. The viewer's own pet always paints on top when two
sprites cross (`z-index` keyed to `widgetState.myPetKey`). A debounced
resize listener re-clamps any pet that falls outside the ground's current
walkable width.

## Art spec

- **64×64px canvas per asset**, PNG-8/limited palette (~16–32 colors total),
  transparent background always, exported at native size only (scale via CSS
  `image-rendering: pixelated`).
- **2-frame idle animation, body only** — hats/props stay static single
  overlays.
- **Fixed per-stage anchor points** (head for hats, hand for the
  active-skill prop) — every hat/prop shares one attachment pixel within its
  own 64×64 canvas, translated against whichever stage's anchor is active,
  so nothing needs per-stage art variants.
- **Stack order, back to front:** hat → body → active-skill prop.

### Asset naming

| Category | Pattern | Example |
|---|---|---|
| Body | `pet-body-{stage}-{frame}-{base\|trim}.png` | `pet-body-rookie-1-trim.png` |
| Standard skill hat | `hat-{skill}-{base\|trim}.png` | `hat-woodcutting-base.png` |
| Max-skill hat | `hat-{skill}-max-{base\|trim}.png` | `hat-woodcutting-max-trim.png` |
| Completionist hat | `hat-completionist-{base\|trim}.png` | `hat-completionist-base.png` |
| Active-skill prop | `prop-{skill}.png` | `prop-fishing.png` |
| Ground tile | `ground-tile-{theme}-mode.png` | `ground-tile-dark-mode.png` |

Anchor-point reference templates (`template-{stage}.png`, `template-hat.png`,
`template-prop.png`) live alongside the real assets for artist reference
only — never loaded at runtime, no `ASSET_VERSION` bump needed if they
change.

## Cache-busting

`ASSET_VERSION` (currently `'v=7'`, near the top of `mascot.js`) is appended
to every `pet-assets/*.png` URL via `assetUrl()`. Bump it whenever any
`pet-assets/*.png` is replaced in place — and since that's itself an edit to
`mascot.js`, bump that script tag's own `?v=` on every page too, same rule
`notes.md` documents for every other shared script.

## Still open / not yet finalized

Everything below is shipped and working, but the specific numbers are
floated guesses pending real usage data — revisit once there's at least a
full month to look back on:

- Life-stage thresholds (0/10/80/300)
- Per-action XP tier values (125/300/2,500)
- `UNIVERSAL_AFK_XP_PER_HOUR` (1000)
- AFK-block base price (5 tokens/hr)

Buyable bodies and buyable hats are fully unbuilt proposals — see
[mascotScratch_notes.md](mascotScratch_notes.md).
