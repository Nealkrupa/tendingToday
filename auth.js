// Shared household auth gate. Requires Google Sign-In and restricts access
// to a specific list of approved email addresses.
//
// Usage in each page: instead of calling load() directly, call:
//   requireHouseholdAuth(load);
// load() will only run once someone signs in with an approved Google account.
(function () {
  const ALLOWED_EMAILS = [
    'nealkrupa@gmail.com',
    'natjkrupa@gmail.com'
  ];

  // Short display names used for "added by" attribution around the site.
  // Keyed the same way as ALLOWED_EMAILS — update both together.
  const EMAIL_LABELS = {
    'nealkrupa@gmail.com': 'Neal',
    'natjkrupa@gmail.com': 'Nat'
  };

  window.getHouseholdUserLabel = function () {
    const user = window.currentHouseholdUser;
    if (!user) return '';
    const email = (user.email || '').toLowerCase();
    if (EMAIL_LABELS[email]) return EMAIL_LABELS[email];
    if (user.displayName) return user.displayName.split(' ')[0];
    return email;
  };

  const style = document.createElement('style');
  style.textContent = `
    #auth-gate-overlay {
      position: fixed;
      inset: 0;
      background: var(--bg, #EEF1EA);
      z-index: 9999;
      display: flex;
      align-items: center;
      justify-content: center;
      font-family: 'Inter', -apple-system, sans-serif;
      padding: 20px;
    }
    #auth-gate-card {
      background: var(--card, #FFFFFF);
      border-radius: 18px;
      padding: 32px 26px;
      max-width: 320px;
      width: 100%;
      text-align: center;
      box-shadow: 0 2px 14px rgba(38,48,41,0.14);
    }
    #auth-gate-card h2 {
      font-family: 'Fraunces', serif;
      font-weight: 600;
      font-size: 20px;
      margin: 0 0 8px 0;
      color: var(--ink, #263029);
    }
    #auth-gate-card p {
      font-size: 14px;
      color: var(--muted, #6B7568);
      margin: 0 0 22px 0;
      line-height: 1.5;
    }
    #auth-gate-btn, #auth-gate-retry {
      display: inline-flex;
      align-items: center;
      gap: 10px;
      background: var(--card, #FFFFFF);
      color: var(--ink, #263029);
      border: 1.5px solid var(--line, #DDE3D6);
      border-radius: 12px;
      padding: 11px 22px;
      font-size: 14px;
      font-weight: 600;
      font-family: inherit;
      cursor: pointer;
      transition: border-color 0.15s ease;
    }
    #auth-gate-btn:hover, #auth-gate-retry:hover { border-color: var(--sage, #7C9075); }
    #auth-gate-signout {
      display: inline-block;
      margin-top: 16px;
      font-size: 12px;
      color: var(--muted, #6B7568);
      text-decoration: underline;
      background: none;
      border: none;
      cursor: pointer;
      font-family: inherit;
    }
  `;
  document.head.appendChild(style);

  function showGate(message, mode) {
    let overlay = document.getElementById('auth-gate-overlay');
    if (!overlay) {
      overlay = document.createElement('div');
      overlay.id = 'auth-gate-overlay';
      document.body.appendChild(overlay);
    }
    overlay.innerHTML = `
      <div id="auth-gate-card">
        <h2>Household Sign-In</h2>
        <p>${message}</p>
        ${mode === 'signin' ? `<button id="auth-gate-btn" type="button">Sign in with Google</button>` : ''}
        ${mode === 'denied' ? `<button id="auth-gate-signout" type="button">Sign out and try a different account</button>` : ''}
        ${mode === 'stuck' ? `<button id="auth-gate-retry" type="button">Reload</button>` : ''}
      </div>
    `;
    if (mode === 'signin') {
      document.getElementById('auth-gate-btn').addEventListener('click', () => {
        const provider = new firebase.auth.GoogleAuthProvider();
        firebase.auth().signInWithPopup(provider).catch((err) => {
          console.error('Sign-in failed', err);
          showGate('Sign-in didn\u2019t go through. Please try again.', 'signin');
        });
      });
    }
    if (mode === 'denied') {
      document.getElementById('auth-gate-signout').addEventListener('click', () => {
        firebase.auth().signOut();
      });
    }
    if (mode === 'stuck') {
      document.getElementById('auth-gate-retry').addEventListener('click', () => {
        location.reload();
      });
    }
  }

  function hideGate() {
    const overlay = document.getElementById('auth-gate-overlay');
    if (overlay) overlay.remove();
  }

  window.requireHouseholdAuth = function (onReady) {
    showGate('Checking your sign-in status\u2026', 'loading');
    // Some mobile browsers (notably iOS home-screen web apps and some mobile
    // Chrome configurations) can silently fail to resolve Firebase Auth's
    // persisted session check, leaving onAuthStateChanged's callback never
    // firing and this loading card stuck forever with no error. This watchdog
    // turns that silent hang into a visible, recoverable state instead.
    const stuckTimer = setTimeout(() => {
      showGate('Sign-in check is taking longer than expected. This can happen on some mobile browsers.', 'stuck');
    }, 8000);
    firebase.auth().onAuthStateChanged((user) => {
      clearTimeout(stuckTimer);
      if (!user) {
        showGate('This is a private household site. Sign in with an approved Google account to continue.', 'signin');
        return;
      }
      const email = (user.email || '').toLowerCase();
      if (!ALLOWED_EMAILS.includes(email)) {
        showGate(`Signed in as ${user.email}, but this account doesn\u2019t have access to this site.`, 'denied');
        return;
      }
      hideGate();
      window.currentHouseholdUser = user;
      onReady(user);
    });
  };
})();
