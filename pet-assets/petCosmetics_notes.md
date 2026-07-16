# Mascot Cosmetics & Unlocks — Working Notes

Scratch doc for cosmetic systems layered on top of the shipped mascot
(life stage, skills/tokens, hats, skin-color tiers — all documented in
[petDesign_notes.md](petDesign_notes.md)). Nothing here is built yet;
this is where new unlock ideas get roughed out before they turn into
real spec/implementation, same "resolved vs. still open" split that
doc already uses.

## Currently shipped, for reference

- **Bodies**: 4 life-stage sprites × 2 idle frames, grayscale, tinted
  live via canvas multiply (`getTintedImage`) using the pet's chosen
  skin color. One fixed art set — no alternate body designs exist yet.
- **Hats**: base + trim two-layer PNGs per hat (base = fixed skill
  identity color, trim = tier-tinted). Unlocked for free at skill
  levels 25/50/75/90/99, plus the completionist hat. Nothing is
  currently *purchasable* — every hat is an XP-gated unlock, tokens
  only buy skin colors and AFK blocks today (`PREMIUM_SWATCHES` /
  AFK-block table in petDesign_notes.md).
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

## Buyable bodies (egg → alternate body art set)

Idea: player spends tokens (or some other currency) on an "egg" that
unlocks a full alternate set of body art — a new look across all 4
life stages, not just a recolor. Scoped the same way the current body
set is: 8 frames (4 stages × 2 idle frames) per egg, same "additive,
not multiplicative" asset philosophy the original design used for
hats/props.

## Buyable hats (purchasable, not just skill-unlocked)

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

## Split body art into base + trim layers (like hats)

Currently the body is a single grayscale layer, tinted as one flat
color via `getTintedImage`. Proposal: split each body frame into two
grayscale layers — **base** (main body mass) and **trim** (a smaller
accent region — belly patch, ear tips, whatever reads as a distinct
"trim" zone per stage) — so skin customization can tint the two
regions independently, the same base/trim split hats already use.
Rendering-wise this is close to free: `renderSprite` already draws hat
base + hat trim as two stacked, independently-tinted `<img>`s per pet;
the body would gain the exact same two-`<img>`-stack pattern instead
of the current single tinted `<img>`. No new tinting technique needed
— `getTintedImage` already handles arbitrary (image, color) pairs and
is cached per combo.

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
  the default body will be post-split. No fixed-palette "special" eggs.
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
- **Buyable hats share the existing `equippedHat` slot** with skill
  hats — one value drawing from a larger pool of ids (skill hats +
  purchasable hats together), not a second accessory slot. No data
  model change beyond more possible values.
- **Buyable-hat storage shape:** `pets.<user>.purchasedHats: [...]`
  alongside the existing `purchasedSkinColors`; `equippedHat` widened
  to reference either pool.
- **Body base/trim split doubles the asset count (8 → 16 frames)**,
  same "additive, not multiplicative" framing as the original hat
  base/trim decision — still just 2 layers per frame, not a per-stage
  multiplier.
- **Body split: trim is the only recolorable region.** The base layer
  is a fixed, consistent look across every pet (not user-tintable);
  only the trim layer takes the pet's chosen skin color. No second,
  independent trim color picker — one skin-color choice still drives
  the whole pet, it just now only paints the trim layer instead of the
  entire body. This also means the premium-flair-interaction question
  (which region carries Uncommon/Rare/Legendary flair) doesn't come up
  — trim is the only tinted region, so flair unambiguously applies
  there, the same way it already keys off a hat's trim today.
- **Body split migration: existing single-layer bodies get trivially
  reissued as a base-only asset** with an empty/transparent trim layer,
  until real two-layer art replaces them — not kept on a separate
  legacy single-layer render path.
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
layer, matching the `pet-body-{stage}-{frame}.png` per-stage file
split the actual body art already uses:

- [`template-fresh.png`](template-fresh.png)
- [`template-in-training.png`](template-in-training.png)
- [`template-rookie.png`](template-rookie.png)
- [`template-champion.png`](template-champion.png)

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
point" sits, per the art spec in `petDesign_notes.md`.

- [`template-hat.png`](template-hat.png) — a single amethyst plus at
  (31, 46), `HAT_ANCHOR_STANDARD`/`HAT_ANCHOR_COMPLETIONIST` in
  `mascot.js:152-157`. Only one marker because every hat — standard,
  max-skill, and completionist alike — is drawn against this same
  shared attachment pixel; there's no per-hat-type variant to
  distinguish. Reusable as a reference overlay for any new buyable
  hat's base/trim layers too, since those follow the same construction.
- [`template-prop.png`](template-prop.png) — three markers, one per
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
`petDesign_notes.md`'s own "Asset file naming" section — same
`pet-assets/` folder, same prefix-groups-files-together logic.

### Bodies — existing convention gains a `-{layer}` suffix

Once the base/trim split ships, every body frame becomes two files
instead of one:

**`pet-body-{stage}-{frame}-{layer}.png`**, `layer` = `base` | `trim`

e.g. `pet-body-fresh-1-base.png`, `pet-body-fresh-1-trim.png`,
`pet-body-fresh-2-base.png`, `pet-body-fresh-2-trim.png`, and the same
four-file pattern for `in-training`, `rookie`, `champion` — 16 files
total, replacing the current 8 single-layer ones. Per the migration
decision above, existing files get reissued as `-base` (not renamed to
something new) with an empty/transparent `-trim` sibling added
alongside each — so this is additive, not an in-place rename.

### Buyable bodies (eggs)

**`pet-body-{eggId}-{stage}-{frame}-{layer}.png`** — same shape as the
default body's filename, with an `{eggId}` slug inserted right after
the `pet-body-` prefix, so every body asset (default and egg alike)
still sorts together under one prefix. `eggId` is a kebab-case
descriptive slug (e.g. `forest`, `shadow`) — it also doubles as the id
stored in `purchasedBodies`/`equippedBody`, so treat it as stable once
shipped; renaming it later needs a data migration, the same caution
already flagged for other shared identifiers in `petDesign_notes.md`.

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

None currently for the three proposals above — every question raised
while roughing them out has a resolved answer in "Locked in." Next
step for each is execution-level: picking real egg/hat art direction
and prices, and actually implementing the base/trim body split in
`mascot.js`.
