// Shared achievements tracker. Pages call recordAchievement(key, delta)
// whenever something gets checked off (+1) or unchecked (-1). Counts
// accumulate forever in household/achievements-state and power the
// gold star sticker board on achievements.html.
//
// recordPerfectDay(dateStr) is called when all 7 daily foundations are
// complete for a given day — it records a "perfect day" star and updates
// the running streak. A perfect day is only counted once per date, and is
// never revoked once earned (generous by design: unchecking a task after
// hitting a perfect day doesn't take the star back).
//
// Both functions also detect crossing a round-number milestone (500, 1000,
// 5000) and permanently record who reached it and when, the first time
// only — achievements.html reads these to show a trophy badge and a
// one-time celebration banner.
(function () {
  const MILESTONES = [500, 1000, 5000];

  // Given a count before/after a change, record any newly-crossed milestone
  // into the mutable `milestones` map (keyed by achievement key, then by
  // threshold). Only fires going forward (delta > 0) and only once per
  // threshold per key — never overwritten once set.
  function stampMilestones(milestones, key, oldVal, newVal) {
    if (newVal <= oldVal) return; // only forward crossings count
    MILESTONES.forEach((m) => {
      if (oldVal < m && newVal >= m) {
        if (!milestones[key]) milestones[key] = {};
        if (!milestones[key][m]) {
          const label = (window.getHouseholdUserLabel && window.getHouseholdUserLabel()) || '';
          const now = new Date();
          const dateStr = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0');
          milestones[key][m] = { date: dateStr, by: label };
        }
      }
    });
  }

  window.recordAchievement = async function (key, delta) {
    try {
      const db = firebase.firestore();
      const ref = db.collection('household').doc('achievements-state');
      // A transaction (rather than a bare increment) is needed here so we
      // can reliably see the before/after value to detect a milestone
      // crossing, even if two devices tap at nearly the same moment.
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? snap.data() : {};
        const counts = data.counts || {};
        const milestones = data.milestones || {};
        const oldVal = counts[key] || 0;
        const newVal = oldVal + delta;
        counts[key] = newVal;
        stampMilestones(milestones, key, oldVal, newVal);
        tx.set(ref, { counts, milestones }, { merge: true });
      });
    } catch (e) {
      console.error('Achievement tracking failed', e);
    }
  };

  // Live read-side companion to recordAchievement/recordPerfectDay: pages
  // that want to show a permanent, lifetime count next to their own header
  // icon (rather than just writing to the Star Board) call this once with a
  // callback; it fires immediately with whatever's cached and again on every
  // change, from any device, via onSnapshot — same live-sync pattern as
  // priority-alert.js. Returns the unsubscribe function in case a page ever
  // needs to tear it down.
  window.subscribeAchievementCounts = function (cb) {
    try {
      const db = firebase.firestore();
      const ref = db.collection('household').doc('achievements-state');
      return ref.onSnapshot((snap) => {
        const data = snap.exists ? snap.data() : {};
        cb(data.counts || {});
      }, (e) => {
        console.error('Achievement counts subscription failed', e);
      });
    } catch (e) {
      console.error('Achievement counts subscription failed', e);
      return function () {};
    }
  };

  // Sums every count whose key matches one of the given exact keys or
  // prefixes (prefixes end in ':' and match keys like 'daily:bed'). Used by
  // pages whose lifetime number is a combination of several achievement
  // keys (e.g. Tending Today combines daily/zone/deep/pet keys into one
  // number), so each page doesn't need to hand-roll the same reduce.
  window.sumAchievementCounts = function (counts, matchers) {
    let total = 0;
    Object.keys(counts || {}).forEach((key) => {
      const hit = matchers.some((m) => (m.endsWith(':') ? key.startsWith(m) : key === m));
      if (hit) total += counts[key] || 0;
    });
    return total;
  };

  window.recordPerfectDay = async function (todayStr) {
    try {
      const db = firebase.firestore();
      const ref = db.collection('household').doc('achievements-state');
      await db.runTransaction(async (tx) => {
        const snap = await tx.get(ref);
        const data = snap.exists ? snap.data() : {};
        const streak = data.streak || { current: 0, best: 0, lastPerfectDate: '' };
        if (streak.lastPerfectDate === todayStr) return; // already recorded today
        const y = new Date(todayStr + 'T12:00:00');
        y.setDate(y.getDate() - 1);
        const yesterdayStr = y.getFullYear() + '-' + String(y.getMonth() + 1).padStart(2, '0') + '-' + String(y.getDate()).padStart(2, '0');
        const current = streak.lastPerfectDate === yesterdayStr ? (streak.current || 0) + 1 : 1;
        const best = Math.max(current, streak.best || 0);
        const counts = data.counts || {};
        const milestones = data.milestones || {};
        const oldVal = counts['day:perfect'] || 0;
        const newVal = oldVal + 1;
        counts['day:perfect'] = newVal;
        stampMilestones(milestones, 'day:perfect', oldVal, newVal);
        tx.set(ref, { streak: { current, best, lastPerfectDate: todayStr }, counts, milestones }, { merge: true });
      });
    } catch (e) {
      console.error('Perfect day tracking failed', e);
    }
  };
})();
