// Household mascot widget — a persistent pixel-art pet per household member,
// living at the bottom of every page the same way priority-alert.js lives at
// the top. Fully self-contained: injects its own <style> and DOM, no page
// markup changes needed. See pet-assets/petDesign_notes.md for the full
// design spec this file implements.
//
// Two independent progression axes, both pure derivations off the same
// household/achievements-state.counts total that already powers the Star
// Board:
//   1. Life stage (Fresh/In-Training/Rookie/Champion) — shared by both pets,
//      resets monthly, driven by completions since the start of the month.
//   2. Skill levels (woodcutting/gardening/fishing) — permanent, independent
//      per pet, driven by an idle/AFK-hour bank that fills 1:1 with the
//      household's lifetime completion total and drains into XP on every
//      page load based on real elapsed time since the pet's last visit.
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
  const DEFAULT_SKIN_COLORS = { userA: '#8FB4D6', userB: '#E68A8F' };
  const SWATCH_COLORS = ['#8FB4D6', '#E68A8F', '#A6C79A', '#F0C25A', '#BF9FD6', '#8A93A0', '#D98C4A', '#6B8E8E'];

  const DAILY_CAP_HOURS = 15;
  const HAT_TIER_LEVELS = [25, 50, 75, 90]; // standard-hat unlock tiers (99 = bespoke max hat, handled separately)

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
  const ASSET_VERSION = 'v=3';
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
  // rescaled so level 99 = 1000 AFK hours. XP is stored/measured directly
  // in AFK hours (1 banked hour granted = 1 XP), per the design doc.
  // ---------------------------------------------------------------------
  function rsRawXP(level, divisor) {
    let total = 0;
    for (let n = 1; n < level; n++) {
      total += Math.floor(n + 300 * Math.pow(2, n / divisor));
    }
    return Math.floor(total / 4);
  }
  const RAW_99 = rsRawXP(99, 10);
  const XP_SCALE = 1000 / RAW_99;
  // Cumulative hours required to *reach* level L, for L = 1..99 (index 0 unused).
  const LEVEL_HOURS = [0];
  for (let L = 1; L <= 99; L++) LEVEL_HOURS[L] = rsRawXP(L, 10) * XP_SCALE;

  function levelForHours(hours) {
    let lvl = 1;
    for (let L = 1; L <= 99; L++) {
      if (hours >= LEVEL_HOURS[L]) lvl = L; else break;
    }
    return lvl;
  }
  function hoursForLevel(level) { return LEVEL_HOURS[Math.max(1, Math.min(99, level))]; }

  // Display-only XP unit, separate from the hours the level curve above is
  // actually computed in. Banked hours (and the level thresholds, grant
  // math, daily cap) stay exactly as they are — this is purely a cosmetic
  // multiplier so on-screen numbers ("+230 XP") read like a game currency
  // instead of literally showing hour counts.
  const DISPLAY_XP_SCALE = 1000;
  function xpForHours(hours) { return hours * DISPLAY_XP_SCALE; }

  // ---------------------------------------------------------------------
  // Small date/month helpers — same lazy first-writer-wins rollover pattern
  // used elsewhere on the site (Tending Today's weekly reset, the Star
  // Board's milestone stamping).
  // ---------------------------------------------------------------------
  function todayDateStr() {
    const d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
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
      hoursAlreadyGranted: 0,
      dailyGrantKey: todayDateStr(),
      dailyGrantedSoFar: 0,
      lastVisitAt: null,
      activeSkill: 'woodcutting',
      skillXP: { woodcutting: 0, gardening: 0, fishing: 0 },
      equippedHat: null,
      skinColor: DEFAULT_SKIN_COLORS[petKey] || '#8FB4D6'
    };
  }

  // ---------------------------------------------------------------------
  // Firestore
  // ---------------------------------------------------------------------
  function mascotRef() { return firebase.firestore().collection('household').doc('mascot-state'); }
  function achievementsRef() { return firebase.firestore().collection('household').doc('achievements-state'); }

  // Fires once per page load, for the current signed-in user's own pet only
  // — the AFK bank/XP grant math. Reads both achievements-state (for
  // liveTotal) and mascot-state inside one transaction so the life-stage
  // rollover and the grant math see a consistent snapshot.
  async function runVisitGrant(petKey) {
    try {
      await firebase.firestore().runTransaction(async (tx) => {
        const achSnap = await tx.get(achievementsRef());
        const mascotSnap = await tx.get(mascotRef());
        const achData = achSnap.exists ? achSnap.data() : {};
        const liveTotal = sumCounts(achData.counts || {});
        const mascotData = mascotSnap.exists ? mascotSnap.data() : {};

        // Life stage: lazy monthly rollover, first-writer-wins.
        const monthKey = currentMonthKey();
        let baselineTotal = typeof mascotData.baselineTotal === 'number' ? mascotData.baselineTotal : liveTotal;
        let mKey = mascotData.monthKey || monthKey;
        if (mKey !== monthKey) { mKey = monthKey; baselineTotal = liveTotal; }

        const pets = Object.assign({}, mascotData.pets || {});
        const isNewPet = !pets[petKey];
        const pet = Object.assign(defaultPet(petKey), pets[petKey] || {});
        // A brand-new pet's baseline must start at the current liveTotal, not
        // 0 — otherwise its very first grant would instantly bank the
        // household's entire pre-existing lifetime completion count as AFK
        // hours, instead of starting fresh at 0 and only accruing from
        // completions going forward (same baseline-snapshot idea life stage
        // already uses for monthProgress).
        if (isNewPet) pet.hoursAlreadyGranted = liveTotal;

        // AFK bank = liveTotal - hoursAlreadyGranted (derived, never stored directly).
        const hoursAlreadyGranted = pet.hoursAlreadyGranted || 0;
        const bankedHours = Math.max(0, liveTotal - hoursAlreadyGranted);

        // Daily grant cap — lazy rollover on its own date key.
        const dateStr = todayDateStr();
        let dailyGrantKey = pet.dailyGrantKey;
        let dailyGrantedSoFar = pet.dailyGrantedSoFar || 0;
        if (dailyGrantKey !== dateStr) { dailyGrantKey = dateStr; dailyGrantedSoFar = 0; }

        // Elapsed time since last visit, anchored on the server-set
        // timestamp (never the client's local clock).
        let elapsedHours = 0;
        if (pet.lastVisitAt && typeof pet.lastVisitAt.toMillis === 'function') {
          elapsedHours = Math.max(0, (Date.now() - pet.lastVisitAt.toMillis()) / 3600000);
        }
        const consumed = Math.min(elapsedHours, bankedHours);
        const grantable = Math.max(0, Math.min(consumed, DAILY_CAP_HOURS - dailyGrantedSoFar));
        dailyGrantedSoFar += grantable;
        // hoursAlreadyGranted advances by the FULL consumed amount (not just
        // grantable) so the capped excess is discarded, not banked forward.
        const newHoursAlreadyGranted = hoursAlreadyGranted + consumed;

        const activeSkill = SKILLS.includes(pet.activeSkill) ? pet.activeSkill : 'woodcutting';
        const skillXP = Object.assign({ woodcutting: 0, gardening: 0, fishing: 0 }, pet.skillXP || {});
        skillXP[activeSkill] = (skillXP[activeSkill] || 0) + grantable;

        pets[petKey] = Object.assign({}, pet, {
          hoursAlreadyGranted: newHoursAlreadyGranted,
          dailyGrantKey,
          dailyGrantedSoFar,
          lastVisitAt: firebase.firestore.FieldValue.serverTimestamp(),
          activeSkill,
          skillXP
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
    const field = 'pets.' + petKey + '.activeSkill';
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

  // ---------------------------------------------------------------------
  // Cosmetic unlocks — always computed live off current skill levels, never
  // persisted as an earned flag (skills only ever go up, so there's nothing
  // to re-derive incorrectly).
  // ---------------------------------------------------------------------
  function unlockedHatsForPet(pet) {
    const skillXP = pet.skillXP || {};
    const out = [];
    SKILLS.forEach((skill) => {
      const level = levelForHours(skillXP[skill] || 0);
      HAT_TIER_LEVELS.forEach((tier) => {
        if (level >= tier) out.push({ id: skill + '-' + tier, skill, tier, kind: 'standard' });
      });
      if (level >= 99) out.push({ id: skill + '-max', skill, tier: 99, kind: 'max' });
    });
    const allMaxed = SKILLS.every((skill) => levelForHours(skillXP[skill] || 0) >= 99);
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
      overflow: hidden;
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
    .mascot-prop.mascot-resting {
      filter: grayscale(1) brightness(0.85);
      opacity: 0.55;
      animation-play-state: paused !important;
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
    .mascot-close-row { display: flex; justify-content: flex-end; }
    .mascot-close-btn {
      background: none;
      border: none;
      color: var(--muted, #6B7568);
      font-size: 13px;
      cursor: pointer;
      padding: 2px 6px;
    }
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
      width: 18px; height: 18px; border-radius: 50%;
      border: 1.5px solid var(--line, #DDE3D6);
      cursor: pointer;
    }
    .mascot-swatch.mascot-swatch-active { border-color: var(--ink, #263029); border-width: 2px; }
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

  // Floats a single "+N hr" popup over the whole widget (not per-pet) when
  // the shared household completion total ticks up — since that total feeds
  // both pets' banked hours equally and identically, one popup for the
  // whole widget reads better than duplicating it over each sprite.
  function showAfkPopup(hours) {
    const ground = document.getElementById('mascot-ground');
    if (!ground) return;
    const rect = ground.getBoundingClientRect();
    const layer = ensureFxLayer();
    const el = document.createElement('div');
    el.className = 'mascot-xp-popup';
    el.textContent = '+' + hours.toLocaleString() + (hours === 1 ? ' hr' : ' hrs');
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
    for (let i = 0; i < 6; i++) getTintedImage(completionistTrimUrl, paletteAt(i).edge);
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

  function ensureMotion(petKey) {
    if (motionState[petKey]) return motionState[petKey];
    motionState[petKey] = {
      x: Math.random() * groundWalkableWidth(),
      walking: false,
      moveDuration: 0,
      moveEndsAt: 0,
      facing: 'right',
      // Stagger each pet's very first move so both don't set off in sync.
      stationaryUntil: Date.now() + 1000 + Math.random() * 4000
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
    let target = Math.random() * maxX;
    // Avoid picking a spot barely different from the current one, so every
    // move actually reads as "went somewhere" rather than a tiny shuffle.
    if (maxX > 0 && Math.abs(target - m.x) < maxX * 0.2) target = maxX - target;
    target = Math.max(0, Math.min(maxX, target));
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

  function renderSprite(container, pet, frame, bankedHours, isWalking) {
    const stage = pet.__stage;
    const skinColor = pet.skinColor || '#8FB4D6';
    const bodySrc = assetUrl('pet-body-' + stage.key + '-' + frame + '.png');

    const bobPct = frame === 2 ? (stage.headBob / 64 * 100) : 0;

    let hatHtml = '';
    const hat = resolveHat(pet.equippedHat);
    if (hat) {
      const anchor = hat.anchor;
      const txPct = (stage.head.x - anchor.x) / 64 * 100;
      const tyPct = (stage.head.y - anchor.y) / 64 * 100 + bobPct;
      let tintColor, shimmerHtml = '';
      if (hat.shimmer === 'completionist') {
        const idx = Math.floor(Date.now() / 1500) % 6;
        const pal = paletteAt(idx);
        tintColor = pal.edge;
        shimmerHtml = `<div class="mascot-tint-rect" style="-webkit-mask-image:url('${hat.trim}');mask-image:url('${hat.trim}');overflow:hidden;">
          <div class="mascot-shimmer-bar" style="background:${pal.shimmer};animation-delay:${phaseDelay(2600)};"></div>
        </div>`;
      } else if (hat.shimmer === 'max') {
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
      hatHtml = `
        <div style="position:absolute;inset:0;transform:translate(${txPct}%, ${tyPct}%);">
          <img src="${hat.base}" style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;" />
          <img src="${trimTinted}" style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;" />
          ${shimmerHtml}
        </div>`;
    }

    // Hidden outright while walking (rather than just dimmed/desaturated
    // like the "no banked hours" resting look) — a held tool doesn't make
    // sense mid-stride, and hiding it avoids implying a third visual state
    // on top of the existing working/resting distinction.
    let propHtml = '';
    if (pet.activeSkill && !isWalking) {
      const propAnchor = PROP_ANCHORS[pet.activeSkill];
      const propSrc = assetUrl('prop-' + pet.activeSkill + '.png');
      const txPct = (stage.hand.x - propAnchor.x) / 64 * 100;
      const tyPct = (stage.hand.y - propAnchor.y) / 64 * 100;
      const working = bankedHours > 0;
      propHtml = `
        <img class="mascot-prop ${working ? 'mascot-working' : 'mascot-resting'}" src="${propSrc}"
          style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;--mascot-prop-tx:${txPct}%;--mascot-prop-ty:${tyPct}%;transform:translate(${txPct}%, ${tyPct}%);animation-delay:${phaseDelay(1100)};" />`;
    }

    const bodyTinted = getTintedImage(bodySrc, skinColor) || bodySrc;
    container.innerHTML = `
      ${propHtml}
      <img src="${bodyTinted}" style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;" />
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
      pet.__bankedHours = Math.max(0, liveTotal - (pet.hoursAlreadyGranted || 0));
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
      renderSprite(spriteBox, pet, widgetState.frame, pet.__bankedHours, motion.walking);
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
      // Level 1: skill pills + banked hours + (own pet only) hat/skin controls.
      const pillsHtml = SKILLS.map((skill) => {
        const level = levelForHours(pet.skillXP[skill] || 0);
        return `<div class="mascot-pill" data-skill="${skill}">
          <span class="mascot-pill-icon">${SKILL_EMOJI[skill]}</span>
          <span>${level}</span>
        </div>`;
      }).join('');

      let ownControlsHtml = '';
      if (isOwn) {
        const customizeOpen = !!widgetState.customizeOpen;
        let customizeBody = '';
        if (customizeOpen) {
          const unlocked = unlockedHatsForPet(pet);
          const equipped = pet.equippedHat || '';
          const hatButtons = [`<button class="mascot-hat-btn${equipped === '' ? ' mascot-hat-equipped' : ''}" data-hat="">None</button>`]
            .concat(unlocked.map((h) => `<button class="mascot-hat-btn${equipped === h.id ? ' mascot-hat-equipped' : ''}" data-hat="${h.id}">${hatLabel(h)}</button>`))
            .join('');
          const swatchesHtml = SWATCH_COLORS.map((c) => `<div class="mascot-swatch${pet.skinColor === c ? ' mascot-swatch-active' : ''}" data-color="${c}" style="background:${c};"></div>`).join('');
          customizeBody = `
            <div style="margin-top:8px;">
              <div class="mascot-xp-line">Hats earned so far — tap to equip:</div>
              <div class="mascot-hat-list">${hatButtons}</div>
              <div class="mascot-xp-line" style="margin-top:8px;">Skin color:</div>
              <div class="mascot-swatch-row">${swatchesHtml}</div>
            </div>`;
        }
        ownControlsHtml = `
          <div style="margin-top:10px;">
            <div class="mascot-pill mascot-customize-toggle" id="mascot-customize-toggle">
              <span>🎨 Customize${customizeOpen ? ' ▲' : ' ▼'}</span>
            </div>
            ${customizeBody}
          </div>`;
      }

      panel.innerHTML = `
        <div class="mascot-close-row"><button class="mascot-close-btn" id="mascot-close-btn">✕</button></div>
        <h4>${labelForPet(petKey)}'s pet — ${pet.__stage.label}</h4>
        <div class="mascot-bank-line">Banked AFK hours: ${pet.__bankedHours.toFixed(1)} hr</div>
        <div class="mascot-pill-row">${pillsHtml}</div>
        ${ownControlsHtml}
      `;
      document.getElementById('mascot-close-btn').addEventListener('click', () => { widgetState.expandedPet = null; render(); });
      panel.querySelectorAll('.mascot-pill:not(.mascot-customize-toggle)').forEach((el) => {
        el.addEventListener('click', () => { widgetState.expandedSkill = el.getAttribute('data-skill'); render(); });
      });
      if (isOwn) {
        const toggle = document.getElementById('mascot-customize-toggle');
        if (toggle) toggle.addEventListener('click', () => { widgetState.customizeOpen = !widgetState.customizeOpen; render(); });
        panel.querySelectorAll('.mascot-hat-btn').forEach((el) => {
          el.addEventListener('click', () => { setEquippedHat(petKey, el.getAttribute('data-hat') || null); });
        });
        panel.querySelectorAll('.mascot-swatch').forEach((el) => {
          el.addEventListener('click', () => { setSkinColor(petKey, el.getAttribute('data-color')); });
        });
      }
    } else {
      // Level 2: skill detail, own-pet-only "train this skill" control.
      const skill = widgetState.expandedSkill;
      const hours = pet.skillXP[skill] || 0;
      const level = levelForHours(hours);
      const nextLevelHours = level < 99 ? hoursForLevel(level + 1) : null;
      const currentXP = Math.round(xpForHours(hours));
      const xpToNext = nextLevelHours !== null ? Math.round(xpForHours(nextLevelHours - hours)) : null;
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
  // a single "+N hr" popup whenever it goes up — this total feeds both
  // pets' banked hours equally (bankedHours = liveTotal - hoursAlreadyGranted
  // per pet), so a completed task anywhere in the household shows once over
  // the whole widget rather than once per pet.
  function popAfkForCountsDiff(counts) {
    const liveTotal = sumCounts(counts || {});
    if (widgetState.seededLiveTotal) {
      const delta = liveTotal - (widgetState.prevLiveTotal || 0);
      if (delta > 0) showAfkPopup(delta);
    } else {
      widgetState.seededLiveTotal = true;
    }
    widgetState.prevLiveTotal = liveTotal;
  }

  // Diffs incoming skillXP (in hours) against the last-seen snapshot to pop
  // an XP popup — same "compare consecutive snapshots client-side" pattern
  // achievements.html already uses for its milestone celebration banner, so
  // this fires for either pet regardless of which device actually earned
  // the grant, not just the locally-triggered visit-grant on this page load.
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
          const deltaXP = xpForHours(after - before);
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
    if (h.kind === 'max') return SKILL_LABELS[h.skill] + ' (Master)';
    return SKILL_LABELS[h.skill] + ' ' + h.tier;
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

      if (typeof window.subscribeAchievementCounts === 'function') {
        window.subscribeAchievementCounts((counts) => {
          popAfkForCountsDiff(counts);
          widgetState.counts = counts;
          render();
        });
      }

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

      // The AFK grant is a background side effect of this page load — fires
      // once for the signed-in user's own pet, independent of whether the
      // widget is ever tapped/expanded.
      if (widgetState.myPetKey) runVisitGrant(widgetState.myPetKey);
    } catch (e) {
      console.error('Mascot widget init failed', e);
    }
  };
})();
