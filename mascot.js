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
    { key: 'fresh', label: 'Fresh', min: 0, head: { x: 29, y: 46 }, hand: { x: 39, y: 52 }, headBob: -4 },
    { key: 'in-training', label: 'In-Training', min: 10, head: { x: 30, y: 34 }, hand: { x: 42, y: 46 }, headBob: 4 },
    { key: 'rookie', label: 'Rookie', min: 80, head: { x: 32, y: 26 }, hand: { x: 50, y: 40 }, headBob: 2 },
    { key: 'champion', label: 'Champion', min: 300, head: { x: 31, y: 8 }, hand: { x: 55, y: 28 }, headBob: -2 }
  ];

  // Attachment point *within* each hat/prop asset's own 64x64 canvas (where
  // that asset's own "grab point" sits) — eyeballed against the actual PNGs.
  // Standard and max-skill hats currently share the same registration point
  // per skill (see final report note: the shipped max-skill art is
  // pixel-identical to the standard hat art in this asset batch, so one
  // anchor covers both).
  const HAT_ANCHOR_STANDARD = { x: 31, y: 36 };
  const HAT_ANCHOR_COMPLETIONIST = { x: 31, y: 44 };
  const PROP_ANCHORS = {
    woodcutting: { x: 33, y: 46 },
    gardening: { x: 36, y: 54 },
    fishing: { x: 48, y: 48 }
  };

  const ASSET_BASE = 'pet-assets/';

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
        const pet = Object.assign(defaultPet(petKey), pets[petKey] || {});

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
        base: ASSET_BASE + 'hat-completionist-base.png',
        trim: ASSET_BASE + 'hat-completionist-trim.png',
        anchor: HAT_ANCHOR_COMPLETIONIST,
        shimmer: 'completionist'
      };
    }
    const maxMatch = /^(\w+)-max$/.exec(hatId);
    if (maxMatch) {
      const skill = maxMatch[1];
      return {
        base: ASSET_BASE + 'hat-' + skill + '-max-base.png',
        trim: ASSET_BASE + 'hat-' + skill + '-max-trim.png',
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
        base: ASSET_BASE + 'hat-' + skill + '-base.png',
        trim: ASSET_BASE + 'hat-' + skill + '-trim.png',
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
    #mascot-widget {
      position: fixed;
      left: 0;
      right: 0;
      bottom: 0;
      z-index: 9500;
      display: flex;
      flex-direction: column;
      align-items: stretch;
      font-family: 'Inter', -apple-system, sans-serif;
      pointer-events: none;
    }
    #mascot-widget.mascot-hidden { display: none; }
    #mascot-panel {
      pointer-events: auto;
      margin: 0 auto 4px auto;
      max-width: 360px;
      width: calc(100% - 24px);
      background: var(--card, #FFFFFF);
      border: 1px solid var(--line, #DDE3D6);
      border-radius: 14px;
      box-shadow: 0 6px 20px rgba(0,0,0,0.18);
      padding: 12px 14px;
      display: none;
      max-height: 46vh;
      overflow-y: auto;
      box-sizing: border-box;
    }
    #mascot-panel.mascot-open { display: block; }
    #mascot-bar {
      pointer-events: auto;
      display: flex;
      justify-content: center;
      gap: 18px;
      background: var(--card, #FFFFFF);
      border-top: 1px solid var(--line, #DDE3D6);
      padding: 8px 14px;
      box-shadow: 0 -2px 10px rgba(0,0,0,0.08);
    }
    .mascot-slot {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 2px;
      cursor: pointer;
      background: none;
      border: none;
      padding: 2px 6px;
      font-family: inherit;
    }
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
    .mascot-tint-rect {
      position: absolute;
      inset: 0;
      -webkit-mask-repeat: no-repeat;
      mask-repeat: no-repeat;
      -webkit-mask-size: 100% 100%;
      mask-size: 100% 100%;
    }
    .mascot-isolate { isolation: isolate; }
    .mascot-multiply { mix-blend-mode: multiply; }
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
    .mascot-pill img { width: 20px; height: 20px; image-rendering: pixelated; }
    .mascot-skill-detail { font-size: 13px; color: var(--ink, #263029); }
    .mascot-skill-detail .mascot-xp-line { color: var(--muted, #6B7568); font-size: 12px; margin: 4px 0 10px; }
    .mascot-train-btn, .mascot-hat-btn {
      background: var(--sage, #7C9075);
      color: #FFFFFF;
      border: none;
      border-radius: 8px;
      padding: 7px 12px;
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      margin: 3px 4px 3px 0;
    }
    .mascot-train-btn[disabled] { opacity: 0.5; cursor: default; }
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
      <div id="mascot-bar"></div>
    `;
    document.body.appendChild(root);
    return root;
  }

  // ---------------------------------------------------------------------
  // Sprite rendering
  // ---------------------------------------------------------------------
  // Builds the layered sprite (hat -> body -> prop) for one pet into the
  // given container element. `frame` is 1 or 2 (idle animation).
  function renderSprite(container, pet, frame, bankedHours) {
    const stage = pet.__stage;
    const skinColor = pet.skinColor || '#8FB4D6';
    const bodySrc = ASSET_BASE + 'pet-body-' + stage.key + '-' + frame + '.png';

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
          <div class="mascot-shimmer-bar" style="background:${pal.shimmer};"></div>
        </div>`;
      } else if (hat.shimmer === 'max') {
        const pal = paletteAt(4); // dedicated max-tier color (Amethyst)
        tintColor = pal.edge;
        shimmerHtml = `<div class="mascot-tint-rect" style="-webkit-mask-image:url('${hat.trim}');mask-image:url('${hat.trim}');overflow:hidden;">
          <div class="mascot-shimmer-bar" style="background:${pal.shimmer};"></div>
        </div>`;
      } else {
        const pal = paletteAt(hat.tierIndex || 0);
        tintColor = pal.edge;
      }
      hatHtml = `
        <div style="position:absolute;inset:0;transform:translate(${txPct}%, ${tyPct}%);">
          <img src="${hat.base}" style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;" />
          <div class="mascot-isolate" style="position:absolute;inset:0;">
            <div class="mascot-tint-rect" style="background:${tintColor};-webkit-mask-image:url('${hat.trim}');mask-image:url('${hat.trim}');"></div>
            <img class="mascot-multiply" src="${hat.trim}" style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;" />
          </div>
          ${shimmerHtml}
        </div>`;
    }

    let propHtml = '';
    if (pet.activeSkill) {
      const propAnchor = PROP_ANCHORS[pet.activeSkill];
      const propSrc = ASSET_BASE + 'prop-' + pet.activeSkill + '.png';
      const txPct = (stage.hand.x - propAnchor.x) / 64 * 100;
      const tyPct = (stage.hand.y - propAnchor.y) / 64 * 100;
      const working = bankedHours > 0;
      propHtml = `
        <img class="mascot-prop ${working ? 'mascot-working' : 'mascot-resting'}" src="${propSrc}"
          style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;--mascot-prop-tx:${txPct}%;--mascot-prop-ty:${tyPct}%;transform:translate(${txPct}%, ${tyPct}%);" />`;
    }

    container.innerHTML = `
      ${hatHtml}
      <div class="mascot-isolate" style="position:absolute;inset:0;">
        <div class="mascot-tint-rect" style="background:${skinColor};-webkit-mask-image:url('${bodySrc}');mask-image:url('${bodySrc}');"></div>
        <img class="mascot-multiply" src="${bodySrc}" style="position:absolute;inset:0;width:100%;height:100%;image-rendering:pixelated;" />
      </div>
      ${propHtml}
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
    frame: 1
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

    const { pets } = computeDerivedPets();
    const bar = document.getElementById('mascot-bar');
    bar.innerHTML = '';
    PET_KEYS.forEach((key) => {
      const pet = pets[key];
      const slot = document.createElement('button');
      slot.className = 'mascot-slot';
      slot.type = 'button';
      slot.innerHTML = `<div class="mascot-sprite-box" id="mascot-sprite-${key}"></div><span class="mascot-slot-name">${labelForPet(key)}</span>`;
      slot.addEventListener('click', () => {
        widgetState.expandedPet = widgetState.expandedPet === key ? null : key;
        widgetState.expandedSkill = null;
        render();
      });
      bar.appendChild(slot);
      renderSprite(slot.querySelector('.mascot-sprite-box'), pet, widgetState.frame, pet.__bankedHours);
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
          <img src="${ASSET_BASE}prop-${skill}.png" />
          <span>${level}</span>
        </div>`;
      }).join('');

      let ownControlsHtml = '';
      if (isOwn) {
        const unlocked = unlockedHatsForPet(pet);
        const hatButtons = [`<button class="mascot-hat-btn" data-hat="">None</button>`]
          .concat(unlocked.map((h) => `<button class="mascot-hat-btn" data-hat="${h.id}">${hatLabel(h)}</button>`))
          .join('');
        const swatchesHtml = SWATCH_COLORS.map((c) => `<div class="mascot-swatch${pet.skinColor === c ? ' mascot-swatch-active' : ''}" data-color="${c}" style="background:${c};"></div>`).join('');
        ownControlsHtml = `
          <div style="margin-top:10px;">
            <div class="mascot-xp-line">Hats earned so far — tap to equip:</div>
            <div class="mascot-hat-list">${hatButtons}</div>
            <div class="mascot-xp-line" style="margin-top:8px;">Skin color:</div>
            <div class="mascot-swatch-row">${swatchesHtml}</div>
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
      panel.querySelectorAll('.mascot-pill').forEach((el) => {
        el.addEventListener('click', () => { widgetState.expandedSkill = el.getAttribute('data-skill'); render(); });
      });
      if (isOwn) {
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
      const xp = pet.skillXP[skill] || 0;
      const level = levelForHours(xp);
      const nextLevelHours = level < 99 ? hoursForLevel(level + 1) : null;
      const isActive = pet.activeSkill === skill;

      let trainHtml = '';
      if (isOwn) {
        trainHtml = `<button class="mascot-train-btn" id="mascot-train-btn" ${isActive ? 'disabled' : ''}>${isActive ? 'Currently training' : 'Train this skill'}</button>`;
      }

      panel.innerHTML = `
        <div class="mascot-close-row"><button class="mascot-close-btn" id="mascot-close-btn">✕</button></div>
        <button class="mascot-back-btn" id="mascot-back-btn">‹ Back to skills</button>
        <div class="mascot-skill-detail">
          <h4>${SKILL_LABELS[skill]} — Level ${level}</h4>
          <div class="mascot-xp-line">${xp.toFixed(1)} / 1000 AFK hours banked${nextLevelHours ? ` — ${(nextLevelHours - xp).toFixed(1)} hr to level ${level + 1}` : ' — maxed at level 99'}</div>
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

      // Live subscriptions — both pets' cosmetics/levels stay in sync across
      // devices, and life stage updates in real time as anyone completes tasks.
      firebase.firestore().collection('household').doc('mascot-state').onSnapshot((snap) => {
        widgetState.mascotDoc = snap.exists ? snap.data() : {};
        render();
      }, (e) => console.error('Mascot state subscription failed', e));

      if (typeof window.subscribeAchievementCounts === 'function') {
        window.subscribeAchievementCounts((counts) => {
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
