// Shared priority-alert banner. Shows a bright red, site-wide banner on
// every page (except index.html) whenever there are unresolved Critical or
// High priority notes, so it's impossible to miss regardless of which page
// you're on. Tapping it goes straight to notes.html.
//
// The banner shows the "N Critical / M High" summary first, then — after a
// brief pause — scrolls a news-ticker-style crawl listing each unresolved
// Critical/High note: how long it's been at that priority, plus a text
// snippet. The pause-then-scroll cycle repeats for as long as the banner
// is shown.
//
// Fully self-contained: injects its own <style> block, so no page needs any
// CSS changes to support it.
//
// Same two-layer pattern as theme.js: a cached last-known state is rendered
// immediately (before Firebase/auth even resolves), so the banner persists
// through the sign-in check and the page's own "Getting things ready..."
// loading flash instead of flickering off and back on between pages. The
// live Firestore subscription then corrects it with the real, current data.
(function () {
  const CACHE_KEY = 'priorityAlertCache';
  const PAUSE_SECONDS = 3.5;    // how long the summary holds before scrolling
  const SCROLL_PX_PER_SEC = 55; // ticker scroll speed

  function readCache() {
    try {
      const raw = localStorage.getItem(CACHE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (typeof parsed.critical === 'number' && typeof parsed.high === 'number') {
        return {
          critical: parsed.critical,
          high: parsed.high,
          criticalItems: Array.isArray(parsed.criticalItems) ? parsed.criticalItems : [],
          highItems: Array.isArray(parsed.highItems) ? parsed.highItems : []
        };
      }
      return null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(critical, high, criticalItems, highItems) {
    try {
      localStorage.setItem(CACHE_KEY, JSON.stringify({ critical, high, criticalItems, highItems }));
    } catch (e) {
      // ignore — localStorage may be unavailable; live data still works
    }
  }

  const style = document.createElement('style');
  style.textContent = `
    #priority-alert-banner {
      display: none;
      align-items: center;
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
      box-shadow: 0 2px 8px rgba(0,0,0,0.25);
      box-sizing: border-box;
      overflow: hidden;
    }
    #priority-alert-banner:hover { background: #B71C1C; }
    #priority-alert-banner .priority-alert-icon {
      font-size: 15px;
      flex-shrink: 0;
    }
    #priority-alert-banner .priority-alert-track {
      flex: 1;
      min-width: 0;
      overflow: hidden;
      position: relative;
      height: 18px;
    }
    #priority-alert-banner .priority-alert-ticker {
      display: inline-block;
      white-space: nowrap;
      position: absolute;
      left: 0;
      top: 0;
      will-change: transform;
    }
    #priority-alert-banner .priority-alert-ticker-copy {
      display: inline-block;
      padding-right: 48px;
    }
    #priority-alert-banner .priority-alert-critical-badge {
      display: inline-block;
      background: #FFFFFF;
      color: #B71C1C;
      font-weight: 800;
      padding: 1px 6px;
      border-radius: 4px;
      margin-right: 2px;
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

  function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str == null ? '' : String(str);
    return div.innerHTML;
  }

  function snippet(text, max) {
    max = max || 50;
    const t = (text || '').trim();
    return t.length > max ? t.slice(0, max).trim() + '…' : t;
  }

  function timeAgo(ts) {
    if (!ts) return '';
    const diffMs = Date.now() - ts;
    if (diffMs < 0) return 'just now';
    const mins = Math.floor(diffMs / 60000);
    if (mins < 1) return 'just now';
    if (mins < 60) return mins + 'm ago';
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return hrs + 'h ago';
    const days = Math.floor(hrs / 24);
    return days + 'd ago';
  }

  function buildTickerText(criticalCount, highCount, criticalItems, highItems) {
    const parts = [];
    if (criticalCount > 0) parts.push(`${criticalCount} Critical`);
    if (highCount > 0) parts.push(`${highCount} High`);
    const total = criticalCount + highCount;
    const summary = `${parts.join(' · ')} priority note${total === 1 ? '' : 's'} unresolved`;

    const noteBits = [];
    (criticalItems || []).forEach((it) => {
      // Critical gets an inverted (white-on-red) badge rather than a plain
      // 🔴, which reads as noticeably dimmer than 🟡 against this banner's
      // solid red background on most platforms — Critical needs to be the
      // loudest thing here, not the quietest.
      noteBits.push(`<span class="priority-alert-critical-badge">🚨 CRITICAL</span> (${timeAgo(it.priorityAt)}): “${escapeHtml(snippet(it.text))}”`);
    });
    (highItems || []).forEach((it) => {
      noteBits.push(`🟡 High (${timeAgo(it.priorityAt)}): “${escapeHtml(snippet(it.text))}”`);
    });

    return noteBits.length ? `${summary}     —     ${noteBits.join('     •     ')}` : summary;
  }

  // Applies (or re-applies) the scroll animation to match the current
  // ticker text's actual rendered width. Keeps the summary held in place
  // for PAUSE_SECONDS before crawling the rest of the text leftward, then
  // loops. Re-measures on every render since note text/length changes.
  //
  // The ticker element always contains the text rendered TWICE back-to-back
  // (see renderBanner). Scrolling by exactly one copy's width means that the
  // instant the animation resets from 100% back to 0%, the second copy —
  // which is sitting exactly where the first copy started — is already
  // showing in its place, so the reset is invisible and the text appears to
  // loop around continuously instead of snapping back to its start position.
  function setupTicker() {
    const ticker = document.getElementById('priority-alert-ticker-text');
    const track = ticker && ticker.parentElement;
    if (!ticker || !track) return;

    ticker.style.animation = 'none';
    // Force reflow so the browser re-measures before we read widths / restart the animation.
    void ticker.offsetWidth;

    const copies = ticker.querySelectorAll('.priority-alert-ticker-copy');
    const firstCopy = copies[0];
    const secondCopy = copies[1];
    if (!firstCopy) return;

    const copyWidth = firstCopy.scrollWidth;
    const trackWidth = track.clientWidth;

    if (copyWidth <= trackWidth) {
      // Fits without scrolling — hide the duplicate so it doesn't just sit
      // there doubled-up with nothing to do.
      if (secondCopy) secondCopy.style.display = 'none';
      return;
    }
    if (secondCopy) secondCopy.style.display = '';

    const scrollSeconds = copyWidth / SCROLL_PX_PER_SEC;
    const totalSeconds = PAUSE_SECONDS + scrollSeconds;
    const pausePercent = (PAUSE_SECONDS / totalSeconds) * 100;

    const styleId = 'priority-alert-ticker-keyframes';
    let keyframesEl = document.getElementById(styleId);
    if (!keyframesEl) {
      keyframesEl = document.createElement('style');
      keyframesEl.id = styleId;
      document.head.appendChild(keyframesEl);
    }
    keyframesEl.textContent = `
      @keyframes priorityAlertTicker {
        0% { transform: translateX(0); }
        ${pausePercent.toFixed(2)}% { transform: translateX(0); }
        100% { transform: translateX(-${copyWidth}px); }
      }
    `;
    ticker.style.animation = `priorityAlertTicker ${totalSeconds.toFixed(2)}s linear infinite`;
  }

  function renderBanner(criticalCount, highCount, criticalItems, highItems) {
    const el = ensureBannerEl();
    const total = criticalCount + highCount;
    if (total === 0) {
      el.style.display = 'none';
      return;
    }
    el.style.display = 'flex';
    const text = buildTickerText(criticalCount, highCount, criticalItems, highItems);
    // Rendered twice so setupTicker can scroll by exactly one copy's width
    // and loop seamlessly — see the comment on setupTicker for why.
    el.innerHTML = `<span class="priority-alert-icon">⚠️</span><div class="priority-alert-track"><span class="priority-alert-ticker" id="priority-alert-ticker-text"><span class="priority-alert-ticker-copy">${text}</span><span class="priority-alert-ticker-copy" aria-hidden="true">${text}</span></span></div>`;
    // Measure after paint so scrollWidth/clientWidth are accurate.
    requestAnimationFrame(setupTicker);
  }

  function itemsForCache(items) {
    // Only keep what the ticker needs, and cap length so localStorage
    // doesn't grow unbounded with long note text.
    return items.map((it) => ({ text: snippet(it.text, 80), priorityAt: it.priorityAt || null }));
  }

  // Runs immediately as the script is parsed — before Firebase, before auth,
  // before anything else on the page. Paints the last-known state from this
  // browser's cache so the banner doesn't disappear and reappear between
  // pages while the real data loads.
  const cached = readCache();
  if (cached) renderBanner(cached.critical, cached.high, cached.criticalItems, cached.highItems);

  // Call once auth has resolved. Subscribes live, so the banner appears,
  // updates, or disappears in real time on every open page as notes are
  // added, reprioritized, or resolved anywhere in the household — and
  // refreshes the cache each time so the next page load's instant guess
  // stays accurate.
  window.initPriorityAlertBanner = function () {
    try {
      const db = firebase.firestore();
      db.collection('household').doc('household-notes-state').onSnapshot((snap) => {
        if (!snap.exists) { renderBanner(0, 0, [], []); writeCache(0, 0, [], []); return; }
        const data = snap.data() || {};
        const items = Array.isArray(data.items) ? data.items : [];
        const criticalItems = [], highItems = [];
        items.forEach((it) => {
          if (it && !it.done) {
            if (it.priority === 'critical') criticalItems.push(it);
            else if (it.priority === 'high') highItems.push(it);
          }
        });
        renderBanner(criticalItems.length, highItems.length, criticalItems, highItems);
        writeCache(criticalItems.length, highItems.length, itemsForCache(criticalItems), itemsForCache(highItems));
      }, (err) => console.error('Priority alert banner failed', err));
    } catch (e) {
      console.error('Priority alert banner failed', e);
    }
  };

  window.addEventListener('resize', () => {
    if (document.getElementById('priority-alert-ticker-text')) setupTicker();
  });
})();
