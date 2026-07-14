// Shared "marked for cancellation" ticker. Shows a bright amber, site-wide
// banner on every page (except index.html) whenever a Bill or Subscription
// is both checked "mark for cancel" AND renewing within the next 7 days, so
// it's impossible to miss regardless of which page you're on. Tapping it
// goes straight to subscriptions.html.
//
// Deliberately a sibling of priority-alert.js rather than a shared/merged
// component — same ticker mechanics (pause, then a news-ticker-style crawl),
// same self-contained inject-your-own-DOM approach, same cache-then-correct
// two-layer pattern, but a distinct color/icon/domain (money about to renew,
// not a note's priority) and a distinct Firestore doc. Duplicating the
// ticker plumbing here keeps each banner simple and independently
// removable, rather than one script trying to be generic over two shapes of
// alert.
//
// The banner is purely derived from live Firestore data — there's no
// separate "dismiss" state to manage. Unchecking "mark for cancel",
// deleting the item, or its renewal date rolling outside the 7-day window
// all naturally make it disappear on the next snapshot, same as it
// appearing in the first place.
(function () {
  const CACHE_KEY = 'cancelAlertCache';
  const PAUSE_SECONDS = 3.5;
  const SCROLL_PX_PER_SEC = 55;
  const DUE_SOON_DAYS = 7; // include anything renewing within a week (or already overdue)
  let lastTrackWidth = null;

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed.items) ? parsed.items : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(items) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ items }));
    } catch (e) {
      // ignore — localStorage may be unavailable; live data still works
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    #cancel-alert-banner {
      display: none;
      align-items: center;
      gap: 8px;
      position: sticky;
      /* top is set in JS, right below priority-alert-banner's own height
         (0 if that banner isn't currently shown) — see watchPriorityBannerHeight. */
      top: 0;
      z-index: 10040;
      width: 100%;
      padding: 10px 16px;
      background: #B8631F;
      color: #FFFFFF;
      font-family: 'IBM Plex Mono', monospace, -apple-system, sans-serif;
      font-size: 13px;
      font-weight: 700;
      letter-spacing: 0.02em;
      text-decoration: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      box-sizing: border-box;
      overflow: hidden;
    }
    #cancel-alert-banner:hover { background: #9C5219; }
    #cancel-alert-banner .cancel-alert-icon {
      font-size: 15px;
      flex-shrink: 0;
    }
    #cancel-alert-banner .cancel-alert-track {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      position: relative;
      height: 18px;
    }
    #cancel-alert-banner .cancel-alert-ticker {
      display: inline-block;
      white-space: nowrap;
      position: absolute;
      left: 0;
      top: 0;
      will-change: transform;
    }
    #cancel-alert-banner .cancel-alert-ticker-copy {
      display: inline-block;
      padding-right: 48px;
    }
  `;
  document.head.appendChild(style);

  function ensureBannerEl() {
    let el = document.getElementById('cancel-alert-banner');
    if (!el) {
      el = document.createElement('a');
      el.id = 'cancel-alert-banner';
      el.href = 'subscriptions.html';
      // Right after priority-alert-banner (or at the very top of <body> if
      // that one isn't there yet) — insertBefore(el, body.firstChild) would
      // put this ABOVE priority-alert-banner if that one hasn't been
      // created yet, so anchor off it explicitly when present.
      const priorityBanner = document.getElementById('priority-alert-banner');
      if (priorityBanner && priorityBanner.nextSibling) {
        document.body.insertBefore(el, priorityBanner.nextSibling);
      } else if (priorityBanner) {
        document.body.appendChild(el);
      } else {
        document.body.insertBefore(el, document.body.firstChild);
      }
    }
    return el;
  }

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function snippet(text, max) {
    max = max || 40;
    const t = (text || '').trim();
    return t.length > max ? t.slice(0, max).trim() + '…' : t;
  }

  // Whole-day difference between `dateStr` (YYYY-MM-DD, local) and today.
  // Negative means overdue.
  function daysUntil(dateStr) {
    if (!dateStr) return Infinity;
    const [y, m, d] = dateStr.split('-').map(Number);
    const target = new Date(y, (m || 1) - 1, d || 1);
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    target.setHours(0, 0, 0, 0);
    return Math.round((target - today) / 86400000);
  }

  function dueLabel(days) {
    if (days < 0) return `overdue by ${Math.abs(days)}d`;
    if (days === 0) return 'renews today';
    if (days === 1) return 'renews tomorrow';
    return `renews in ${days}d`;
  }

  function buildTickerText(items) {
    const total = items.length;
    const summary = `${total} subscription${total === 1 ? '' : 's'} marked to cancel`;
    const bits = items.map((it) => `✂️ ${escapeHtml(snippet(it.name))} (${dueLabel(daysUntil(it.renewalDate))})`);
    return bits.length ? `${summary}     —     ${bits.join('     •     ')}` : summary;
  }

  // Same seamless-loop technique as priority-alert.js's setupTicker — see
  // that file's comment for why the ticker text is rendered twice.
  function setupTicker() {
    const ticker = document.getElementById('cancel-alert-ticker-text');
    const track = ticker && ticker.parentElement;
    if (!ticker || !track) return;

    ticker.style.animation = 'none';
    void ticker.offsetWidth;

    const copies = ticker.querySelectorAll('.cancel-alert-ticker-copy');
    const firstCopy = copies[0];
    const secondCopy = copies[1];
    if (!firstCopy) return;

    const copyWidth = firstCopy.scrollWidth;
    const trackWidth = track.clientWidth;
    lastTrackWidth = trackWidth;

    if (copyWidth <= trackWidth) {
      if (secondCopy) secondCopy.style.display = 'none';
      return;
    }
    if (secondCopy) secondCopy.style.display = '';

    const scrollSeconds = copyWidth / SCROLL_PX_PER_SEC;
    const totalSeconds = PAUSE_SECONDS + scrollSeconds;
    const pausePercent = (PAUSE_SECONDS / totalSeconds) * 100;

    const styleId = 'cancel-alert-ticker-keyframes';
    let keyframesEl = document.getElementById(styleId);
    if (!keyframesEl) {
      keyframesEl = document.createElement('style');
      keyframesEl.id = styleId;
      document.head.appendChild(keyframesEl);
    }
    keyframesEl.textContent = `
      @keyframes cancelAlertTicker {
        0% { transform: translateX(0); }
        ${pausePercent.toFixed(2)}% { transform: translateX(0); }
        100% { transform: translateX(-${copyWidth}px); }
      }
    `;
    ticker.style.animation = `cancelAlertTicker ${totalSeconds.toFixed(2)}s linear infinite`;
  }

  function renderBanner(items) {
    const el = ensureBannerEl();
    if (items.length === 0) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';
    const text = buildTickerText(items);
    el.innerHTML = `<span class="cancel-alert-icon">✂️</span><div class="cancel-alert-track"><span class="cancel-alert-ticker" id="cancel-alert-ticker-text"><span class="cancel-alert-ticker-copy">${text}</span><span class="cancel-alert-ticker-copy" aria-hidden="true">${text}</span></span></div>`;
    requestAnimationFrame(setupTicker);
  }

  function itemsForCache(items) {
    return items.map((it) => ({ name: snippet(it.name, 60), renewalDate: it.renewalDate || null }));
  }

  const cached = readCache();
  if (cached) renderBanner(cached);

  window.initCancelAlertBanner = function () {
    try {
      const db = firebase.firestore();
      db.collection('household').doc('subscriptions-state').onSnapshot((snap) => {
        if (!snap.exists) { renderBanner([]); writeCache([]); return; }
        const data = snap.data() || {};
        const all = [].concat(Array.isArray(data.bill) ? data.bill : [], Array.isArray(data.subscription) ? data.subscription : []);
        const dueSoon = all.filter((it) => it && it.cancelPending && daysUntil(it.renewalDate) <= DUE_SOON_DAYS);
        renderBanner(dueSoon);
        writeCache(itemsForCache(dueSoon));
      }, (err) => console.error('Cancel alert banner failed', err));
    } catch (e) {
      console.error('Cancel alert banner failed', e);
    }
  };

  // Keeps this banner docked directly below priority-alert-banner regardless
  // of whether that one is currently shown, hidden, or not yet rendered —
  // see the note on ensureBannerEl for why a plain DOM-order sticky stack
  // isn't enough on its own (position: sticky doesn't auto-reserve a
  // preceding sticky sibling's height, so both would sit at the same `top`
  // and overlap unless this one's `top` is kept in sync). Polling is simpler
  // and more robust here than a MutationObserver/ResizeObserver pairing,
  // since it doesn't depend on which banner's script happens to create its
  // DOM element first.
  let lastPriorityHeight = -1;
  setInterval(() => {
    const priorityBanner = document.getElementById('priority-alert-banner');
    const h = priorityBanner && priorityBanner.style.display !== 'none' ? priorityBanner.offsetHeight : 0;
    if (h === lastPriorityHeight) return;
    lastPriorityHeight = h;
    const el = document.getElementById('cancel-alert-banner');
    if (el) el.style.top = h + 'px';
  }, 300);

  window.addEventListener('resize', () => {
    const ticker = document.getElementById('cancel-alert-ticker-text');
    if (!ticker) return;
    const track = ticker.parentElement;
    const currentWidth = track ? track.clientWidth : null;
    if (currentWidth !== null && currentWidth === lastTrackWidth) return;
    setupTicker();
  });
})();
