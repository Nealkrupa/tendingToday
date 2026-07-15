// Household mascot widget — a persistent pixel-art pet per household member,
// living at the bottom of every page the same way priority-alert.js lives at
// the top. Fully self-contained: injects its own <style> and DOM, no page
// markup changes needed. See pet-assets/petDesign_notes.md for the full
// design spec this file implements ("Progression system redesign" section
// for the shape below specifically).
//
// Two independent progression axes, both pure derivations off the same
// household/achievements-state.counts total that already powers the Star
// Board:
//   1. Life stage (Fresh/In-Training/Rookie/Champion) — shared by both pets,
//      resets monthly, driven by completions since the start of the month.
//   2. Skill levels (woodcutting/gardening/fishing) — permanent, independent
//      per pet. XP is granted directly per tracked action the moment it
//      happens (tiered by action type), detected by diffing consecutive
//      achievements-state snapshots against a per-pet cursor — not by an
//      hours-based idle bank (that system had a real bug: see
//      petDesign_notes.md's redesign section for why it was replaced).
//      A separate, uncapped token currency (1 action = 1 token) is spendable
//      on purchasable AFK-time blocks and cosmetic skin colors.
//
// All persisted state lives in a single household/mascot-state document —
// kept separate from achievements-state so this widget never adds write
// contention to a document every other page already transacts against.
(function () {
  // Email -> fixed pet-slot key. Deliberately a small local copy rather than
  // reading auth.js's ALLOWED_EMAILS directly, since this only needs the
  // label mapping, not the auth gate itself. MUST stay in sync with
  // auth.js's ALLOWED_EMAILS/EMAIL_LABELS if a third household member is
  // ever added (add a 'userC' slot here and in the data model).
  const EMAIL_TO_PET_KEY = {
    'nealkrupa@gmail.com': 'userA',
    'natjkrupa@gmail.com': 'userB'
  };
  const PET_KEYS = ['userA', 'userB'];
  // Fallback display labels if auth.js's own label helper isn't available
  // for some reason — kept in sync with auth.js's EMAIL_LABELS.
  const FALLBACK_LABELS = { userA: 'Neal', userB: 'Nat' };

  const SKILLS = ['woodcutting', 'gardening', 'fishing'];
  const SKILL_LABELS = { woodcutting: 'Woodcutting', gardening: 'Gardening', fishing: 'Fishing' };
  // Skill icon shown in the pill row, the skill detail header, and the XP
  // popup — emoji instead of the prop PNGs, since those render at whatever
  // native size each individual tool sprite happens to be, making some
  // noticeably harder to read at a glance than others at a fixed icon size.
  const SKILL_EMOJI = { woodcutting: '🪓', gardening: '🪴', fishing: '🐟' };
  // Trailing U+FE0F forces emoji-style (colored) presentation rather than a
  // monochrome/text-style glyph — some browser/OS font combos render 🪙
  // without it as a flat outline instead of a gold coin. Single constant so
  // every token amount in the widget renders identically.
  const TOKEN_ICON = '🪙️';
  // Free-tier swatches reuse the site's own core sage/blue/rose/gold accent
  // colors — genuinely "green/blue/red/yellow" and on-theme by construction,
  // rather than an arbitrary palette. Each pet's own default is one of these.
  const DEFAULT_SKIN_COLORS = { userA: '#5B7B9A', userB: '#B4636F' };
  const SWATCH_COLORS = ['#7C9075', '#5B7B9A', '#B4636F', '#C08A2E'];
  const RAINBOW_SKIN = 'rainbow';
  // Purchasable skin colors, priced/flaired in three escalating tiers (see
  // petDesign_notes.md's color-tier section for the full rationale): Common
  // reuses two more of the site's own page accents with no extra flair,
  // Uncommon adds a subtle pulse glow, Rare adds a shimmer glow, and the
  // peak Rare-priced Rainbow entry smooth-cycles through hues (same
  // buildCyclingLayers technique used to fix the completionist hat's old
  // discrete color jump — see renderSprite).
  const PREMIUM_SWATCHES = [
    { color: '#C97064', price: 5, flair: null, tierLabel: 'Common' },
    { color: '#5C6E78', price: 5, flair: null, tierLabel: 'Common' },
    { color: '#8B6FA8', price: 20, flair: 'pulse', tierLabel: 'Uncommon' },
    { color: '#3F7F73', price: 20, flair: 'pulse', tierLabel: 'Uncommon' },
    { color: '#9B59B6', price: 40, flair: 'shimmer', tierLabel: 'Rare' },
    { color: '#2ECC71', price: 40, flair: 'shimmer', tierLabel: 'Rare' },
    { color: RAINBOW_SKIN, price: 80, flair: 'rainbow', tierLabel: 'Legendary' }
  ];
  // Looks up a skin color's flair tier — used by renderSprite to decide
  // whether the *equipped* body itself gets a shimmer overlay, not just
  // the picker swatch preview.
  function skinFlairFor(color) {
    const s = PREMIUM_SWATCHES.find((sw) => sw.color === color);
    return s ? s.flair : null;
  }

  const HAT_TIER_LEVELS = [25, 50, 75, 90]; // standard-hat unlock tiers (99 = bespoke max hat, handled separately)

  // ---------------------------------------------------------------------
  // Progression redesign constants — see petDesign_notes.md's "Progression
  // system redesign" section for the full reasoning behind these numbers.
  // ---------------------------------------------------------------------
  // XP granted per tracked action, by tier. Every recordAchievement() key
  // sitewide falls into one of these three (see tierXpForKey below).
  // Calibrated off ~5 days of real completion-rate data to target roughly
  // 200 days to level 99 — a recommendation, not finalized; revisit once
  // there's a full month of real data (see the doc's "Still open" list).
  const XP_TIER_QUICK = 125;
  const XP_TIER_STANDARD = 300;
  const XP_TIER_PERFECT_DAY = 2500;

  // Purchasable AFK-time blocks: hours of "prop animates as working, XP
  // trickles in over elapsed real time" bought as a fixed chunk, priced off
  // a 5-tokens-per-hour base rate with a discount that grows from 0% at 1hr
  // to 30% at 10hr. See the doc's price table for the discount math.
  const TOKEN_BLOCKS = [
    { hours: 1, price: 5 },
    { hours: 2, price: 9 },
    { hours: 5, price: 20 },
    { hours: 10, price: 35 }
  ];
  // Flat XP/hr rate an active AFK block grants, same regardless of which
  // skill is active — separate from the per-action tier values above.
  // Rough starting anchor (not yet worked through the way the tier/token
  // numbers were) — see the doc's "Still open" list.
  const UNIVERSAL_AFK_XP_PER_HOUR = 500;
  // Smooth-color-cycle timing shared by the completionist hat and the
  // rainbow skin (see buildCyclingLayers) — 12 layers at 750ms/slot means
  // one full cycle every 9s, same overall speed as the original 6-layer
  // version but with twice the color resolution for a smoother scroll.
  const CYCLE_LAYERS = 12;
  const CYCLE_SLOT_MS = 750;
  const CYCLE_TOTAL_MS = CYCLE_LAYERS * CYCLE_SLOT_MS;
  // 12 evenly-spaced (30° apart), fully-saturated hues — one shared array
  // used by *both* the completionist hat's trim and the rainbow skin, so
  // when a pet has both equipped they always show the identical color at
  // the identical instant, not just the same cadence. (Previously the hat
  // cycled through achievements.js's 6-color prestige badge palette while
  // the skin cycled through a separate hand-picked rainbow set — same
  // timing, but the actual colors never matched up.)
  const CYCLE_COLORS = ['#DD4B4B', '#DD944B', '#DDDD4B', '#94DD4B', '#4BDD4B', '#4BDD94', '#4BDDDD', '#4B94DD', '#4B4BDD', '#944BDD', '#DD4BDD', '#DD4B94'];
  // How long the prop shows its "working" animation right after a direct
  // action grants XP — a lightweight "you just earned XP" flourish,
  // distinct from the floating "+N XP" popup.
  const POST_ACTION_FLOURISH_MS = 2500;

  // Life stage thresholds — monthProgress = liveTotal - baselineTotal.
  // Fresh 0-9 / In-Training 10-79 / Rookie 80-299 / Champion 300+.
  // Per-stage art anchor points (head/hand, in the shared 64x64 asset
  // coordinate space) and each stage's head-bob pixel offset between idle
  // frame 1 and frame 2 — eyeballed against the actual PNGs' visible
  // silhouettes (checked bounding boxes; exact pixel-perfection isn't
  // critical here, just reasonable placement per the design doc).
  const STAGES = [
    { key: 'fresh', label: 'Fresh', min: 0, head: { x: 29, y: 48 }, hand: { x: 39, y: 52 }, headBob: -4 },
    { key: 'in-training', label: 'In-Training', min: 10, head: { x: 28, y: 38 }, hand: { x: 32, y: 51 }, headBob: 4 },
    { key: 'rookie', label: 'Rookie', min: 80, head: { x: 27, y: 32 }, hand: { x: 25, y: 50 }, headBob: 2 },
    { key: 'champion', label: 'Champion', min: 300, head: { x: 27, y: 15 }, hand: { x: 22, y: 48 }, headBob: -2 }
  ];

  // Attachment point *within* each hat/prop asset's own 64x64 canvas (where
  // that asset's own "grab point" sits) — eyeballed against the actual PNGs.
  // Standard and max-skill hats currently share the same registration point
  // per skill (see final report note: the shipped max-skill art is
  // pixel-identical to the standard hat art in this asset batch, so one
  // anchor covers both).
  const HAT_ANCHOR_STANDARD = { x: 31, y: 46 };
  // Matches HAT_ANCHOR_STANDARD rather than its own value — every hat is
  // drawn with its attachment pixel at the same relative canvas position
  // (per the art spec), so a separate anchor here had no basis and was just
  // making the completionist hat sit visibly higher than every other hat.
  const HAT_ANCHOR_COMPLETIONIST = { x: 31, y: 46 };
  const PROP_ANCHORS = {
    woodcutting: { x: 33, y: 46 },
    gardening: { x: 36, y: 54 },
    fishing: { x: 48, y: 48 }
  };

  // Bump ASSET_VERSION (same cache-busting convention notes.md documents for
  // the shared .js files) whenever a pet-assets PNG is replaced in place —
  // browsers otherwise keep serving the old cached bytes indefinitely, since
  // the filename itself never changes.
  const ASSET_VERSION = 'v=4';
  const ASSET_BASE = 'pet-assets/';
  function assetUrl(file) { return ASSET_BASE + file + '?' + ASSET_VERSION; }

  // Every possible sprite layer, up front. render() rebuilds the sprite's
  // markup (fresh <img> elements) on every idle-frame tick and every live
  // data update, so if the browser hasn't finished decoding an image yet,
  // that rebuild briefly paints blank/unstyled before it lands — visible as
  // a white flash. Preloading all 25 assets the instant this script parses
  // (same "do it before anything else needs it" idea as theme.js/
  // priority-alert.js's cached-state paint) means every render from then on
  // hits an already-decoded image, so the swap is instant.
  const ALL_ASSET_FILES = []
    .concat(STAGES.flatMap((s) => [1, 2].map((f) => 'pet-body-' + s.key + '-' + f + '.png')))
    .concat(SKILLS.flatMap((skill) => ['base', 'trim', 'max-base', 'max-trim'].map((suffix) => 'hat-' + skill + '-' + suffix + '.png')))
    .concat(['hat-completionist-base.png', 'hat-completionist-trim.png'])
    .concat(SKILLS.map((skill) => 'prop-' + skill + '.png'))
    .concat(['ground-tile-light-mode.png', 'ground-tile-dark-mode.png']);

  function preloadAssets() {
    ALL_ASSET_FILES.forEach((file) => {
      const img = new Image();
      img.src = assetUrl(file);
    });
  }
  preloadAssets();

  // ---------------------------------------------------------------------
  // Skill XP curve: RuneScape's formula (flattened: divisor 7 -> 10, i.e.
  // XP requirement doubles every 10 levels instead of 7), then linearly
  // rescaled so level 99 = 1,000,000 XP directly — same target number the
  // old hours-based system already displayed (1000 hours x a x1000 display
  // scale), just reached directly now instead of via an hours intermediate
  // step, since XP is granted per-action rather than drained from a bank.
  // ---------------------------------------------------------------------
  function rsRawXP(level, divisor) {
    let total = 0;
    for (let n = 1; n < level; n++) {
      total += Math.floor(n + 300 * Math.pow(2, n / divisor));
    }
    return Math.floor(total / 4);
  }
  const RAW_99 = rsRawXP(99, 10);
  const XP_SCALE = 1000000 / RAW_99;
  // Cumulative XP required to *reach* level L, for L = 1..99 (index 0 unused).
  const LEVEL_XP = [0];
  for (let L = 1; L <= 99; L++) LEVEL_XP[L] = rsRawXP(L, 10) * XP_SCALE;

  function levelForXP(xp) {
    let lvl = 1;
    for (let L = 1; L <= 99; L++) {
      if (xp >= LEVEL_XP[L]) lvl = L; else break;
    }
    return lvl;
  }
  function xpForLevel(level) { return LEVEL_XP[Math.max(1, Math.min(99, level))]; }

  // ---------------------------------------------------------------------
  // Small month helper — same lazy first-writer-wins rollover pattern used
  // elsewhere on the site (Tending Today's weekly reset, the Star Board's
  // milestone stamping).
  // ---------------------------------------------------------------------
  function currentMonthKey() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
  }
  function stageForProgress(progress) {
    let s = STAGES[0];
    for (const st of STAGES) { if (progress >= st.min) s = st; }
    return s;
  }
  function sumCounts(counts) {
    let total = 0;
    Object.keys(counts || {}).forEach((k) => { total += counts[k] || 0; });
    return total;
  }
  function defaultPet(petKey) {
    return {
      // tokens are always derived, never stored directly — see computeTokens.
      tokensBaseline: 0,   // liveTotal at last reset (pet creation, or the redesign migration)
      tokensSpent: 0,
      // Per-key high-water mark of achievements-state.counts already
      // granted for — see runVisitGrant and tierXpForKey.
      lastGrantedCounts: {},
      activeSkill: 'woodcutting',
      skillXP: { woodcutting: 0, gardening: 0, fishing: 0 },
      equippedHat: null,
      purchasedSkinColors: [],  // hex codes owned beyond the free SWATCH_COLORS
      skinColor: DEFAULT_SKIN_COLORS[petKey] || '#5B7B9A',
      activeAfkBlock: null,     // or { hours, price, startedAt, xpGrantedSoFar }
      lastBlockGrantAt: null,
      lastActionGrantAt: null   // drives the post-action prop flourish
    };
  }

  // ---------------------------------------------------------------------
  // Firestore
  // ---------------------------------------------------------------------
  function mascotRef() { return firebase.firestore().collection('household').doc('mascot-state'); }
  function achievementsRef() { return firebase.firestore().collection('household').doc('achievements-state'); }

  // Every recordAchievement() key sitewide maps to one of three XP tiers.
  // Unlisted keys (contact:added, project:*, bill/subscription/amazon/
  // chewy:added, cancel:completed, wishlist:item, ...) default to Standard
  // — reasonable middle ground for one-off actions that aren't quick
  // checkbox-style taps but also aren't the once-a-day perfect-day bonus.
  function tierXpForKey(key) {
    if (key === 'day:perfect') return XP_TIER_PERFECT_DAY;
    if (key.indexOf('daily:') === 0) return XP_TIER_QUICK;
    if (key === 'grocery:item') return XP_TIER_QUICK;
    if (key.indexOf('zone:') === 0) return XP_TIER_QUICK;
    if (key === 'note:resolved') return XP_TIER_STANDARD;
    if (key === 'meal:recipe') return XP_TIER_STANDARD;
    if (key === 'pet:brush') return XP_TIER_STANDARD;
    if (key.indexOf('deep:') === 0) return XP_TIER_STANDARD;
    return XP_TIER_STANDARD;
  }

  // Tokens are always derived, never stored directly — same shape the old
  // bankedHours calculation used, just with tokensBaseline in place of
  // hoursAlreadyGranted and no daily cap (nothing needs discarding).
  function computeTokens(pet, liveTotal) {
    return Math.max(0, liveTotal - (pet.tokensBaseline || 0) - (pet.tokensSpent || 0));
  }

  // Fires on every live achievements-state update (see initMascotWidget),
  // for the current signed-in user's own pet only. Reads both
  // achievements-state (for liveTotal + per-key counts) and mascot-state
  // inside one transaction so the life-stage rollover, the tiered skill-XP
  // grant, and the AFK-block grant all see one consistent snapshot.
  async function runVisitGrant(petKey) {
    try {
      await firebase.firestore().runTransaction(async (tx) => {
        const achSnap = await tx.get(achievementsRef());
        const mascotSnap = await tx.get(mascotRef());
        const achData = achSnap.exists ? achSnap.data() : {};
        const counts = achData.counts || {};
        const liveTotal = sumCounts(counts);
        const mascotData = mascotSnap.exists ? mascotSnap.data() : {};

        // Life stage: lazy monthly rollover, first-writer-wins. Unrelated to
        // the skill/token redesign below — see petDesign_notes.md's note on
        // why only the body axis is monthly-scoped.
        const monthKey = currentMonthKey();
        let baselineTotal = typeof mascotData.baselineTotal === 'number' ? mascotData.baselineTotal : liveTotal;
        let mKey = mascotData.monthKey || monthKey;
        if (mKey !== monthKey) { mKey = monthKey; baselineTotal = liveTotal; }

        const pets = Object.assign({}, mascotData.pets || {});
        const existingRaw = pets[petKey];
        const isNewPet = !existingRaw;
        // Pets created under the old hours/bank system are detected by the
        // presence of hoursAlreadyGranted — no pet created under this
        // redesign ever has that field. Full reset, not a conversion: the
        // mascot feature is still WIP, so there's no old progress worth
        // preserving here (see petDesign_notes.md's migration note).
        const isLegacyPet = !isNewPet && typeof existingRaw.hoursAlreadyGranted === 'number';
        const pet = Object.assign(defaultPet(petKey), existingRaw || {});

        if (isNewPet || isLegacyPet) {
          pet.tokensBaseline = liveTotal;
          pet.tokensSpent = 0;
          pet.lastGrantedCounts = Object.assign({}, counts);
          pet.skillXP = { woodcutting: 0, gardening: 0, fishing: 0 };
          // Reset alongside skillXP, not left alone — resolveHat() doesn't
          // re-validate that an equipped hat is still unlocked at the
          // pet's current level, it just renders whatever id is stored, so
          // an un-reset equippedHat would keep showing a hat the reset
          // skillXP no longer actually earns.
          pet.equippedHat = null;
          pet.activeAfkBlock = null;
          pet.lastBlockGrantAt = null;
          if (isLegacyPet) {
            // tx.set(..., {merge:true}) merges nested maps field-by-field —
            // fields simply absent from the write are left as-is, not
            // deleted, so a plain JS `delete` here wouldn't actually remove
            // these from Firestore. FieldValue.delete() is the real sentinel
            // for "remove this field," needed since these legacy fields no
            // longer exist in defaultPet() and would otherwise linger
            // forever on already-migrated pets.
            pet.hoursAlreadyGranted = firebase.firestore.FieldValue.delete();
            pet.dailyGrantKey = firebase.firestore.FieldValue.delete();
            pet.dailyGrantedSoFar = firebase.firestore.FieldValue.delete();
            pet.lastVisitAt = firebase.firestore.FieldValue.delete();
          }
        }

        const activeSkill = SKILLS.includes(pet.activeSkill) ? pet.activeSkill : 'woodcutting';
        const skillXP = Object.assign({ woodcutting: 0, gardening: 0, fishing: 0 }, pet.skillXP || {});
        let anyGrant = false;

        // Tiered per-action skill XP: diff live counts against this pet's
        // own per-key high-water mark. Only positive deltas grant (an
        // un-check/un-add isn't a new action) — see tierXpForKey for the
        // tier mapping.
        //
        // Deliberately a high-water mark, not just "the last value seen" —
        // a plain last-seen cursor is farmable: check a task (count 0→1,
        // grants), uncheck it (count 1→0, no grant, but the cursor also
        // drops to 0), check it again (count 0→1 reads as a *fresh*
        // positive delta from the now-lowered cursor, grants XP a second
        // time for the same click). Tracking the highest value each key
        // has ever reached (never lowered by an uncheck) closes this:
        // re-checking back up to a value already reached and paid out for
        // isn't a delta above the high-water mark, so it grants nothing,
        // while a genuine new completion — the underlying achievements-state
        // count climbing past its own all-time peak, e.g. tomorrow's
        // instance of the same daily task — still grants normally. This
        // mirrors the mascot's existing "skills never reset, only go up"
        // philosophy at the grant-mechanism level, not just the stored
        // total.
        const lastGrantedCounts = pet.lastGrantedCounts || {};
        const newLastGrantedCounts = Object.assign({}, lastGrantedCounts);
        Object.keys(counts).forEach((key) => {
          const before = lastGrantedCounts[key] || 0;
          const after = counts[key] || 0;
          if (after > before) {
            skillXP[activeSkill] += (after - before) * tierXpForKey(key);
            anyGrant = true;
          }
          newLastGrantedCounts[key] = Math.max(before, after);
        });

        // AFK block grant, if one's currently active — flat universal rate
        // over real elapsed time since the last grant, clamped to whichever
        // comes first: the block's total XP, or its wall-clock duration.
        let activeAfkBlock = pet.activeAfkBlock || null;
        let lastBlockGrantAt = pet.lastBlockGrantAt || null;
        if (activeAfkBlock) {
          let elapsedHours = 0;
          if (lastBlockGrantAt && typeof lastBlockGrantAt.toMillis === 'function') {
            elapsedHours = Math.max(0, (Date.now() - lastBlockGrantAt.toMillis()) / 3600000);
          }
          const totalBlockXP = activeAfkBlock.hours * UNIVERSAL_AFK_XP_PER_HOUR;
          const remaining = Math.max(0, totalBlockXP - (activeAfkBlock.xpGrantedSoFar || 0));
          const grantable = Math.min(elapsedHours * UNIVERSAL_AFK_XP_PER_HOUR, remaining);
          if (grantable > 0) {
            skillXP[activeSkill] += grantable;
            anyGrant = true;
          }
          const xpGrantedSoFar = (activeAfkBlock.xpGrantedSoFar || 0) + grantable;
          const startedAtMs = activeAfkBlock.startedAt && typeof activeAfkBlock.startedAt.toMillis === 'function'
            ? activeAfkBlock.startedAt.toMillis() : Date.now();
          const wallElapsedHours = Math.max(0, (Date.now() - startedAtMs) / 3600000);
          if (xpGrantedSoFar >= totalBlockXP || wallElapsedHours >= activeAfkBlock.hours) {
            activeAfkBlock = null;
            lastBlockGrantAt = null;
          } else {
            activeAfkBlock = Object.assign({}, activeAfkBlock, { xpGrantedSoFar });
            lastBlockGrantAt = firebase.firestore.FieldValue.serverTimestamp();
          }
        }

        pets[petKey] = Object.assign({}, pet, {
          lastGrantedCounts: newLastGrantedCounts,
          activeSkill,
          skillXP,
          activeAfkBlock,
          lastBlockGrantAt,
          lastActionGrantAt: anyGrant ? firebase.firestore.FieldValue.serverTimestamp() : (pet.lastActionGrantAt || null)
        });

        tx.set(mascotRef(), { monthKey: mKey, baselineTotal, pets }, { merge: true });
      });
    } catch (e) {
      console.error('Mascot visit grant failed', e);
    }
  }

  // Targeted field updates — only ever touch the signed-in user's own pet,
  // never the whole `pets` map, so they can't clobber the other person's
  // pet state on write.
  function setActiveSkill(petKey, skill) {
    mascotRef().set({ pets: { [petKey]: { activeSkill: skill } } }, { merge: true })
      .catch((e) => console.error('Mascot setActiveSkill failed', e));
  }
  function setEquippedHat(petKey, hatId) {
    mascotRef().set({ pets: { [petKey]: { equippedHat: hatId } } }, { merge: true })
      .catch((e) => console.error('Mascot setEquippedHat failed', e));
  }
  function setSkinColor(petKey, color) {
    mascotRef().set({ pets: { [petKey]: { skinColor: color } } }, { merge: true })
      .catch((e) => console.error('Mascot setSkinColor failed', e));
  }

  // Spends tokens on a purchasable skin color — transactional (reads
  // achievements-state for liveTotal, same as the grant transaction) so two
  // rapid purchases can't both succeed off a stale token balance. Silently
  // no-ops if the color's already owned or tokens fall short by the time
  // the transaction actually runs.
  async function purchaseSkinColor(petKey, color, price) {
    try {
      await firebase.firestore().runTransaction(async (tx) => {
        const achSnap = await tx.get(achievementsRef());
        const mascotSnap = await tx.get(mascotRef());
        const liveTotal = sumCounts((achSnap.exists ? achSnap.data() : {}).counts || {});
        const mascotData = mascotSnap.exists ? mascotSnap.data() : {};
        const pets = Object.assign({}, mascotData.pets || {});
        const pet = Object.assign(defaultPet(petKey), pets[petKey] || {});
        const owned = pet.purchasedSkinColors || [];
        if (owned.indexOf(color) !== -1) return; // already owned
        const tokens = computeTokens(pet, liveTotal);
        if (tokens < price) return; // can't afford — button should already be disabled, this is just the race guard
        pets[petKey] = Object.assign({}, pet, {
          tokensSpent: (pet.tokensSpent || 0) + price,
          purchasedSkinColors: owned.concat([color]),
          skinColor: color
        });
        tx.set(mascotRef(), { pets }, { merge: true });
      });
    } catch (e) {
      console.error('Mascot purchaseSkinColor failed', e);
    }
  }

  // Spends tokens on an AFK-time block — same transactional shape as
  // purchaseSkinColor. No-ops if a block's already active (the block itself
  // is the only limiter — see petDesign_notes.md) or tokens fall short.
  async function purchaseAfkBlock(petKey, blockIndex) {
    const block = TOKEN_BLOCKS[blockIndex];
    if (!block) return;
    try {
      await firebase.firestore().runTransaction(async (tx) => {
        const achSnap = await tx.get(achievementsRef());
        const mascotSnap = await tx.get(mascotRef());
        const liveTotal = sumCounts((achSnap.exists ? achSnap.data() : {}).counts || {});
        const mascotData = mascotSnap.exists ? mascotSnap.data() : {};
        const pets = Object.assign({}, mascotData.pets || {});
        const pet = Object.assign(defaultPet(petKey), pets[petKey] || {});
        if (pet.activeAfkBlock) return; // already running a block
        const tokens = computeTokens(pet, liveTotal);
        if (tokens < block.price) return;
        pets[petKey] = Object.assign({}, pet, {
          tokensSpent: (pet.tokensSpent || 0) + block.price,
          activeAfkBlock: { hours: block.hours, price: block.price, startedAt: firebase.firestore.FieldValue.serverTimestamp(), xpGrantedSoFar: 0 },
          lastBlockGrantAt: firebase.firestore.FieldValue.serverTimestamp()
        });
        tx.set(mascotRef(), { pets }, { merge: true });
      });
    } catch (e) {
      console.error('Mascot purchaseAfkBlock failed', e);
    }
  }

  // ---------------------------------------------------------------------
  // Cosmetic unlocks — always computed live off current skill levels, never
  // persisted as an earned flag (skills only ever go up, so there's nothing
  // to re-derive incorrectly).
  // ---------------------------------------------------------------------
  function unlockedHatsForPet(pet) {
    const skillXP = pet.skillXP || {};
    const out = [];
    SKILLS.forEach((skill) => {
      const level = levelForXP(skillXP[skill] || 0);
      HAT_TIER_LEVELS.forEach((tier) => {
        if (level >= tier) out.push({ id: skill + '-' + tier, skill, tier, kind: 'standard' });
      });
      if (level >= 99) out.push({ id: skill + '-max', skill, tier: 99, kind: 'max' });
    });
    const allMaxed = SKILLS.every((skill) => levelForXP(skillXP[skill] || 0) >= 99);
    if (allMaxed) out.push({ id: 'completionist', kind: 'completionist' });
    return out;
  }

  // Resolves an equippedHat id into asset paths + tint info for rendering.
  function resolveHat(hatId) {
    if (!hatId) return null;
    if (hatId === 'completionist') {
      return {
        base: assetUrl('hat-completionist-base.png'),
        trim: assetUrl('hat-completionist-trim.png'),
        anchor: HAT_ANCHOR_COMPLETIONIST,
        shimmer: 'completionist'
      };
    }
    const maxMatch = /^(\w+)-max$/.exec(hatId);
    if (maxMatch) {
      const skill = maxMatch[1];
      return {
        base: assetUrl('hat-' + skill + '-max-base.png'),
        trim: assetUrl('hat-' + skill + '-max-trim.png'),
        anchor: HAT_ANCHOR_STANDARD,
        shimmer: 'max'
      };
    }
    const tierMatch = /^(\w+)-(\d+)$/.exec(hatId);
    if (tierMatch) {
      const skill = tierMatch[1];
      const tier = parseInt(tierMatch[2], 10);
      const tierIndex = HAT_TIER_LEVELS.indexOf(tier);
      return {
        base: assetUrl('hat-' + skill + '-base.png'),
        trim: assetUrl('hat-' + skill + '-trim.png'),
        anchor: HAT_ANCHOR_STANDARD,
        shimmer: null,
        tierIndex: tierIndex < 0 ? 0 : tierIndex
      };
    }
    return null;
  }

  // Reuses achievements.js's existing prestige cycle (gold -> crimson ->
  // verdant -> azure -> amethyst -> obsidian) rather than a new palette.
  // badgePaletteForTier(4) = gold (index 0), so index i maps to tier (4+i).
  function paletteAt(i) {
    if (typeof window.badgePaletteForTier === 'function') {
      const p = window.badgePaletteForTier(4 + (((i % 6) + 6) % 6));
      if (p) return p;
    }
    return { edge: '#C0862E', shimmer: '#FFF6D6' };
  }

  // ---------------------------------------------------------------------
  // Styles
  // ---------------------------------------------------------------------
  const style = document.createElement('style');
  style.textContent = `
    /* Full-width ground strip at the very bottom, but kept short (not a
       tall bar) specifically so it still clears centered bottom-of-page
       controls like home.html's dark mode toggle even though it now spans
       the full width. The panel is a separately fixed-position element
       (see #mascot-panel) so it never moves as pets wander underneath it. */
    #mascot-widget {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 9500;
      font-family: 'Inter', -apple-system, sans-serif;
      pointer-events: none;
      /* Mobile browsers flash a translucent highlight box over a tapped
         button by default — noticeable here since the mascot buttons sit
         on visible ground art rather than blending into a page background. */
      -webkit-tap-highlight-color: transparent;
    }
    #mascot-widget.mascot-hidden { display: none; }
    #mascot-ground {
      position: relative;
      width: 100%;
      height: 72px;
      /* visible, not hidden: the champion-stage hat is anchored high enough
         on the sprite that it renders above this strip's own box (see
         HAT_ANCHOR_STANDARD / stage.head.y in the champion STAGES entry) —
         clipping here cut it off. Background layers below don't need the
         clip: background-image painting is already confined to the
         element's box regardless of overflow. */
      overflow: visible;
      pointer-events: auto;
    }
    /* Both light/dark tiles are mounted (and so already decoded/painted)
       from the start; switching theme just toggles which one is visible
       instead of swapping a background-image URL, which otherwise has a
       brief decode delay the first time that image is actually needed. */
    .mascot-ground-layer {
      position: absolute;
      inset: 0;
      background-repeat: repeat-x;
      background-position: bottom left;
      background-size: auto 100%;
      /* opacity, not display:none — a display:none element isn't painted
         at all, so browsers defer decoding its background-image until it
         actually becomes visible, which reintroduces the exact decode
         delay this two-layer approach exists to avoid. Opacity 0 still
         gets rendered/decoded immediately, just invisible. */
      opacity: 0;
    }
    .mascot-ground-layer.mascot-ground-active { opacity: 1; }
    /* Independent of the ground strip — fixed to its own corner rather than
       anchored relative to whichever pet was tapped, so it stays put while
       both pets keep wandering underneath it. */
    #mascot-panel {
      position: fixed;
      right: 16px;
      bottom: 88px;
      pointer-events: auto;
      width: 300px;
      max-width: calc(100vw - 32px);
      background: var(--card, #FFFFFF);
      border: 1px solid var(--line, #DDE3D6);
      border-radius: 14px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.28);
      padding: 12px 14px;
      display: none;
      max-height: 46vh;
      overflow-y: auto;
      box-sizing: border-box;
    }
    #mascot-panel.mascot-open { display: block; }
    .mascot-slot {
      position: absolute;
      bottom: 4px;
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      cursor: pointer;
      background: none;
      border: none;
      padding: 2px 6px;
      font-family: inherit;
      border-radius: 10px;
      -webkit-tap-highlight-color: transparent;
      outline: none;
      /* left is set inline per-pet, driven by the wandering motion state */
    }
    /* No :hover background — touch browsers frequently apply :hover styles
       on tap and leave them "stuck" until a tap elsewhere, which is exactly
       the rectangle-flash effect being removed here, on both desktop and
       mobile. */
    .mascot-slot-name {
      font-size: 10px;
      font-weight: 700;
      color: var(--muted, #6B7568);
      font-family: 'IBM Plex Mono', monospace;
    }
    .mascot-sprite-box {
      position: relative;
      width: 56px;
      height: 56px;
    }
    .mascot-sprite-box img {
      position: absolute;
      inset: 0;
      width: 100%;
      height: 100%;
      image-rendering: pixelated;
      image-rendering: crisp-edges;
    }
    /* Still used to clip the completionist/max hat's animated shimmer bar
       to the trim's own silhouette — the actual trim recolor no longer uses
       CSS masking at all (see getTintedImage), since mask+blend-mode turned
       out to behave inconsistently across browsers. */
    .mascot-tint-rect {
      position: absolute;
      inset: 0;
      -webkit-mask-repeat: no-repeat;
      mask-repeat: no-repeat;
      -webkit-mask-size: 100% 100%;
      mask-size: 100% 100%;
    }
    .mascot-prop.mascot-working {
      animation: mascot-prop-work 1.1s ease-in-out infinite;
    }
    @keyframes mascot-prop-work {
      0%, 100% { transform: translate(var(--mascot-prop-tx, 0), var(--mascot-prop-ty, 0)) rotate(0deg); }
      50% { transform: translate(var(--mascot-prop-tx, 0), var(--mascot-prop-ty, 0)) rotate(-14deg); }
    }
    @keyframes mascot-shimmer-sweep {
      0%   { transform: translateX(-30px) rotate(20deg); opacity: 0; }
      8%   { opacity: 0.75; }
      45%  { transform: translateX(70px) rotate(20deg); opacity: 0.75; }
      60%  { transform: translateX(90px) rotate(20deg); opacity: 0; }
      100% { transform: translateX(90px) rotate(20deg); opacity: 0; }
    }
    .mascot-shimmer-bar {
      position: absolute;
      top: -20px;
      left: 0;
      width: 10px;
      height: 100px;
      animation: mascot-shimmer-sweep 2.6s ease-in-out infinite;
    }
    /* Stacked crossfade layers (see buildCyclingLayers) — every layer
       shares this one keyframe timeline and is staggered purely via
       animation-delay, so only one @keyframes rule is needed regardless of
       how many colors are in a given cycle. No flat "hold" plateau on
       purpose: each layer ramps 0→1 over exactly one slot then 1→0 over
       the next slot, so at every instant exactly two adjacent layers are
       visible with perfectly complementary opacity (a+b=1) — a true
       continuous linear crossfade between neighboring colors, like an RGB
       light strip scrolling, rather than "hold on a color, then quickly
       snap to the next." Peak (opacity 1) sits at exactly one slot-width
       in, trough back at two slot-widths in. */
    .mascot-cycle-layer {
      opacity: 0;
      animation-name: mascot-cycle-fade;
      animation-duration: ${CYCLE_TOTAL_MS}ms;
      animation-timing-function: linear;
      animation-iteration-count: infinite;
    }
    @keyframes mascot-cycle-fade {
      0% { opacity: 0; }
      ${(100 / CYCLE_LAYERS).toFixed(3)}% { opacity: 1; }
      ${(200 / CYCLE_LAYERS).toFixed(3)}% { opacity: 0; }
      100% { opacity: 0; }
    }

    /* XP popup — lives in its own fixed overlay layer (#mascot-fx-layer),
       not inside the sprite box itself, since that box's innerHTML gets
       rebuilt every idle-frame tick (~650ms) and would kill the animation
       partway through otherwise. */
    #mascot-fx-layer {
      position: fixed;
      inset: 0;
      z-index: 9600;
      pointer-events: none;
    }
    .mascot-xp-popup {
      position: fixed;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 13px;
      font-weight: 700;
      color: var(--gold, #C08A2E);
      text-shadow: 0 1px 2px rgba(0,0,0,0.25);
      animation: mascot-xp-float 1.3s ease-out forwards;
      white-space: nowrap;
    }
    @keyframes mascot-xp-float {
      0%   { transform: translate(-50%, 0); opacity: 0; }
      15%  { opacity: 1; }
      100% { transform: translate(-50%, -42px); opacity: 0; }
    }
    #mascot-panel h4 {
      margin: 0 0 8px 0;
      font-family: 'Fraunces', serif;
      font-size: 15px;
      color: var(--ink, #263029);
    }
    .mascot-close-row { display: flex; justify-content: flex-end; align-items: center; gap: 6px; }
    .mascot-close-btn {
      background: none;
      border: none;
      color: var(--muted, #6B7568);
      font-size: 13px;
      cursor: pointer;
      padding: 2px 6px;
    }
    /* Matches achievements.html's rank-ladder "?" toggle — same circular
       outline-button treatment, reused here for a quick pet-widget primer. */
    .mascot-help-toggle {
      width: 22px;
      height: 22px;
      padding: 0;
      box-sizing: border-box;
      border-radius: 50%;
      border: 1.5px solid var(--line, #DDE3D6);
      background: var(--bg, #EEF1EA);
      color: var(--muted, #6B7568);
      font-family: 'Fraunces', serif;
      font-size: 13px;
      font-weight: 600;
      line-height: 1;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      flex-shrink: 0;
      transition: border-color 0.15s ease, color 0.15s ease;
    }
    .mascot-help-toggle:hover { border-color: var(--gold, #C08A2E); color: var(--gold, #C08A2E); }
    .mascot-help-note {
      margin: 6px 0 10px;
      font-size: 12px;
      line-height: 1.5;
      color: var(--muted, #6B7568);
      font-style: italic;
    }
    .mascot-help-note ul { margin: 4px 0 0; padding-left: 18px; }
    .mascot-help-note li { margin-bottom: 3px; }
    .mascot-bank-line {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 12px;
      color: var(--muted, #6B7568);
      margin-bottom: 10px;
    }
    .mascot-pill-row { display: flex; gap: 8px; flex-wrap: wrap; }
    .mascot-pill {
      display: flex;
      align-items: center;
      gap: 6px;
      background: var(--bg, #EEF1EA);
      border: 1px solid var(--line, #DDE3D6);
      border-radius: 999px;
      padding: 5px 10px 5px 6px;
      cursor: pointer;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 12px;
      font-weight: 700;
      color: var(--ink, #263029);
    }
    .mascot-pill-icon { font-size: 15px; line-height: 1; }
    .mascot-skill-detail { font-size: 13px; color: var(--ink, #263029); }
    .mascot-xp-line { color: var(--muted, #6B7568); font-size: 12px; margin: 4px 0 10px; }
    /* Outlined pill style (background/ink from the shared card+ink tokens,
       border-only accent) rather than a solid accent fill with hardcoded
       white text — matches auth.js's sign-in button, and keeps working
       contrast in dark mode where --sage becomes a pale, low-contrast tone
       that reads poorly under white text. */
    .mascot-train-btn, .mascot-hat-btn {
      background: var(--card, #FFFFFF);
      color: var(--ink, #263029);
      border: 1.5px solid var(--sage, #7C9075);
      border-radius: 8px;
      padding: 6px 12px;
      font-size: 12px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
      margin: 3px 4px 3px 0;
      transition: border-color 0.15s ease;
    }
    .mascot-train-btn:hover, .mascot-hat-btn:hover { border-color: var(--ink, #263029); }
    .mascot-train-btn[disabled] {
      opacity: 0.6;
      cursor: default;
      border-color: var(--line, #DDE3D6);
      color: var(--muted, #6B7568);
    }
    .mascot-hat-btn.mascot-hat-equipped {
      background: var(--sage, #7C9075);
      color: var(--card, #FFFFFF);
      border-color: var(--sage, #7C9075);
    }
    .mascot-hat-list { display: flex; flex-wrap: wrap; margin-top: 6px; }
    .mascot-swatch-row { display: flex; gap: 6px; margin-top: 8px; }
    .mascot-swatch {
      position: relative;
      width: 18px; height: 18px; border-radius: 50%;
      border: 1.5px solid var(--line, #DDE3D6);
      cursor: pointer;
      overflow: hidden;
    }
    .mascot-swatch.mascot-swatch-active { border-color: var(--ink, #263029); border-width: 2px; }
    /* Escalating flair by premium tier. Both used to be an *outer*
       box-shadow glow, which read as a stray halo (especially against a
       dark-mode panel background) rather than a shimmer on the swatch
       itself. Uncommon now gets a plain brightness pulse (no box-shadow at
       all, so nothing can bleed outside the circle); Rare and the rainbow
       skin get an inner diagonal sweep instead (.mascot-swatch-shimmer-sweep,
       a child element clipped by this circle's own overflow:hidden) — same
       sweep-clipped-to-silhouette technique the completionist hat's own
       shimmer already uses, just scaled down to swatch size. */
    .mascot-swatch-pulse { animation: mascot-swatch-pulse 2.2s ease-in-out infinite; }
    @keyframes mascot-swatch-pulse {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(1.35); }
    }
    /* Same idea as the swatch pulse above but gentler (1.35 read as too
       flashy sustained over a whole body art frame rather than an 18px
       picker swatch) — applied to the equipped pet's body when an
       Uncommon-tier color is active, not just the picker preview. */
    .mascot-body-pulse { animation: mascot-body-pulse 2.2s ease-in-out infinite; }
    @keyframes mascot-body-pulse {
      0%, 100% { filter: brightness(1); }
      50% { filter: brightness(1.2); }
    }
    .mascot-swatch-shimmer-sweep {
      position: absolute;
      top: -7px;
      left: -9px;
      width: 4px;
      height: 32px;
      background: rgba(255,255,255,0.9);
      animation: mascot-swatch-shimmer-sweep 1.8s ease-in-out infinite;
    }
    @keyframes mascot-swatch-shimmer-sweep {
      0%   { transform: translateX(-6px) rotate(20deg); opacity: 0; }
      15%  { opacity: 0.9; }
      55%  { transform: translateX(24px) rotate(20deg); opacity: 0.9; }
      70%  { transform: translateX(28px) rotate(20deg); opacity: 0; }
      100% { transform: translateX(28px) rotate(20deg); opacity: 0; }
    }
    .mascot-swatch-rainbow {
      background: conic-gradient(from 0deg, ${CYCLE_COLORS.join(', ')}, ${CYCLE_COLORS[0]});
    }
    .mascot-swatch-locked {
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'IBM Plex Mono', monospace;
      font-size: 8px;
      font-weight: 700;
      color: #FFFFFF;
      text-shadow: 0 1px 1px rgba(0,0,0,0.6);
    }
    .mascot-afk-active {
      font-family: 'IBM Plex Mono', monospace;
      font-size: 12px;
      color: var(--gold, #C08A2E);
      font-weight: 700;
      margin-bottom: 4px;
    }
    .mascot-afk-row { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 6px; }
    .mascot-afk-btn {
      background: var(--card, #FFFFFF);
      color: var(--ink, #263029);
      border: 1.5px solid var(--gold, #C08A2E);
      border-radius: 8px;
      padding: 5px 10px;
      font-size: 11.5px;
      font-weight: 700;
      font-family: inherit;
      cursor: pointer;
    }
    .mascot-afk-btn[disabled] {
      opacity: 0.5;
      cursor: default;
      border-color: var(--line, #DDE3D6);
      color: var(--muted, #6B7568);
    }
    .mascot-back-btn {
      background: none; border: none; color: var(--muted, #6B7568);
      font-size: 12px; cursor: pointer; padding: 0 0 8px 0;
      font-family: inherit;
    }
  `;
  document.head.appendChild(style);

  // ---------------------------------------------------------------------
  // DOM scaffold
  // ---------------------------------------------------------------------
  function ensureDom() {
    let root = document.getElementById('mascot-widget');
    if (root) return root;
    root = document.createElement('div');
    root.id = 'mascot-widget';
    root.className = 'mascot-hidden';
    root.innerHTML = `
      <div id="mascot-panel"></div>
      <div id="mascot-ground">
        <div id="mascot-ground-light" class="mascot-ground-layer"></div>
        <div id="mascot-ground-dark" class="mascot-ground-layer"></div>
      </div>
    `;
    document.body.appendChild(root);
    root.querySelector('#mascot-ground-light').style.backgroundImage = "url('" + assetUrl('ground-tile-light-mode.png') + "')";
    root.querySelector('#mascot-ground-dark').style.backgroundImage = "url('" + assetUrl('ground-tile-dark-mode.png') + "')";
    applyGroundTexture();
    return root;
  }

  // Toggles which of the two already-mounted ground layers is visible,
  // rather than swapping a shared background-image URL — both tiles are
  // set once (in ensureDom(), never touched again) so they're already
  // decoded/painted, meaning a theme switch is an instant display toggle
  // instead of waiting on a fresh image decode. Checked on every render()
  // (cheap: a no-op unless the theme actually changed) rather than wired to
  // window.onThemeChange, since that's a single global hook other pages
  // (e.g. home.html) already define for their own dark-mode icon refresh,
  // and mascot.js claiming it too would silently clobber theirs.
  let lastGroundTheme = null;
  function applyGroundTexture() {
    const lightLayer = document.getElementById('mascot-ground-light');
    const darkLayer = document.getElementById('mascot-ground-dark');
    if (!lightLayer || !darkLayer) return;
    const theme = document.documentElement.getAttribute('data-theme') === 'dark' ? 'dark' : 'light';
    if (theme === lastGroundTheme) return;
    lastGroundTheme = theme;
    lightLayer.classList.toggle('mascot-ground-active', theme === 'light');
    darkLayer.classList.toggle('mascot-ground-active', theme === 'dark');
  }

  function ensureFxLayer() {
    let el = document.getElementById('mascot-fx-layer');
    if (!el) {
      el = document.createElement('div');
      el.id = 'mascot-fx-layer';
      document.body.appendChild(el);
    }
    return el;
  }

  // Floats a "+<emoji><N>" popup upward from whichever pet's sprite just
  // gained XP in that skill, then removes itself once the CSS animation
  // finishes. Positioned via getBoundingClientRect against the live sprite
  // box rather than being a child of it, since the sprite box's own
  // innerHTML is torn down and rebuilt on every idle-frame tick.
  function showXpPopup(petKey, skill, xpAmount) {
    const spriteBox = document.getElementById('mascot-sprite-' + petKey);
    if (!spriteBox) return;
    const rect = spriteBox.getBoundingClientRect();
    const layer = ensureFxLayer();
    const el = document.createElement('div');
    el.className = 'mascot-xp-popup';
    el.textContent = '+' + SKILL_EMOJI[skill] + Math.round(xpAmount).toLocaleString();
    el.style.left = (rect.left + rect.width / 2) + 'px';
    el.style.top = rect.top + 'px';
    layer.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  // Floats a single "+N 🪙" popup over the whole widget (not per-pet) when
  // the shared household completion total ticks up — since that total feeds
  // both pets' token balances equally and identically (tokensBaseline is a
  // fixed per-pet offset, so a liveTotal increase raises both by the same
  // delta regardless of each pet's own baseline), one popup for the whole
  // widget reads better than duplicating it over each sprite.
  function showTokenPopup(tokens) {
    const ground = document.getElementById('mascot-ground');
    if (!ground) return;
    const rect = ground.getBoundingClientRect();
    const layer = ensureFxLayer();
    const el = document.createElement('div');
    el.className = 'mascot-xp-popup';
    el.textContent = '+' + tokens.toLocaleString() + ' ' + TOKEN_ICON;
    el.style.left = (rect.left + rect.width / 2) + 'px';
    el.style.top = rect.top + 'px';
    layer.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
  }

  // ---------------------------------------------------------------------
  // Sprite rendering
  // ---------------------------------------------------------------------
  // Builds the layered sprite (hat -> body -> prop) for one pet into the
  // given container element. `frame` is 1 or 2 (idle animation).
  // ---------------------------------------------------------------------
  // Canvas-based tinting — replaces the CSS mask-image + mix-blend-mode
  // technique previously used for the body's skin color and hat trim
  // recolors. That combination turned out to behave inconsistently across
  // browsers (worked in Chromium, inert in Firefox), so this does the
  // actual pixel recolor math in an offscreen <canvas> instead, which
  // doesn't depend on any browser's mask-mode/blend-mode implementation.
  // ---------------------------------------------------------------------
  const tintCache = {};   // "srcUrl|#hexColor" -> tinted data URL, once ready
  const tintPending = {}; // same key -> true while its Image is decoding

  // render() rebuilds every sprite's markup from scratch on every idle-frame
  // tick (~650ms) and every live data update — far more often than the
  // shimmer sweep (2.6s) or prop-work bob (1.1s) animations' own durations.
  // A freshly-created element's CSS animation always starts at 0%, so
  // without this those animations could never complete even one full cycle
  // before being torn down and restarted, which reads as a stutter. Giving
  // each new element a *negative* animation-delay equal to how far the
  // current wall-clock time sits within that animation's period makes it
  // start already at the correct phase, so recreating the DOM node is
  // visually seamless instead of resetting the animation.
  function phaseDelay(durationMs) {
    return '-' + (Date.now() % durationMs) + 'ms';
  }

  function hexToRgb(hex) {
    const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex || '');
    return m ? { r: parseInt(m[1], 16), g: parseInt(m[2], 16), b: parseInt(m[3], 16) } : { r: 255, g: 255, b: 255 };
  }

  // Returns the tinted data URL if it's already been computed. Otherwise
  // kicks off the (async) computation once and returns null — render() gets
  // called again automatically the moment it's ready (see img.onload below),
  // so callers should fall back to the plain source image for that one
  // in-between frame.
  function getTintedImage(srcUrl, tintColor) {
    const key = srcUrl + '|' + tintColor;
    if (tintCache[key]) return tintCache[key];
    if (!tintPending[key]) {
      tintPending[key] = true;
      const img = new Image();
      img.onload = function () {
        const canvas = document.createElement('canvas');
        canvas.width = img.naturalWidth;
        canvas.height = img.naturalHeight;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0);
        const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
        const data = imageData.data;
        const tint = hexToRgb(tintColor);
        for (let i = 0; i < data.length; i += 4) {
          if (data[i + 3] === 0) continue; // fully transparent — leave untouched
          // Same math a CSS multiply blend would do: since this source art
          // is grayscale (R=G=B), each channel scales by the tint's own
          // channel value. Alpha is left alone, so the silhouette needs no
          // separate mask at all — only pixels already opaque get recolored.
          data[i] = Math.round((data[i] / 255) * tint.r);
          data[i + 1] = Math.round((data[i + 1] / 255) * tint.g);
          data[i + 2] = Math.round((data[i + 2] / 255) * tint.b);
        }
        ctx.putImageData(imageData, 0, 0);
        tintCache[key] = canvas.toDataURL();
        delete tintPending[key];
        render();
      };
      img.src = srcUrl;
    }
    return null;
  }

  // Simulates smooth color-cycling using only cheap, pre-cached discrete
  // tints. Genuine per-pixel hue interpolation isn't practical here: the
  // source art is grayscale and recolored via canvas multiply-tint (see
  // getTintedImage above), so CSS hue-rotate() has nothing to rotate, and
  // re-tinting on every frame would blow the tint cache and likely lag.
  // Instead this stacks one pre-tinted <img> per color, all sharing the same
  // mascot-cycle-fade keyframes (fade in, hold, fade out, then stay hidden
  // for the rest of the cycle) but phase-offset by one slot each via
  // animation-delay — the codebase's existing negative-delay/Date.now()
  // continuity trick (see phaseDelay above), extended to a multi-layer
  // stagger. At any instant exactly one layer is at full opacity and its
  // neighbor is fading in/out under it, reading as a smooth cycle even
  // though every individual layer is a static, already-cached image.
  function buildCyclingLayers(srcUrl, colors) {
    return colors.map((color, i) => {
      const tinted = getTintedImage(srcUrl, color) || srcUrl;
      const delay = '-' + ((Date.now() + i * CYCLE_SLOT_MS) % CYCLE_TOTAL_MS) + 'ms';
      return `<img src="${tinted}" class="mascot-cycle-layer" style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;animation-delay:${delay};" />`;
    }).join('');
  }

  // Eagerly warms the tint cache for every body-frame + stock-swatch-color
  // combination. Without this, the *first* time any given (image, color)
  // pair is needed, getTintedImage() returns null for that render and the
  // caller falls back to the plain (untinted, light grayscale) source image
  // for one frame — since render() fires so often (every idle-frame tick),
  // that fallback was visible as a stray light/white flash until the async
  // canvas decode finished. Precomputing every combo up front means that
  // fallback essentially never gets hit during normal use.
  function precomputeBodyTints() {
    STAGES.forEach((stage) => {
      [1, 2].forEach((frame) => {
        const src = assetUrl('pet-body-' + stage.key + '-' + frame + '.png');
        SWATCH_COLORS.forEach((color) => getTintedImage(src, color));
        // Also warms every premium color (previously only free SWATCH_COLORS
        // were precomputed, so a freshly-purchased premium color would flash
        // the plain untinted art for one frame) and the rainbow cycle's own
        // hues, so its crossfade layers are already cached the first time
        // any pet equips it rather than fading in layer-by-layer.
        PREMIUM_SWATCHES.forEach((s) => { if (s.color !== RAINBOW_SKIN) getTintedImage(src, s.color); });
        CYCLE_COLORS.forEach((color) => getTintedImage(src, color));
      });
    });
  }
  precomputeBodyTints();

  // Same idea for hat trims, but this can't run until achievements.js has
  // defined window.badgePaletteForTier (paletteAt() falls back to a fixed
  // gold color otherwise) — mascot.js's own top-level code runs before
  // achievements.js's script tag on every real page, so this is called from
  // initMascotWidget() instead, once auth/all scripts have resolved.
  function precomputeHatTints() {
    SKILLS.forEach((skill) => {
      const trimUrl = assetUrl('hat-' + skill + '-trim.png');
      HAT_TIER_LEVELS.forEach((tier, tierIndex) => { getTintedImage(trimUrl, paletteAt(tierIndex).edge); });
      const maxTrimUrl = assetUrl('hat-' + skill + '-max-trim.png');
      getTintedImage(maxTrimUrl, paletteAt(4).edge);
    });
    const completionistTrimUrl = assetUrl('hat-completionist-trim.png');
    CYCLE_COLORS.forEach((color) => getTintedImage(completionistTrimUrl, color));
  }

  // ---------------------------------------------------------------------
  // Wandering — each pet slowly glides to a random spot on the ground
  // strip, then stays put for a while (long enough to actually see the
  // tool-working animation) before picking a new spot. Purely a local
  // visual flourish: not persisted, not synced to Firestore or other
  // devices/tabs — every page load starts it fresh.
  // ---------------------------------------------------------------------
  const WALK_SPEED_PX_PER_SEC = 18; // slow, deliberate glide, not a dash
  const MIN_STATIONARY_MS = 8000;
  const MAX_STATIONARY_MS = 15000;
  const SPRITE_SIZE = 56;           // matches .mascot-sprite-box's own width/height

  // petKey -> { x, walking, moveDuration, moveEndsAt, stationaryUntil, facing }.
  // The glide itself is driven by a real CSS transition on `left` (set once
  // per move, in render()) rather than by recomputing an interpolated
  // position every tick — render() already reruns constantly for unrelated
  // reasons (idle-frame swap, live data updates) at a cadence too coarse to
  // hand-animate smoothly in JS, so letting the browser's own transition
  // engine own the motion is what actually makes it smooth. `x` here always
  // holds the current *target* (mid-glide) or *settled* (stationary) x —
  // JS never needs to know the exact in-between pixel position.
  const motionState = {};

  function groundWalkableWidth() {
    const ground = document.getElementById('mascot-ground');
    const w = ground ? ground.clientWidth : 0;
    return Math.max(0, (w || 300) - SPRITE_SIZE);
  }

  // Keep wandering pets from settling visually on top of each other — a
  // target within this distance of another pet's own x is rejected below.
  const MIN_PET_SEPARATION_PX = SPRITE_SIZE * 1.3;

  function otherPetXs(excludeKey) {
    return PET_KEYS.filter((k) => k !== excludeKey && motionState[k]).map((k) => motionState[k].x);
  }

  // Picks an x in [0, maxX] that's a meaningfully different spot from
  // `fromX` (so every move reads as "went somewhere") and, when other pets
  // are also wandering, stays at least MIN_PET_SEPARATION_PX from each of
  // them. Falls back to the middle of the largest free gap between other
  // pets (and the ground's own edges) so it always resolves even on a
  // narrow mobile ground strip too tight to satisfy full separation.
  function pickWanderTarget(petKey, maxX, fromX) {
    if (maxX <= 0) return 0;
    const others = otherPetXs(petKey);
    const minMoveDist = maxX * 0.2;
    const isGoodCandidate = (candidate) =>
      Math.abs(candidate - fromX) >= minMoveDist &&
      others.every((ox) => Math.abs(candidate - ox) >= MIN_PET_SEPARATION_PX);

    for (let i = 0; i < 10; i++) {
      const candidate = Math.random() * maxX;
      if (isGoodCandidate(candidate)) return candidate;
    }
    const points = [0, ...others.slice().sort((a, b) => a - b), maxX];
    let bestStart = 0, bestSize = -1;
    for (let i = 0; i < points.length - 1; i++) {
      const size = points[i + 1] - points[i];
      if (size > bestSize) { bestSize = size; bestStart = points[i]; }
    }
    return Math.max(0, Math.min(maxX, bestStart + bestSize / 2));
  }

  function ensureMotion(petKey) {
    if (motionState[petKey]) return motionState[petKey];
    motionState[petKey] = {
      x: pickWanderTarget(petKey, groundWalkableWidth(), -Infinity),
      walking: false,
      moveDuration: 0,
      moveEndsAt: 0,
      facing: 'right',
      // Stagger each pet's very first move so both don't set off in sync.
      stationaryUntil: Date.now() + 1000 + Math.random() * 4000,
      // Which grant's flourish (by lastActionGrantAt ms) already interrupted
      // a glide in progress — see interruptGlideForFlourish — so a single
      // flourish doesn't re-snap the pet on every idle-frame re-render
      // during its whole visible window.
      lastFlourishInterruptAt: 0
    };
    return motionState[petKey];
  }

  // Starts a new glide: picks a target, records direction (for mirroring)
  // and how long the CSS transition should run, and marks walking=true.
  // The actual `left`/`transition` CSS gets applied once by render(),
  // right when this returns — not touched again until the glide finishes.
  function startNewMove(petKey) {
    const m = ensureMotion(petKey);
    const maxX = groundWalkableWidth();
    const target = pickWanderTarget(petKey, maxX, m.x);
    const dist = Math.abs(target - m.x);
    m.facing = target >= m.x ? 'right' : 'left';
    // No minimum-duration floor — speed (px/sec) must stay identical
    // regardless of distance, so duration is purely dist / speed. The
    // "avoid a barely-different target" check above already keeps every
    // move a meaningful distance, so this doesn't produce near-instant hops.
    m.moveDuration = (dist / WALK_SPEED_PX_PER_SEC) * 1000;
    m.moveEndsAt = Date.now() + m.moveDuration;
    m.x = target;
    m.walking = true;
  }

  // Viewport width changes (orientation flip, mobile address-bar
  // collapse/expand) aren't watched anywhere else — without this, a pet
  // already sitting near the old, wider edge just stays at that x and can
  // render past the new, narrower edge until its next move happens to
  // start (up to MAX_STATIONARY_MS later). Snap any now-out-of-bounds pet
  // back inside immediately, bypassing the glide transition so it doesn't
  // visibly slide in from off-screen.
  let resizeListenerAdded = false;
  function addResizeClampListener() {
    if (resizeListenerAdded) return;
    resizeListenerAdded = true;
    let resizeTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        const maxX = groundWalkableWidth();
        PET_KEYS.forEach((key) => {
          const m = motionState[key];
          if (!m || m.x <= maxX) return;
          m.x = maxX;
          m.walking = false;
          const slot = document.getElementById('mascot-slot-' + key);
          if (!slot) return;
          slot.style.transition = 'none';
          slot.style.left = m.x + 'px';
          void slot.offsetWidth; // flush so the next real glide gets its own transition
          slot.style.transition = '';
        });
      }, 150);
    });
  }

  // Advances one pet's motion state and reports whether a *new* glide just
  // started this call (so render() knows to (re)apply the CSS transition),
  // plus the target x and facing direction to render with either way.
  function tickMotion(petKey) {
    const m = ensureMotion(petKey);
    const now = Date.now();
    let justStarted = false;
    if (m.walking) {
      if (now >= m.moveEndsAt) {
        m.walking = false;
        m.stationaryUntil = now + MIN_STATIONARY_MS + Math.random() * (MAX_STATIONARY_MS - MIN_STATIONARY_MS);
      }
    } else if (now >= m.stationaryUntil) {
      startNewMove(petKey);
      justStarted = true;
    }
    return { x: m.x, walking: m.walking, moveDuration: m.moveDuration, facing: m.facing, justStarted };
  }

  // Two states, not three: working (an AFK block is currently active, or an
  // action grant just happened in the last POST_ACTION_FLOURISH_MS) or
  // hidden entirely otherwise — no more desaturated "resting" state. Split
  // into two checks rather than one combined bool because they interact
  // with walking differently — see renderSprite's prop block below.
  function isAfkBlockWorking(pet) {
    return !!pet.activeAfkBlock;
  }
  function isActionFlourishing(pet) {
    const lastGrant = pet.lastActionGrantAt;
    if (lastGrant && typeof lastGrant.toMillis === 'function') {
      return (Date.now() - lastGrant.toMillis()) < POST_ACTION_FLOURISH_MS;
    }
    return false;
  }

  // Stops a glide in progress the moment its flourish starts, so the pet
  // visibly plants itself to "show off" the tool instead of the flourish
  // just riding along on top of an already-smooth walk. Same
  // freeze-in-place technique addResizeClampListener already uses: read
  // the CSS transition's current live position via getComputedStyle (the
  // browser keeps this up to date mid-transition), then cancel the
  // transition and pin `left` to exactly that point so nothing visibly
  // jumps. Guarded by lastFlourishInterruptAt so this only fires once per
  // grant, not on every idle-frame re-render for the whole flourish
  // window — without that guard the repeated snap-in-place would fight the
  // pet's *next* legitimate glide if one started before the window ends
  // (it can't in practice, since the post-interrupt stationaryUntil is
  // always well beyond the flourish's own duration, but the guard is what
  // makes that true rather than accidental).
  function interruptGlideForFlourish(petKey, pet, slot, motion) {
    if (!motion.walking || !isActionFlourishing(pet)) return;
    const grantMs = pet.lastActionGrantAt.toMillis();
    const m = motionState[petKey];
    if (!m || m.lastFlourishInterruptAt === grantMs) return;
    m.lastFlourishInterruptAt = grantMs;

    const currentLeft = parseFloat(getComputedStyle(slot).left);
    const snappedLeft = isNaN(currentLeft) ? m.x : currentLeft;
    slot.style.transition = 'none';
    slot.style.left = snappedLeft + 'px';
    void slot.offsetWidth; // flush so the next real glide gets its own transition
    slot.style.transition = '';

    m.x = snappedLeft;
    m.walking = false;
    m.moveDuration = 0;
    m.stationaryUntil = Date.now() + MIN_STATIONARY_MS + Math.random() * (MAX_STATIONARY_MS - MIN_STATIONARY_MS);
    // Reflected into this render's own `motion` snapshot too, not just the
    // persistent motionState, so the caller's subsequent justStarted check
    // and renderSprite() call both see the interrupted state immediately.
    motion.walking = false;
    motion.justStarted = false;
    motion.x = snappedLeft;
  }

  function renderSprite(container, pet, frame, isWalking) {
    const stage = pet.__stage;
    const skinColor = pet.skinColor || '#5B7B9A';
    const bodySrc = assetUrl('pet-body-' + stage.key + '-' + frame + '.png');

    const bobPct = frame === 2 ? (stage.headBob / 64 * 100) : 0;

    let hatHtml = '';
    const hat = resolveHat(pet.equippedHat);
    if (hat) {
      const anchor = hat.anchor;
      const txPct = (stage.head.x - anchor.x) / 64 * 100;
      const tyPct = (stage.head.y - anchor.y) / 64 * 100 + bobPct;
      let trimHtml, shimmerHtml = '';
      if (hat.shimmer === 'completionist') {
        // Was a hard jump-cut every 1.5s (Math.floor(Date.now()/1500)%6
        // picking a single discrete tint) — now crossfades continuously
        // through CYCLE_COLORS via buildCyclingLayers instead. Uses the
        // same shared CYCLE_COLORS (and the same wall-clock phase) as the
        // rainbow skin, so a pet with both equipped always shows matching
        // colors at matching instants, not just matching cadence.
        trimHtml = buildCyclingLayers(hat.trim, CYCLE_COLORS);
        // The thin shimmer streak stays a flat CSS background-color (can't
        // crossfade pixel-by-pixel like the trim above), so it's just a
        // constant soft white highlight rather than trying to track the
        // cycling hue — a secondary highlight, not the primary color read.
        shimmerHtml = `<div class="mascot-tint-rect" style="-webkit-mask-image:url('${hat.trim}');mask-image:url('${hat.trim}');overflow:hidden;">
          <div class="mascot-shimmer-bar" style="background:rgba(255,255,255,0.85);animation-delay:${phaseDelay(2600)};"></div>
        </div>`;
      } else {
        let tintColor;
        if (hat.shimmer === 'max') {
          const pal = paletteAt(4); // dedicated max-tier color (Amethyst)
          tintColor = pal.edge;
          shimmerHtml = `<div class="mascot-tint-rect" style="-webkit-mask-image:url('${hat.trim}');mask-image:url('${hat.trim}');overflow:hidden;">
            <div class="mascot-shimmer-bar" style="background:${pal.shimmer};animation-delay:${phaseDelay(2600)};"></div>
          </div>`;
        } else {
          const pal = paletteAt(hat.tierIndex || 0);
          tintColor = pal.edge;
        }
        const trimTinted = getTintedImage(hat.trim, tintColor) || hat.trim;
        trimHtml = `<img src="${trimTinted}" style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;" />`;
      }
      hatHtml = `
        <div style="position:absolute;inset:0;transform:translate(${txPct}%, ${tyPct}%);">
          <img src="${hat.base}" style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;" />
          ${trimHtml}
          ${shimmerHtml}
        </div>`;
    }

    // Hidden entirely unless actively working. The two working reasons
    // interact with walking differently: an AFK block is a sustained,
    // ambient state, so it still hides during a walk (a held tool doesn't
    // make sense mid-stride) — but the post-action flourish is a brief,
    // time-critical cue tied to a specific moment, same as the floating
    // "+XP" popup (which isn't gated on walking at all). Suppressing it
    // just because the pet happened to be walking at that instant meant it
    // could get lost entirely: the walk can easily outlast the flourish's
    // own fixed window, so by the time walking stops there's nothing left
    // to show.
    let propHtml = '';
    const working = isActionFlourishing(pet) || (isAfkBlockWorking(pet) && !isWalking);
    if (pet.activeSkill && working) {
      const propAnchor = PROP_ANCHORS[pet.activeSkill];
      const propSrc = assetUrl('prop-' + pet.activeSkill + '.png');
      const txPct = (stage.hand.x - propAnchor.x) / 64 * 100;
      const tyPct = (stage.hand.y - propAnchor.y) / 64 * 100;
      propHtml = `
        <img class="mascot-prop mascot-working" src="${propSrc}"
          style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;--mascot-prop-tx:${txPct}%;--mascot-prop-ty:${tyPct}%;transform:translate(${txPct}%, ${tyPct}%);animation-delay:${phaseDelay(1100)};" />`;
    }

    const skinFlair = skinFlairFor(skinColor);
    // Uncommon-tier ("pulse") colors get the same brightness-pulse the
    // picker swatch uses, applied directly to the body image — previously
    // this flair only showed up in the picker preview, never on the
    // actually-equipped pet.
    const bodyPulseClass = skinFlair === 'pulse' ? ' mascot-body-pulse' : '';
    const bodyPulseDelay = skinFlair === 'pulse' ? `animation-delay:${phaseDelay(2200)};` : '';
    const bodyHtml = skinColor === RAINBOW_SKIN
      ? buildCyclingLayers(bodySrc, CYCLE_COLORS)
      : `<img class="${bodyPulseClass}" src="${getTintedImage(bodySrc, skinColor) || bodySrc}" style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;${bodyPulseDelay}" />`;
    // Rare-tier ("shimmer") and rainbow skin colors get the same
    // shimmer-bar highlight the completionist/max hats already use —
    // previously this flair only showed up on the picker's swatch preview,
    // never on the actually-equipped body, since the two used entirely
    // separate rendering paths. Masked to bodySrc's own alpha channel, same
    // mask-image + overflow:hidden clipping the hat version uses.
    const bodyShimmerHtml = (skinFlair === 'shimmer' || skinFlair === 'rainbow')
      ? `<div class="mascot-tint-rect" style="-webkit-mask-image:url('${bodySrc}');mask-image:url('${bodySrc}');overflow:hidden;">
          <div class="mascot-shimmer-bar" style="background:rgba(255,255,255,0.85);animation-delay:${phaseDelay(2600)};"></div>
        </div>`
      : '';
    container.innerHTML = `
      ${propHtml}
      ${bodyHtml}
      ${bodyShimmerHtml}
      ${hatHtml}
    `;
  }

  // ---------------------------------------------------------------------
  // Widget state + main render loop
  // ---------------------------------------------------------------------
  const widgetState = {
    mascotDoc: null,        // latest household/mascot-state data
    counts: null,           // latest achievements-state.counts
    myPetKey: null,
    expandedPet: null,      // null | 'userA' | 'userB'
    expandedSkill: null,    // null | skill name (Level 2)
    customizeOpen: false,   // whether the hat/skin-color pickers are expanded
    helpOpen: false,        // whether the "?" quick-help note is expanded
    frame: 1,
    prevSkillXP: null,      // last-seen { userA: {skill: hours, ...}, userB: {...} }, for XP-popup diffing
    seededXP: false,        // true once prevSkillXP holds a real first snapshot (skips popping on that first one)
    prevLiveTotal: null,    // last-seen achievements-state total, for the AFK-bank popup diffing
    seededLiveTotal: false  // true once prevLiveTotal holds a real first snapshot
  };

  function computeDerivedPets() {
    const data = widgetState.mascotDoc || {};
    const liveTotal = sumCounts(widgetState.counts || {});
    const monthKey = currentMonthKey();
    const baselineTotal = data.monthKey === monthKey ? (data.baselineTotal || 0) : liveTotal;
    const monthProgress = Math.max(0, liveTotal - baselineTotal);
    const stage = stageForProgress(monthProgress);

    const pets = {};
    PET_KEYS.forEach((key) => {
      const raw = (data.pets && data.pets[key]) || defaultPet(key);
      const pet = Object.assign(defaultPet(key), raw);
      pet.__stage = stage;
      pet.__tokens = computeTokens(pet, liveTotal);
      pets[key] = pet;
    });
    return { pets, stage, liveTotal, monthProgress };
  }

  function labelForPet(petKey) {
    if (petKey === widgetState.myPetKey && typeof window.getHouseholdUserLabel === 'function') {
      const l = window.getHouseholdUserLabel();
      if (l) return l;
    }
    return FALLBACK_LABELS[petKey] || petKey;
  }

  function render() {
    const root = ensureDom();
    if (!widgetState.mascotDoc && !widgetState.counts) return; // nothing to show yet
    root.classList.remove('mascot-hidden');
    applyGroundTexture();

    const { pets } = computeDerivedPets();
    const ground = document.getElementById('mascot-ground');
    // Slots are created once and reused across renders (not torn down every
    // idle-frame tick like the sprite contents still are) — repositioning
    // relies on a real CSS transition on `left`, which only animates
    // smoothly between an existing element's old and new value. A freshly
    // recreated element has no "old value" to transition from, so it would
    // just snap instead of gliding.
    PET_KEYS.forEach((key) => {
      const pet = pets[key];
      const motion = tickMotion(key);
      let slot = document.getElementById('mascot-slot-' + key);
      if (!slot) {
        slot = document.createElement('button');
        slot.id = 'mascot-slot-' + key;
        slot.className = 'mascot-slot';
        slot.type = 'button';
        slot.style.left = motion.x + 'px';
        slot.innerHTML = `<div class="mascot-sprite-box" id="mascot-sprite-${key}"></div><span class="mascot-slot-name">${labelForPet(key)}</span>`;
        slot.addEventListener('click', () => {
          widgetState.expandedPet = widgetState.expandedPet === key ? null : key;
          widgetState.expandedSkill = null;
          widgetState.customizeOpen = false;
          render();
        });
        ground.appendChild(slot);
      }
      interruptGlideForFlourish(key, pet, slot, motion);
      // Only (re)apply the transition + target when a new glide actually
      // started this tick — touching `left` again mid-glide with the same
      // value is harmless, but setting `transition` again would restart it.
      if (motion.justStarted) {
        // linear — constant speed for the whole glide, no easing in/out.
        slot.style.transition = 'left ' + (motion.moveDuration / 1000) + 's linear';
        slot.style.left = motion.x + 'px';
      }
      const spriteBox = slot.querySelector('.mascot-sprite-box');
      // Mirrors the whole layered sprite (hat+body+prop together) so
      // attachment points stay correctly aligned post-flip, rather than
      // just flipping the body and leaving the hat/prop in their
      // original-facing spots. Source art faces left by default, so it's
      // moving *right* that needs the flip, not left.
      spriteBox.style.transform = motion.facing === 'right' ? 'scaleX(-1)' : 'scaleX(1)';
      renderSprite(spriteBox, pet, widgetState.frame, motion.walking);
    });

    renderPanel(pets);
  }

  function renderPanel(pets) {
    const panel = document.getElementById('mascot-panel');
    if (!widgetState.expandedPet) {
      panel.classList.remove('mascot-open');
      panel.innerHTML = '';
      return;
    }
    panel.classList.add('mascot-open');
    const petKey = widgetState.expandedPet;
    const pet = pets[petKey];
    const isOwn = petKey === widgetState.myPetKey;

    if (!widgetState.expandedSkill) {
      // Level 1: skill pills + tokens + (own pet only) AFK-block purchase +
      // hat/skin controls.
      const pillsHtml = SKILLS.map((skill) => {
        const level = levelForXP(pet.skillXP[skill] || 0);
        return `<div class="mascot-pill" data-skill="${skill}">
          <span class="mascot-pill-icon">${SKILL_EMOJI[skill]}</span>
          <span>${level}</span>
        </div>`;
      }).join('');

      let ownControlsHtml = '';
      if (isOwn) {
        let afkHtml = '';
        if (pet.activeAfkBlock) {
          afkHtml = `<div class="mascot-afk-active">⏳ AFK block active — ${afkBlockRemainingLabel(pet.activeAfkBlock)} left</div>`;
        } else {
          const blockButtons = TOKEN_BLOCKS.map((b, i) => {
            const afford = pet.__tokens >= b.price;
            return `<button class="mascot-afk-btn" data-block="${i}" ${afford ? '' : 'disabled'}>${b.hours}h — ${b.price}${TOKEN_ICON}</button>`;
          }).join('');
          afkHtml = `<div class="mascot-xp-line">Buy AFK time (tool works on its own for a while):</div><div class="mascot-afk-row">${blockButtons}</div>`;
        }

        const customizeOpen = !!widgetState.customizeOpen;
        let customizeBody = '';
        if (customizeOpen) {
          const unlocked = unlockedHatsForPet(pet);
          const equipped = pet.equippedHat || '';
          const hatButtons = [`<button class="mascot-hat-btn${equipped === '' ? ' mascot-hat-equipped' : ''}" data-hat="">None</button>`]
            .concat(unlocked.map((h) => `<button class="mascot-hat-btn${equipped === h.id ? ' mascot-hat-equipped' : ''}" data-hat="${h.id}">${hatLabel(h)}</button>`))
            .join('');
          const freeSwatchesHtml = SWATCH_COLORS.map((c) => `<div class="mascot-swatch${pet.skinColor === c ? ' mascot-swatch-active' : ''}" data-color="${c}" style="background:${c};"></div>`).join('');
          const ownedPremium = pet.purchasedSkinColors || [];
          // Group premium swatches by tier (Common/Uncommon/Rare) — the
          // array is already ordered by tier, so a simple running-group
          // reduce keeps each tier's own price + flair together for display
          // rather than one flat "Premium" row.
          const tierGroups = [];
          PREMIUM_SWATCHES.forEach((s) => {
            let group = tierGroups[tierGroups.length - 1];
            if (!group || group.label !== s.tierLabel) {
              group = { label: s.tierLabel, price: s.price, items: [] };
              tierGroups.push(group);
            }
            group.items.push(s);
          });
          const premiumTiersHtml = tierGroups.map((g) => {
            const swatchesHtml = g.items.map((s) => {
              const isRainbow = s.color === RAINBOW_SKIN;
              // 'rainbow' gets both its own gradient class *and* the
              // shimmer sweep (it's the peak-tier option — previously it
              // only got the gradient, with no shimmer at all, since this
              // mapped flair name straight to a single class name).
              const hasShimmerSweep = s.flair === 'shimmer' || isRainbow;
              const flairClass = (s.flair === 'pulse' ? ' mascot-swatch-pulse' : '') + (isRainbow ? ' mascot-swatch-rainbow' : '');
              // The picker rebuilds this markup on every render (each idle
              // tick, ~650ms, plus any customize-panel toggle) — a plain
              // `animation:` with no delay restarts from 0% every time,
              // which reads as a stutter/reset instead of a continuous
              // loop. Same negative-delay/phaseDelay() continuity trick
              // used everywhere else in the file for elements that get
              // torn down and recreated this often.
              const pulseStyle = s.flair === 'pulse' ? ` animation-delay:${phaseDelay(2200)};` : '';
              const sweepHtml = hasShimmerSweep ? `<div class="mascot-swatch-shimmer-sweep" style="animation-delay:${phaseDelay(1800)};"></div>` : '';
              const bgStyle = isRainbow ? '' : `background:${s.color};`;
              if (ownedPremium.indexOf(s.color) !== -1) {
                return `<div class="mascot-swatch${flairClass}${pet.skinColor === s.color ? ' mascot-swatch-active' : ''}" data-color="${s.color}" style="${bgStyle}${pulseStyle}">${sweepHtml}</div>`;
              }
              const afford = pet.__tokens >= s.price;
              return `<div class="mascot-swatch mascot-swatch-locked${flairClass}" data-buy-color="${s.color}" data-buy-price="${s.price}" style="${bgStyle}opacity:${afford ? '0.85' : '0.35'};${pulseStyle}" title="${s.price} tokens">${sweepHtml}${s.price}</div>`;
            }).join('');
            return `<div class="mascot-xp-line" style="margin-top:6px;">${g.label} (${g.price}${TOKEN_ICON}):</div><div class="mascot-swatch-row">${swatchesHtml}</div>`;
          }).join('');
          customizeBody = `
            <div style="margin-top:8px;">
              <div class="mascot-xp-line">Hats earned so far — tap to equip:</div>
              <div class="mascot-hat-list">${hatButtons}</div>
              <div class="mascot-xp-line" style="margin-top:8px;">Skin color:</div>
              <div class="mascot-swatch-row">${freeSwatchesHtml}</div>
              ${premiumTiersHtml}
            </div>`;
        }
        ownControlsHtml = `
          <div style="margin-top:10px;">
            ${afkHtml}
          </div>
          <div style="margin-top:10px;">
            <div class="mascot-pill mascot-customize-toggle" id="mascot-customize-toggle">
              <span>🎨 Customize${customizeOpen ? ' ▲' : ' ▼'}</span>
            </div>
            ${customizeBody}
          </div>`;
      }

      const helpOpen = !!widgetState.helpOpen;
      const helpNoteHtml = helpOpen ? `
        <div class="mascot-help-note">
          <ul>
            <li>Checking off tasks anywhere on the site feeds your pet's active skill — pick which one trains in the row below.</li>
            <li>Every tracked action also earns ${TOKEN_ICON} tokens, spendable on AFK time (the tool works on its own for a while) or new skin colors.</li>
            <li>Hats unlock automatically as a skill levels up — tap one to equip it.</li>
          </ul>
        </div>` : '';

      panel.innerHTML = `
        <div class="mascot-close-row">
          <button class="mascot-help-toggle" type="button" id="mascot-help-toggle" aria-label="${helpOpen ? 'Hide' : 'Show'} pet help">${helpOpen ? '×' : '?'}</button>
          <button class="mascot-close-btn" id="mascot-close-btn">✕</button>
        </div>
        <h4>${labelForPet(petKey)}'s pet — ${pet.__stage.label}</h4>
        ${helpNoteHtml}
        <div class="mascot-bank-line">${TOKEN_ICON} ${Math.floor(pet.__tokens).toLocaleString()} tokens</div>
        <div class="mascot-pill-row">${pillsHtml}</div>
        ${ownControlsHtml}
      `;
      document.getElementById('mascot-close-btn').addEventListener('click', () => { widgetState.expandedPet = null; render(); });
      document.getElementById('mascot-help-toggle').addEventListener('click', () => { widgetState.helpOpen = !widgetState.helpOpen; render(); });
      panel.querySelectorAll('.mascot-pill:not(.mascot-customize-toggle)').forEach((el) => {
        el.addEventListener('click', () => { widgetState.expandedSkill = el.getAttribute('data-skill'); render(); });
      });
      if (isOwn) {
        const toggle = document.getElementById('mascot-customize-toggle');
        if (toggle) toggle.addEventListener('click', () => { widgetState.customizeOpen = !widgetState.customizeOpen; render(); });
        panel.querySelectorAll('.mascot-hat-btn').forEach((el) => {
          el.addEventListener('click', () => { setEquippedHat(petKey, el.getAttribute('data-hat') || null); });
        });
        panel.querySelectorAll('.mascot-swatch[data-color]').forEach((el) => {
          el.addEventListener('click', () => { setSkinColor(petKey, el.getAttribute('data-color')); });
        });
        panel.querySelectorAll('.mascot-swatch-locked').forEach((el) => {
          el.addEventListener('click', () => {
            const color = el.getAttribute('data-buy-color');
            const price = parseInt(el.getAttribute('data-buy-price'), 10);
            if (pet.__tokens >= price) purchaseSkinColor(petKey, color, price);
          });
        });
        panel.querySelectorAll('.mascot-afk-btn').forEach((el) => {
          el.addEventListener('click', () => {
            const idx = parseInt(el.getAttribute('data-block'), 10);
            purchaseAfkBlock(petKey, idx);
          });
        });
      }
    } else {
      // Level 2: skill detail, own-pet-only "train this skill" control.
      const skill = widgetState.expandedSkill;
      const xp = pet.skillXP[skill] || 0;
      const level = levelForXP(xp);
      const nextLevelXP = level < 99 ? xpForLevel(level + 1) : null;
      const currentXP = Math.round(xp);
      const xpToNext = nextLevelXP !== null ? Math.round(nextLevelXP - xp) : null;
      const isActive = pet.activeSkill === skill;

      let trainHtml = '';
      if (isOwn) {
        trainHtml = `<button class="mascot-train-btn" id="mascot-train-btn" ${isActive ? 'disabled' : ''}>${isActive ? 'Currently training' : 'Train this skill'}</button>`;
      }

      panel.innerHTML = `
        <div class="mascot-close-row"><button class="mascot-close-btn" id="mascot-close-btn">✕</button></div>
        <button class="mascot-back-btn" id="mascot-back-btn">‹ Back to skills</button>
        <div class="mascot-skill-detail">
          <h4>${SKILL_EMOJI[skill]} ${SKILL_LABELS[skill]} — Level ${level}</h4>
          <div class="mascot-xp-line">${currentXP.toLocaleString()} XP${xpToNext !== null ? ` — ${xpToNext.toLocaleString()} XP to level ${level + 1}` : ' — maxed at level 99'}</div>
          ${trainHtml}
        </div>
      `;
      document.getElementById('mascot-close-btn').addEventListener('click', () => { widgetState.expandedPet = null; widgetState.expandedSkill = null; render(); });
      document.getElementById('mascot-back-btn').addEventListener('click', () => { widgetState.expandedSkill = null; render(); });
      if (isOwn) {
        const btn = document.getElementById('mascot-train-btn');
        if (btn) btn.addEventListener('click', () => { setActiveSkill(petKey, skill); });
      }
    }
  }

  // Diffs the shared household completion total (achievements-state) to pop
  // a single "+N 🪙" popup whenever it goes up — this total feeds both
  // pets' token balances equally (tokens = liveTotal - tokensBaseline -
  // tokensSpent per pet, and a liveTotal increase raises that identically
  // regardless of each pet's own baseline/spent), so a completed task
  // anywhere in the household shows once over the whole widget rather than
  // once per pet.
  function popTokensForCountsDiff(counts) {
    const liveTotal = sumCounts(counts || {});
    if (widgetState.seededLiveTotal) {
      const delta = liveTotal - (widgetState.prevLiveTotal || 0);
      if (delta > 0) showTokenPopup(delta);
    } else {
      widgetState.seededLiveTotal = true;
    }
    widgetState.prevLiveTotal = liveTotal;
  }

  // Diffs incoming skillXP (raw XP, granted per-action — see runVisitGrant)
  // against the last-seen snapshot to pop an XP popup — same "compare
  // consecutive snapshots client-side" pattern achievements.html already
  // uses for its milestone celebration banner, so this fires for either pet
  // regardless of which device actually earned the grant, not just the
  // locally-triggered visit-grant on this page load.
  function popXpForSnapshotDiff(mascotData) {
    const pets = mascotData.pets || {};
    const nextSnapshot = {};
    PET_KEYS.forEach((petKey) => {
      const skillXP = (pets[petKey] && pets[petKey].skillXP) || {};
      nextSnapshot[petKey] = {};
      SKILLS.forEach((skill) => { nextSnapshot[petKey][skill] = skillXP[skill] || 0; });
    });

    if (widgetState.seededXP) {
      const prev = widgetState.prevSkillXP || {};
      PET_KEYS.forEach((petKey) => {
        // Popped per-skill (rather than summed across all three) so the
        // popup can show the right emoji — in practice only the pet's
        // active skill ever changes at once, but this stays correct even
        // if that were ever not true.
        SKILLS.forEach((skill) => {
          const before = (prev[petKey] && prev[petKey][skill]) || 0;
          const after = nextSnapshot[petKey][skill];
          if (after <= before) return;
          const deltaXP = after - before;
          if (deltaXP >= 1) showXpPopup(petKey, skill, deltaXP);
        });
      });
    } else {
      widgetState.seededXP = true;
    }
    widgetState.prevSkillXP = nextSnapshot;
  }

  function hatLabel(h) {
    if (h.kind === 'completionist') return 'Completionist';
    if (h.kind === 'max') return SKILL_EMOJI[h.skill] + ' (Master)';
    return SKILL_EMOJI[h.skill] + ' ' + h.tier;
  }

  // "Xh Ym left" for an active AFK block's remaining wall-clock duration.
  function afkBlockRemainingLabel(block) {
    const startedAtMs = block.startedAt && typeof block.startedAt.toMillis === 'function' ? block.startedAt.toMillis() : Date.now();
    const elapsedHours = Math.max(0, (Date.now() - startedAtMs) / 3600000);
    const remainingHours = Math.max(0, block.hours - elapsedHours);
    const h = Math.floor(remainingHours);
    const m = Math.round((remainingHours - h) * 60);
    if (h <= 0 && m <= 0) return 'finishing up';
    return (h > 0 ? h + 'h ' : '') + m + 'm';
  }

  // ---------------------------------------------------------------------
  // Entry point
  // ---------------------------------------------------------------------
  window.initMascotWidget = function () {
    try {
      const user = window.currentHouseholdUser;
      const email = user && user.email ? user.email.toLowerCase() : '';
      widgetState.myPetKey = EMAIL_TO_PET_KEY[email] || null;

      precomputeHatTints();
      addResizeClampListener();

      // Reacts to the theme actually changing (toggle click, or theme.js's
      // async cross-device correction) instead of waiting for whatever
      // render() happens to run next (idle-frame tick, live data update,
      // etc.) — that gap was the visible "delay" swapping ground layers.
      // Wraps rather than overwrites window.onThemeChange, since that's a
      // single global hook some pages (home.html) already use for their
      // own dark-mode icon refresh — this must not clobber that.
      const previousOnThemeChange = window.onThemeChange;
      window.onThemeChange = function (theme) {
        if (typeof previousOnThemeChange === 'function') previousOnThemeChange(theme);
        applyGroundTexture();
      };

      // Live subscriptions — both pets' cosmetics/levels stay in sync across
      // devices, and life stage updates in real time as anyone completes tasks.
      firebase.firestore().collection('household').doc('mascot-state').onSnapshot((snap) => {
        widgetState.mascotDoc = snap.exists ? snap.data() : {};
        popXpForSnapshotDiff(widgetState.mascotDoc);
        render();
      }, (e) => console.error('Mascot state subscription failed', e));

      // Subscribes directly rather than going through achievements.js's
      // window.subscribeAchievementCounts — that global only exists on pages
      // that load achievements.js, which achievements.html itself doesn't
      // (it reads/renders household/achievements-state inline instead of
      // through that shared writer-side helper). Depending on it left the
      // mascot widget's life stage and AFK-bank popups frozen on that one
      // page, since widgetState.counts never got set there. mascot.js
      // already reads this same doc directly elsewhere (see achievementsRef,
      // used by the AFK/XP grant transaction above), so doing the live
      // subscription the same way keeps the widget fully self-contained
      // instead of depending on another script happening to be present.
      achievementsRef().onSnapshot((snap) => {
        const counts = (snap.exists ? snap.data() : {}).counts || {};
        popTokensForCountsDiff(counts);
        widgetState.counts = counts;
        render();
        // The grant transaction runs on every live update to this doc, not
        // just once at page load — diffing against lastGrantedCounts is
        // idempotent, so re-running it here (in addition to the implicit
        // first fire this subscription already gives on page load) is what
        // makes tiered skill XP (and the post-action prop flourish) show up
        // in near-real-time while the page stays open, not just next visit.
        if (widgetState.myPetKey) runVisitGrant(widgetState.myPetKey);
      }, (e) => console.error('Mascot achievement-counts subscription failed', e));

      // 2-frame idle animation, body only.
      setInterval(() => {
        widgetState.frame = widgetState.frame === 1 ? 2 : 1;
        render();
      }, 650);

      // Completionist hat's shimmer cycles through the full palette
      // continuously — re-render periodically so its color keeps advancing
      // even when nothing else about the pet's state changes.
      setInterval(() => {
        const anyCompletionist = document.querySelector('.mascot-shimmer-bar');
        if (anyCompletionist) render();
      }, 1500);
    } catch (e) {
      console.error('Mascot widget init failed', e);
    }
  };
})();
