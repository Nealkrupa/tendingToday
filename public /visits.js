// Shared page-visit tracker. Increments a counter in Firestore each time a
// page successfully loads (i.e. after the person is signed in and approved).
// The home hub reads these counts to sort its cards by most-visited.
//
// Also tracks the last time each page's *data* actually changed (not just
// viewed), so the home hub can show a "updated 2h ago" indicator per card.
(function () {
  window.trackPageVisit = function (pageKey) {
    try {
      const db = firebase.firestore();
      db.collection('household').doc('page-visit-counts').set(
        { [pageKey]: firebase.firestore.FieldValue.increment(1) },
        { merge: true }
      ).catch((err) => console.error('Visit tracking failed', err));
    } catch (e) {
      console.error('Visit tracking failed', e);
    }
  };

  window.trackPageUpdate = function (pageKey) {
    try {
      const db = firebase.firestore();
      db.collection('household').doc('page-last-updated').set(
        { [pageKey]: firebase.firestore.FieldValue.serverTimestamp() },
        { merge: true }
      ).catch((err) => console.error('Update tracking failed', err));
    } catch (e) {
      console.error('Update tracking failed', e);
    }
  };
})();
