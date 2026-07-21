# Mascot Cosmetics & Unlocks — Working Notes

Scratch doc for cosmetic systems layered on top of the shipped mascot
(life stage, skills/tokens, hats, skin-color tiers — current shape in
[mascotSpec_notes.md](mascotSpec_notes.md), full rationale/history in
[mascotHistory_notes.md](mascotHistory_notes.md)). This is where new unlock
ideas get roughed out before they turn into real spec/implementation,
same "resolved vs. still open" split those docs already use. Three of the
proposals below have since actually shipped — the body base/trim split,
the title-rendering system that replaced skill hats' worn-image
rendering, and buyable hats (so far just its first hat, Daisy — the
mechanism itself is real). Real implementation records live in
mascotHistory_notes.md ("Body art split into base + trim layers
(shipped)", "Title rendering system (shipped)", and "Buyable hats — first
shop hat shipped (Daisy)"), not here; this doc keeps only short pointers
to them. Buyable bodies are still unbuilt — **nothing in this doc should
be coded until explicitly told to.**

## Currently shipped, for reference

- **Bodies**: 4 life-stage sprites × 2 idle frames, now **base + trim
  two-layer PNGs per frame** (`pet-body-{stage}-{frame}-{layer}.png`),
  same construction as hats — base is fixed-color and never recolored,
  trim is grayscale and tinted live via canvas multiply (`getTintedImage`)
  using the pet's chosen skin color. Shipped for real across all 4
  stages (Champion currently renders with an empty placeholder trim
  pending real two-layer art — see mascotSpec_notes.md). One fixed art
  set — no alternate body designs (eggs) exist yet.
- **Titles**: skill-level unlocks (25/50/75/90/99, plus completionist)
  render as a colored/shimmer title next to the pet's name
  (`equippedTitle`), not a worn hat image — see mascotHistory_notes.md's
  "Title rendering system (shipped)". The base+trim hat-image pipeline
  (`resolveHat`, hat anchors, hat PNGs) now also serves real buyable hats
  via the separate `equippedHat` field — see mascotHistory_notes.md's
  "Buyable hats — first shop hat shipped (Daisy)". Tokens buy skin colors,
  AFK blocks, and shop hats today (`PREMIUM_SWATCHES` / AFK-block table in
  mascotSpec_notes.md / `HAT_SHOP_ITEMS` in `mascot.js`).
- **Anchoring**: every asset (body, hat base/trim, prop) shares one
  fixed 64×64 canvas and origin. Hats/props position via a per-stage
  head/hand anchor point, translated against the asset's own fixed
  attachment pixel — pure percentage math off the 64px canvas size
  (`mascot.js:1427-1428`, `:1483-1484`). This only works *because*
  every asset is the same 64×64 size with a shared origin.
- **Icons**: skill pills, the XP popup, and the skill-detail panel
  header all use plain emoji (`SKILL_EMOJI`, `mascot.js:46`), not any
  cropped-down asset. `prop-*.png` renders only as the in-sprite
  held-tool overlay (`mascot.js:1482`), never at icon size.

**Implementation note that applies to every idea below:** any new tintable
cosmetic should recolor through the existing `getTintedImage(srcUrl, color)`
in `mascot.js`, not a new ad hoc canvas/tinting path. That function already
persists every computed tint to `localStorage` (keyed purely on
`srcUrl|color`, with no notion of what kind of asset it's for — see
mascotHistory_notes.md's "Tints persisted to localStorage" section) so any
future body set, hat, or other recolorable art gets the once-ever-per-
browser caching for free. A parallel tinting path would silently lose that
and reintroduce the exact page-load-stall/flash problems that function was
built to fix.

## Buyable bodies (egg → alternate body art set)

Idea: player spends tokens (or some other currency) on an "egg" that
unlocks a full alternate set of body art — a new look across all 4
life stages, not just a recolor. Scoped the same way the current body
set is: 8 frames (4 stages × 2 idle frames) per egg, same "additive,
not multiplicative" asset philosophy the original design used for
hats/props.

## Buyable hats (purchasable, not just skill-unlocked)

**First hat shipped — see mascotHistory_notes.md's "Buyable hats — first
shop hat shipped (Daisy)".** The catalog (`HAT_SHOP_ITEMS` in `mascot.js`)
is an array, so this proposal's remaining scope is now just "add more
entries + art," not a new mechanism — the purchase/equip/rendering
pipeline described below is real and shipped.

Idea: alongside the existing skill-level-gated hats, add hats that are
directly purchasable with tokens — same base + trim two-layer
construction as today's skill hats, so a bought hat can be offered in
multiple color tints reusing the same tier ladder the skin-color
system already has (Common/Uncommon/Rare/Legendary) rather than
inventing a separate hat-pricing scheme from scratch. Distinct from
the existing skill hats, not a replacement — skill hats stay
level-gated achievement items ("what has this pet accomplished"),
buyable hats are a separate, parallel unlock track ("what did you
spend tokens on").

**Now the sole consumer of the image-hat pipeline — shipped, see
mascotHistory_notes.md.** Skill hats stopped rendering as a worn image (see
"Title rendering system (shipped)" in mascotHistory_notes.md); `hatHtml`/
`resolveHat()`/the hat anchor constants/the hat entries in
`ALL_ASSET_FILES` and `precomputeHatTints` all stayed in `mascot.js`
exactly as they were — they're just dormant now, waiting for this
still-unbuilt proposal to start feeding `equippedHat` instead of
skill-tier unlocks. A real handoff, not a deletion.

## Skill hat unlocks become ascending titles (WoW-style) — shipped

**No longer a proposal — this shipped.** Skill-tier unlocks
(25/50/75/90/99, plus completionist) now render as a title next to each
pet's name — a skill badge, an escalating title word per tier, colored
in that skill's fixed hue at rising vividness per tier, with a
`background-clip: text` shimmer at max tier and a full-hue-cycle shimmer
for completionist's `Pinnacle`. `equippedHat` split into `equippedTitle`
(skill-tier ids) + `equippedHat` (buyable-hat ids only, going forward).
A custom pet display name (`petName`, editable on the customize page,
defaulting to the signed-in user's own name) shipped alongside it, so a
title reads as "🐟 Ace-Angler Nibbles" rather than prefixing a person's
name. See mascotHistory_notes.md's **"Title rendering system (shipped)"**
section for the full implementation record (the locked color/title
tables, the `titleTextStyle()` shimmer technique, the devtools updates,
and verification) — kept there rather than duplicated here, per this
doc's own intro note.

## Split body art into base + trim layers (like hats) — shipped

**No longer a proposal — this shipped.** The body now uses the same
base + trim two-layer construction hats already used: base is fixed-
color and never recolored, trim is grayscale and takes the pet's skin
color, mirroring exactly the `renderSprite` base + trim stacking hats
already had. See mascotHistory_notes.md's **"Body art split into base +
trim layers (shipped)"** section for the actual implementation record
(art findings, migration of Champion's placeholder trim, the `mascot.js`
changes, `ASSET_VERSION` bump, and devtools verification) — kept there
rather than duplicated here, per this doc's own intro note.

## Locked in

- **Buyable-body scope: 8 frames per egg** (4 stages × 2 idle frames),
  matching the current body set's own frame count — one egg = one full
  alternate body track, not a partial swap.
- **Buyable-body art bar: eggs must read as clearly higher-effort than
  the baseline mascot**, not just a recolored template — better
  shading, more silhouette detail, a distinct read at a glance. If
  multiple eggs/tiers ship, effort should scale with price/rarity (a
  mid-tier egg noticeably sharper than default, a top-tier egg
  genuinely showpiece-quality), rather than flat effort across all eggs
  with price as the only differentiator.
- **Buyable-body palette: follows the base/trim split**, same as the
  default body — grayscale base + trim layers, tinted live the same way
  the default body already is (see the "shipped" pointer above). No
  fixed-palette "special" eggs.
- **Buyable-body anchor points: new eggs are drawn against the same
  per-stage head/hand anchors as the default body**, not their own
  bespoke placement — see the anchor-point templates below.
- **Default body is "egg #0," always owned.** `equippedBody` is a
  single selector with no special-cased null state, same shape as
  `equippedHat` today.
- **Buyable bodies are token-priced**, same currency as skin colors —
  no new currency introduced for this.
- **Buyable-body storage shape:**
  `pets.<user>.purchasedBodies: ['default', 'egg-forest']` +
  `pets.<user>.equippedBody: 'egg-forest'` (starts `['default']` /
  `'default'` for every pet) — same pattern as `purchasedSkinColors` /
  `skinColor` today, token-gated the same way.
- **Buyable hats reuse the skin-color tier ladder** (Common/Uncommon/
  Rare/Legendary) for trim pricing/flair, rather than inventing a
  separate hat-pricing scheme — one base shape, N purchasable trim
  tints, same mechanism standard skill hats already use.
- **Buyable hats are a separate, parallel unlock track from skill
  hats**, not a replacement — skill hats stay the "what has this pet
  accomplished" achievement layer, buyable hats become the "what did
  you spend tokens on" layer.
- **Buyable-hat storage shape (still applies post-shipping the title
  split):** `pets.<user>.purchasedHats: [...]` alongside the existing
  `purchasedSkinColors`; `equippedHat` refers only to that pool (the
  title system's shipped `equippedTitle`/`equippedHat` split — see
  mascotHistory_notes.md — already carved skill-tier ids out of this field,
  so no further data-model change is needed here when buyable hats
  actually ship).
- **Stored art assets stay a fixed 64×64 canvas, always** — no
  re-exporting any asset (existing or future) at a cropped size, since
  every offset in `mascot.js` is a percentage of that hardcoded 64px
  size and depends on every asset sharing an identical canvas and
  origin. If a future asset ever needs to double as an icon, the crop
  happens only at **display time** (e.g. a canvas alpha-bounds scan
  producing a smaller icon-sized canvas, cached per asset the same way
  `getTintedImage` caches tinted output) — the sprite-compositing/
  offset system itself needs zero changes either way.

### Anchor-point templates for drawing new bodies

One 64×64 transparent reference image **per life stage** — split this
way (rather than one combined image) so each can be dropped directly
behind that specific stage's frame in an art tool as its own overlay
layer, matching the `pet-body-{stage}-{frame}-{layer}.png` per-stage
file split the actual body art already uses:

- [`template-fresh.png`](../pet-assets/template-fresh.png)
- [`template-in-training.png`](../pet-assets/template-in-training.png)
- [`template-rookie.png`](../pet-assets/template-rookie.png)
- [`template-champion.png`](../pet-assets/template-champion.png)

Each marks that one stage's head/hand anchor, pulled directly from
`STAGES` in `mascot.js:139-144`, so a new egg's stage art can land its
head/hand anchors in the same place the default body's do (no separate
per-egg offset tuning needed at render time).

- **Marker shape encodes point type**:
  - A solid **plus (+)** marks that stage's **frame-1 head anchor**
    (where hats attach on idle frame 1).
  - A translucent hollow **diamond** marks that stage's **frame-2 head
    anchor** — head anchors aren't stored twice in `mascot.js`; frame 2
    is derived at render time as `head.y + headBob` (only the hat
    shifts vertically between idle frames, per-stage `headBob` in
    `STAGES`), so the diamond is that same math pre-computed onto the
    template rather than a second independent point.
  - A hollow **ring/square** marks that stage's **hand anchor** (where
    the active-skill prop attaches) — identical for both idle frames,
    since only the head moves between them, so there's no separate
    frame-2 marker for hand.
- **Marker color still encodes life stage** even though each file only
  contains one stage now — red = Fresh, orange = In-Training, green =
  Rookie, blue = Champion, matching `STAGES`' order in `mascot.js`, so
  the color stays a consistent visual key if multiple templates are ever
  viewed side by side.
- **Exact coordinates** (asset-space pixels, top-left origin, same as
  `mascot.js`):

  | Stage | File | Head anchor (frame 1) | Head anchor (frame 2) | Hand anchor (both frames) |
  |---|---|---|---|---|
  | Fresh | `template-fresh.png` | (29, 48) | (29, 44) — `headBob -4` | (39, 52) |
  | In-Training | `template-in-training.png` | (28, 38) | (28, 42) — `headBob +4` | (32, 51) |
  | Rookie | `template-rookie.png` | (27, 32) | (27, 34) — `headBob +2` | (25, 50) |
  | Champion | `template-champion.png` | (27, 15) | (27, 13) — `headBob -2` | (22, 48) |

  (Hat/prop attachment points *within* a hat or prop's own canvas are
  on their own two templates below, not included here.)
- Generated straight from the live constants above rather than
  hand-placed, so if `STAGES`' anchors or `headBob` values ever get
  retuned in `mascot.js`, regenerating these files is a mechanical
  re-run, not a re-eyeball.

### Anchor-point templates for drawing new hats/props

Two more 64×64 transparent reference images, this time for the
attachment point *within a hat or prop's own canvas* (as opposed to the
body-side head/hand anchors above) — where that asset's own "grab
point" sits, per the art spec in `mascotSpec_notes.md`.

- [`template-hat.png`](../pet-assets/template-hat.png) — a single amethyst plus at
  (31, 46), `HAT_ANCHOR_STANDARD`/`HAT_ANCHOR_COMPLETIONIST` in
  `mascot.js:152-157`. Only one marker because every hat — standard,
  max-skill, and completionist alike — is drawn against this same
  shared attachment pixel; there's no per-hat-type variant to
  distinguish. Reusable as a reference overlay for any new buyable
  hat's base/trim layers too, since those follow the same construction.
- [`template-prop.png`](../pet-assets/template-prop.png) — three markers, one per
  skill, from `PROP_ANCHORS` in `mascot.js:158-162`: woodcutting (bark
  brown, 33, 46), gardening (leaf green, 36, 54), fishing (water blue,
  48, 48).
- **Neither point lands on an opaque pixel in the current shipped
  assets** — both sit in each asset's own transparent margin, just past
  where the drawn art ends (verified directly against the PNGs: e.g.
  `hat-woodcutting-base.png`'s opaque bounds end at y=37, well above
  the y=46 anchor). These were eyeballed per-asset against each
  silhouette, not derived by a formula off the bounding box — treat the
  marker as "roughly where the head/hand would sit once composited,"
  not a landmark that has to touch painted pixels.
- Same generation approach as the body templates: pulled straight from
  the live `mascot.js` constants, so a future retune of either anchor
  is a mechanical regenerate, not a re-eyeball of the template itself.

## Asset file naming

Extends the existing kebab-case, category-prefix-first convention from
`mascotSpec_notes.md`'s own "Asset naming" section — same
`pet-assets/` folder, same prefix-groups-files-together logic.

### Bodies — existing convention gained a `-{layer}` suffix — shipped

Now that the base/trim split has shipped, every body frame is two files
instead of one:

**`pet-body-{stage}-{frame}-{layer}.png`**, `layer` = `base` | `trim`

e.g. `pet-body-fresh-1-base.png`, `pet-body-fresh-1-trim.png`,
`pet-body-fresh-2-base.png`, `pet-body-fresh-2-trim.png`, and the same
four-file pattern for `in-training`, `rookie`, `champion` — 16 files
total, replacing the previous 8 single-layer ones (deleted via `git rm`
once every stage had a `-base`/`-trim` pair). See mascotHistory_notes.md's
"Body art split into base + trim layers (shipped)" for the actual
migration record, including Champion's placeholder-trim interim state.

### Buyable bodies (eggs)

**`pet-body-{eggId}-{stage}-{frame}-{layer}.png`** — same shape as the
default body's filename, with an `{eggId}` slug inserted right after
the `pet-body-` prefix, so every body asset (default and egg alike)
still sorts together under one prefix. `eggId` is a kebab-case
descriptive slug (e.g. `forest`, `shadow`) — it also doubles as the id
stored in `purchasedBodies`/`equippedBody`, so treat it as stable once
shipped; renaming it later needs a data migration, the same caution
already flagged for other shared identifiers in `mascotHistory_notes.md`.

Example, one egg ("forest") — 16 files, same count/shape as the
default body's own post-split 16: `pet-body-forest-fresh-1-base.png`,
`pet-body-forest-fresh-1-trim.png`, `pet-body-forest-fresh-2-base.png`,
`pet-body-forest-fresh-2-trim.png`, ... through `champion`.

The default body is "egg #0" per the Locked-in decision above, but
keeps its existing unprefixed `pet-body-{stage}-{frame}-{layer}.png`
filenames rather than becoming `pet-body-default-...` — only
*alternate* eggs get the extra `{eggId}` segment.

### Hats — existing convention extends with a `shop` variant

Existing categories are unchanged: `hat-{skill}-{layer}.png`,
`hat-{skill}-max-{layer}.png`, `hat-completionist-{layer}.png`. Buyable
hats add one more, following the same "modifier keyword sits where the
skill name would go" pattern the `max` hats already use:

**`hat-shop-{hatId}-{layer}.png`** — `hatId` a kebab-case slug (e.g.
`tophat`, `bandana`), `layer` = `base` | `trim`. No separate file per
trim color: same as skin colors and skill-hat tier colors today, the
purchasable trim tints are applied live via `getTintedImage`, never
pre-baked per color.

Example, one buyable hat ("tophat") — 2 files, same shape as any
existing skill hat: `hat-shop-tophat-base.png`,
`hat-shop-tophat-trim.png`.

### Props — unchanged

Nothing above adds a new prop category; `prop-{skill}.png` stays as-is.

### Anchor-point templates — reference only, not shipped runtime assets

`template-fresh.png`, `template-in-training.png`, `template-rookie.png`,
`template-champion.png`, `template-hat.png`, `template-prop.png` live in
`pet-assets/` alongside the real assets for convenience, but
`mascot.js` never loads any of them at runtime (no `assetUrl()`
reference, so no `ASSET_VERSION` bump needed if they change) — they're
purely an artist reference, regenerated straight from the live
`mascot.js` anchor constants whenever those change, not a shipped
cosmetic asset themselves.

## Open questions

None currently. The body base/trim split and the title-rendering system
have both shipped (see mascotHistory_notes.md). Buyable bodies and buyable
hats — the two remaining proposals — have no open questions left either;
every question raised while roughing them out already has a resolved
answer in "Locked in." Next step for each is execution-level: real
egg/hat art and prices, then the purchase/equip flow — **still not to be
coded until explicitly told to.**
