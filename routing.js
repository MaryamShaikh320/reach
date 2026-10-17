/* =====================================================================
   Reach: routing.js (add-on, loaded right after app.js)
   Real travel times for the place you're looking at.

   app.js estimates every trip quickly (straight line + 30%, plus 5 min to
   park or 10 min for the bus) so it can check dozens of places at once.
   That runs long next to Google Maps. For the one place on screen, this
   asks Geoapify Routing (same GEOAPIFY_KEY as place search) for the real
   route, and redoes "time there" with it:
     - the map's place card: when a card is shown (and its "walk instead"
       alternative, if it has one)
     - Ask Reach (assistant.js): walking, transit and driving per suggestion
   Walking uses the route's length at Google Maps' pace, since Geoapify's
   walking times run slow. Transit is approximate (no live schedules).
   If routing fails, the estimate stays. Results are kept for the session.
   ===================================================================== */
(() => {
'use strict';

const ROUTING = {
  url: 'https://api.geoapify.com/v1/routing',
  modes: { walking: 'walk', driving: 'drive', transit: 'transit' },
  walkKmh: 4.8, // about 3 mph, Google Maps' walking pace
  timeoutMs: 8000,
};
const cache = new Map(); // "mode:from>to" -> Promise of minutes (or null when routing failed)

/** Real one-way minutes from `origin` to `place` by `mode`, or null. */
function routeMinutes(origin, place, mode) {
  if (!GEO.key || !ROUTING.modes[mode]) return Promise.resolve(null);
  const key = `${mode}:${origin.lat},${origin.lng}>${place.lat},${place.lng}`;
  if (!cache.has(key)) cache.set(key, fetchRoute(origin, place, mode));
  return cache.get(key);
}

async function fetchRoute(origin, place, mode) {
  try {
    const params = new URLSearchParams({
      waypoints: `${origin.lat},${origin.lng}|${place.lat},${place.lng}`,
      mode: ROUTING.modes[mode], format: 'json', apiKey: GEO.key,
    });
    const r = ((await fetchJson(`${ROUTING.url}?${params}`, ROUTING.timeoutMs)).results || [])[0];
    const min = r && (mode === 'walking' ? (r.distance / 1000 / ROUTING.walkKmh) * 60 : r.time / 60);
    return Number.isFinite(min) ? Math.max(1, Math.round(min)) : null;
  } catch (err) {
    console.warn('[Reach] Routing failed, using the estimate:', err.message);
    return null;
  }
}

/** A fit (from app.js checkFit) redone with a real travel time: same start, free time,
    opening hours, sunset and buffer. Returns a new fit with `routed: true`. */
function withTravel(est, thereMin, results) {
  const arrive = addMin(results.start, thereMin);
  const leaveBy = minDate(addMin(results.start, est.freeMin - est.bufferMin), est.hardStop);
  const onSiteMin = Math.max(0, Math.floor(minutesBetween(maxDate(arrive, est.opens), leaveBy)));
  const closed = est.verdict === 'no' && /^Closed on/.test(est.reason);
  const verdict = closed || arrive >= est.hardStop || onSiteMin <= 0 ? 'no' : onSiteMin >= est.wantStayMin ? 'fits' : 'short';
  return { ...est, arrive, onSiteMin, verdict, travel: { ...est.travel, thereMin }, routed: true };
}

/* --- Map place card ---
   app.js calls showRecommendation by name, so wrapping window.showRecommendation runs this
   each time a card is shown. The card first shows the estimate, then updates in place. */
const originalShow = window.showRecommendation;
window.showRecommendation = (i, opts) => {
  originalShow(i, opts);
  routeCard();
};

async function routeCard() {
  const results = state.results;
  const i = MAP.index;
  const fit = results && results.fitting[i];
  if (!fit || fit.routeChecked) return;
  fit.routeChecked = true;
  const mode = fit.mode || results.prefs.mode;
  const [real, altReal] = await Promise.all([
    routeMinutes(results.origin, fit.place, mode),
    fit.alt ? routeMinutes(results.origin, fit.place, fit.alt.mode) : null,
  ]);
  if (real == null && altReal == null) return;

  let next = real == null ? { ...fit } : withTravel(fit, real, results);
  // It's on the map because it fits, so if the real route is slower than that, call it short rather than drop it.
  if (next.verdict === 'no') next.verdict = 'short';
  if (fit.alt && altReal != null) next.alt = { ...fit.alt, thereMin: altReal };
  if (state.results !== results) return; // a new search replaced these results meanwhile
  results.fitting[i] = next;

  if (MAP.index === i && !$('#view-results').hidden) {
    $('#map-card').innerHTML = mapCardHTML(next, i, results);
  }
  if (next.verdict !== fit.verdict && MAP.pins[i]) MAP.pins[i].setIcon(pinIcon(next, i, MAP.index === i)); // green <-> yellow
}

window.ReachRouting = { minutes: routeMinutes, withTravel, ROUTING };
})();
