// Shared dark mode toggle. Preference is stored per signed-in account in
// Firestore (household/theme-preferences), so it follows each person across
// devices without touching browser storage for the source of truth.
//
// A local cache (localStorage) is used ONLY as a same-browser instant-paint
// hint, so the sign-in screen and loading state aren't stuck in light mode
// for a beat every time you open a page. Firestore remains authoritative —
// if it disagrees with the cached value (e.g. you changed themes on your
// other device), Firestore wins as soon as it loads.
//
// IMPORTANT: this script must load and run before auth.js creates its
// sign-in overlay, so the very first paint already has the right theme.
(function () {
  function readCache() {
    try {
      const v = localStorage.getItem('householdTheme');
      return (v === 'dark' || v === 'light') ? v : null;
    } catch (e) {
      return null;
    }
  }

  function writeCache(theme) {
    try {
      localStorage.setItem('householdTheme', theme);
    } catch (e) {
      // ignore — localStorage may be unavailable; Firestore still works
    }
  }

  function moonIcon() {
    return `<svg width="15" height="15" viewBox="0 0 16 16"><path d="M13.5 9.5A6 6 0 1 1 6.5 2.5A5 5 0 0 0 13.5 9.5Z" fill="currentColor"/></svg>`;
  }

  function sunIcon() {
    return `<svg width="15" height="15" viewBox="0 0 16 16"><circle cx="8" cy="8" r="3.2" fill="currentColor"/><g stroke="currentColor" stroke-width="1.4" stroke-linecap="round"><path d="M8 1.5V3.2"/><path d="M8 12.8V14.5"/><path d="M1.5 8H3.2"/><path d="M12.8 8H14.5"/><path d="M3.4 3.4L4.6 4.6"/><path d="M11.4 11.4L12.6 12.6"/><path d="M12.6 3.4L11.4 4.6"/><path d="M4.6 11.4L3.4 12.6"/></g></svg>`;
  }

  function applyTheme(theme) {
    window.currentTheme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    writeCache(theme);
    const btn = document.getElementById('theme-toggle-btn');
    if (btn) {
      btn.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
    }
    // Let the current page react (e.g. re-render a theme-aware toggle label).
    if (typeof window.onThemeChange === 'function') {
      try { window.onThemeChange(theme); } catch (e) { /* no-op */ }
    }
  }

  // Runs immediately as the script is parsed — before Firebase, before the
  // auth gate, before anything else on the page. Applies the last-known
  // theme from this browser so the very first thing painted (sign-in
  // screen, loading state) is already correct.
  window.currentTheme = readCache() || 'light';
  document.documentElement.setAttribute('data-theme', window.currentTheme);

  // Call once auth has resolved. Confirms (or corrects) the guess above
  // against the authoritative value stored for this account in Firestore.
  window.initTheme = function () {
    try {
      const user = window.currentHouseholdUser;
      if (!user) return;
      const email = (user.email || '').toLowerCase();
      firebase.firestore().collection('household').doc('theme-preferences').get()
        .then((snap) => {
          const data = snap.exists ? snap.data() : {};
          applyTheme(data[email] === 'dark' ? 'dark' : 'light');
        })
        .catch((err) => console.error('Could not load theme preference', err));
    } catch (e) {
      console.error('Could not load theme preference', e);
    }
  };

  window.toggleTheme = function () {
    const next = window.currentTheme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    try {
      const user = window.currentHouseholdUser;
      if (!user) return;
      const email = (user.email || '').toLowerCase();
      firebase.firestore().collection('household').doc('theme-preferences').set(
        { [email]: next },
        { merge: true }
      ).catch((err) => console.error('Could not save theme preference', err));
    } catch (e) {
      console.error('Could not save theme preference', e);
    }
  };
})();
