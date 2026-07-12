// Shared priority-alert banner. Shows a bright red, site-wide banner on
// every page (except index.html) whenever there are unresolved Critical or
// High priority notes, so it's impossible to miss regardless of which page
// you're on. Tapping it goes straight to notes.html.
//
// Fully self-contained: injects its own <style> block, so no page needs any
// CSS changes to support it.
//
// Same two-layer pattern as theme.js: a cached last-known count is rendered
// immediately (before Firebase/auth even resolves), so the banner persists
// through the sign-in check and the page's own "Getting things ready..."
// loading flash instead of flickering off and back on between pages. The
// live Firestore subscription then corrects it with the real, current count.
(function () {
  const CACHE_KEY = 'priorityAlertCache';

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed.critical === 'number' && typeof parsed.high === 'number') return parsed;
      return null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(critical, high) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ critical, high }));
    } catch (e) {
      // ignore — localStorage may be unavailable; live data still works
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    #priority-alert-banner {
      display: none;
      align-items: center;
      justify-content: center;
      gap: 8px;
      position: sticky;
      top: 0;
      z-index: 10050;
      width: 100%;
      padding: 10px 16px;
      background: #D32F2F;
      color: #FFFFFF;
      font-family: 'IBM Plex Mono', monospace, -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-decoration: none;
      text-align: center;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      box-sizing: border-box;
    }
    #priority-alert-banner:hover { background: #B71C1C; }
    #priority-alert-banner .priority-alert-icon {
      font-size: 15px;
      flex-shrink: 0;
    }
  `;
  document.head.appendChild(style);

  function ensureBannerEl() {
    let el = document.getElementById('priority-alert-banner');
    if (!el) {
      el = document.createElement('a');
      el.id = 'priority-alert-banner';
      el.href = 'notes.html';
      document.body.insertBefore(el, document.body.firstChild);
    }
    return el;
  }

  function renderBanner(criticalCount, highCount) {
    const el = ensureBannerEl();
    const total = criticalCount + highCount;
    if (total === 0) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';
    const parts = [];
    if (criticalCount > 0) parts.push(`${criticalCount} Critical`);
    if (highCount > 0) parts.push(`${highCount} High`);
    el.innerHTML = `<span class="priority-alert-icon">\u26A0\uFE0F</span><span>${parts.join(' \u00b7 ')} priority note${total === 1 ? '' : 's'} unresolved</span>`;
  }

  // Runs immediately as the script is parsed — before Firebase, before auth,
  // before anything else on the page. Paints the last-known state from this
  // browser's cache so the banner doesn't disappear and reappear between
  // pages while the real data loads.
  const cached = readCache();
  if (cached) renderBanner(cached.critical, cached.high);

  // Call once auth has resolved. Subscribes live, so the banner appears,
  // updates, or disappears in real time on every open page as notes are
  // added, reprioritized, or resolved anywhere in the household — and
  // refreshes the cache each time so the next page load's instant guess
  // stays accurate.
  window.initPriorityAlertBanner = function () {
    try {
      const db = firebase.firestore();
      db.collection('household').doc('household-notes-state').onSnapshot((snap) => {
        if (!snap.exists) { renderBanner(0, 0); writeCache(0, 0); return; }
        const data = snap.data() || {};
        const items = Array.isArray(data.items) ? data.items : [];
        let critical = 0, high = 0;
        items.forEach((it) => {
          if (it && !it.done) {
            if (it.priority === 'critical') critical++;
            else if (it.priority === 'high') high++;
          }
        });
        renderBanner(critical, high);
        writeCache(critical, high);
      }, (err) => console.error('Priority alert banner failed', err));
    } catch (e) {
      console.error('Priority alert banner failed', e);
    }
  };
})();
