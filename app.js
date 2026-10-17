/* =====================================================================
   Reach: app.js
   "What outdoor place can I actually enjoy in the free time I have?"

   Plain JavaScript, no framework, no build step. Read top to bottom:

     1. Config & constants     <- tune speeds, weights, thresholds here
     2. Small utilities        (time math, formatting, safe storage)
     3. Data loading           (destinations.json: curated San Jose picks)
    3b. Live places            (Geoapify: any US ZIP -> nearby parks & nature)
     4. Travel time estimates  (Haversine x detour factor)
     5. Sun & opening hours
     6. Weather                (Open-Meteo, cached for offline use)
     7. Fit check              (the main feature: does it fit my window?)
     8. Escape Score           (0-100, only for places that fit)
     9. Search pipeline        (ties 4-8 together)
    10. Rendering              (cards, lists, illustrations)
   10b. Map view               (Leaflet: pins + one card at a time)
    11. Favorites              (LocalStorage)
    12. App wiring             (form, routing, theme, service worker)

   Everything is rule-based and deterministic: same inputs give the same
   results.
   ===================================================================== */
'use strict';

/* ---------------------------------------------------------------------
   1. CONFIG & CONSTANTS
   --------------------------------------------------------------------- */
const CONFIG = {
  DATA_URL: 'destinations.json',

  BUFFER_MIN: 5,           // safety buffer subtracted from your time at the place
  DETOUR_FACTOR: 1.3,      // real routes are ~30% longer than a straight line

  // Travel modes. extraThereMin / extraBackMin are fixed overheads per leg.
  MODES: {
    walking: { label: 'Walking', speedKmh: 5,  extraThereMin: 0,  extraBackMin: 0,  gmaps: 'walking', by: 'on foot' },
    driving: { label: 'Driving', speedKmh: 30, extraThereMin: 5,  extraBackMin: 0,  gmaps: 'driving', by: 'by car',
               note: 'includes 5 min to park' },
    // Transit is a rough average: bus/light-rail speed plus ~10 min per leg
    // for walking to the stop and waiting. No live schedules.
    transit: { label: 'Transit', speedKmh: 18, extraThereMin: 10, extraBackMin: 10, gmaps: 'transit', by: 'by transit',
               note: 'rough estimate incl. ~10 min to walk to the stop & wait' },
  },

  // Escape Score weights (they add up to 100).
  WEIGHTS: { activity: 35, environment: 25, amenities: 15, distance: 15, weather: 10 },

  // If getting there uses this share of your free time, the distance score is 0.
  DISTANCE_ZERO_SHARE: 0.5,

  // Weather thresholds (US units: °F, mph, inches)
  WEATHER: {
    rainProbPct: 50,      // precipitation probability that counts as "rain likely"
    rainInches: 0.01,     // or this much precipitation in an hour
    heatFeelsF: 90,
    coldFeelsF: 45,
    windMph: 20,
    gustMph: 30,
    uvHigh: 8,
    lookAheadHours: 3,    // also report rain this soon after your window ends
  },
  WEATHER_FRESH_MIN: 60,    // reuse a cached forecast for this long
  WEATHER_STALE_MIN: 720,   // when offline, fall back to a cached forecast this old
  WEATHER_TIMEOUT_MS: 7000,

  // Map tiles: Geoapify (uses the same GEOAPIFY_KEY as place search; a tile
  // costs a small fraction of a credit). {r} becomes "@2x" on high-DPI screens.
  // If Geoapify tiles fail (or there's no key), we fall back to plain
  // OpenStreetMap tiles, which need no key.
  MAP_TILES: {
    light: { url: 'https://maps.geoapify.com/v1/tile/osm-bright/{z}/{x}/{y}{r}.png?apiKey={apiKey}', maxZoom: 20, needsKey: true,
             attribution: 'Powered by <a href="https://www.geoapify.com/" target="_blank" rel="noopener">Geoapify</a> | &copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' },
    dark:  { url: 'https://maps.geoapify.com/v1/tile/dark-matter/{z}/{x}/{y}{r}.png?apiKey={apiKey}', maxZoom: 20, needsKey: true,
             attribution: 'Powered by <a href="https://www.geoapify.com/" target="_blank" rel="noopener">Geoapify</a> | &copy; <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> &copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' },
    fallback: { url: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png', maxZoom: 19,
                attribution: '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors' },
  },
  // Campus grounds that map data labels as "parks". Nothing inside these
  // circles is recommended as a park (radius in km).
  EXCLUDED_AREAS: [
    { name: 'De Anza College', lat: 37.3193, lng: -122.0448, radiusKm: 0.45 },
  ],
  CAMPUS_BUFFER_KM: 0.3,    // also skip non-"Park"-named spots this close to any college/university
  // Driving or transit to somewhere this close (straight line, miles)? Suggest walking instead.
  WALKABLE_MI: 1,
  MAP_DARK_TILES: false,    // true = dark map in dark mode (harder to read roads), false = always the bright map
  MAP_FOCUS_ZOOM: 15,       // street-level zoom when centering on a place (or on you)
};

// Time chips. 'custom' reveals a minutes input.
const TIME_OPTIONS = [
  { value: '30',  label: '30 min' },
  { value: '60',  label: '1 hr' },
  { value: '120', label: '2 hrs' },
  { value: '180', label: '3+ hrs' },
  { value: 'custom', label: 'Custom' },
];

// "How long do you want to stay?" 'custom' reveals a minutes input.
const STAY_OPTIONS = [
  { value: '15',  label: '15 min' },
  { value: '30',  label: '30 min' },
  { value: '60',  label: '1 hr' },
  { value: '120', label: '2 hrs' },
  { value: 'custom', label: 'Custom' },
];

const WHEN_OPTIONS = [
  { value: 'now',   label: 'Now' },
  { value: 'later', label: 'Later today' },
];

// Activities. `amenities` lists the amenities that matter most for each.
const ACTIVITIES = {
  relaxing:    { label: 'Relaxing',    phrase: 'relaxing',    amenities: ['benches', 'shade', 'restrooms'] },
  walking:     { label: 'Walking',     phrase: 'a walk',      amenities: ['waterFountain', 'restrooms', 'benches'] },
  hiking:      { label: 'Hiking',      phrase: 'hiking',      amenities: ['waterFountain', 'restrooms'] },
  exercise:    { label: 'Exercise',    phrase: 'a workout',   amenities: ['waterFountain', 'restrooms'] },
  picnic:      { label: 'Picnic',      phrase: 'a picnic',    amenities: ['benches', 'shade', 'restrooms', 'waterFountain'] },
  // Used automatically for "Study spots" (not shown as a choice).
  studying:    { label: 'Studying',    phrase: 'studying',    amenities: ['wifi', 'restrooms'], hidden: true },
};

// Short tip shown after "Great for ..." on a card.
const ACTIVITY_TIPS = {
  relaxing: 'Find a bench or a shady spot and unplug.',
  walking: 'An easy loop here clears your head.',
  hiking: 'Bring water and wear good shoes.',
  exercise: 'Room for a run or a quick workout.',
  picnic: 'Bring a blanket and something to share.',
  studying: 'Grab a seat and settle in.',
};

// "Looking for": parks (outdoor) or study spots (libraries & cafes).
const KIND_OPTIONS = [
  { value: 'parks', label: 'Parks' },
  { value: 'study', label: 'Study spots' },
  { value: 'food', label: 'Food' }, // restaurants, fast food, food courts (searched by places.js)
];

// match = shown when it matches; miss = when it doesn't; has = used for "..., though it's quiet."
const ENVIRONMENTS = {
  'quiet':      { label: 'Quiet',      match: 'Quiet and calm, easy to unwind.',           miss: 'Can get busy, so not especially quiet', has: "it's quiet" },
  'scenic':     { label: 'Scenic',     match: 'Scenic views worth stopping for.',          miss: 'Pleasant, but not especially scenic',    has: "it's scenic" },
  'water':      { label: 'Water',      match: 'Water nearby to sit and watch.',            miss: 'No water features here',                 has: 'it has water nearby' },
  'forest':     { label: 'Forest',     match: 'Plenty of trees and shade.',                miss: 'Not much forest here',                   has: 'it has plenty of trees' },
  'garden':     { label: 'Garden',     match: 'Garden paths with lots to look at.',        miss: 'Not a garden setting',                   has: 'it has garden areas' },
  'open field': { label: 'Open field', match: 'Wide-open lawns with room to spread out.', miss: 'No big open field here',                 has: 'it has open lawns' },
};

// Partial credit when the exact preference isn't there (symmetric, 0-1).
const RELATED_ACTIVITIES = {
  'walking|hiking': 0.6, 'walking|exercise': 0.5, 'hiking|exercise': 0.5,
  'relaxing|picnic': 0.6,
};
const RELATED_ENVIRONMENTS = {
  'quiet|forest': 0.5, 'quiet|garden': 0.5, 'scenic|water': 0.5, 'scenic|garden': 0.4,
  'scenic|forest': 0.4, 'forest|garden': 0.3, 'open field|scenic': 0.3,
};

const AMENITY_LABELS = {
  restrooms: 'restrooms', benches: 'benches', shade: 'shade',
  waterFountain: 'water fountain', parking: 'parking', wifi: 'Wi-Fi',
};
const PARK_AMENITIES = ['restrooms', 'benches', 'shade', 'waterFountain', 'parking'];
const STUDY_AMENITIES = ['wifi', 'restrooms', 'parking'];
const isStudyPlace = (p) => p.type === 'library' || p.type === 'cafe';

const TYPE_LABELS = { 'park': 'Park', 'garden': 'Garden', 'trail': 'Trail', 'scenic area': 'Scenic area', 'library': 'Library', 'cafe': 'Cafe' };

// Places where being out after dark is a problem (unlit trails, hillsides).
const DARK_SENSITIVE_TYPES = ['trail', 'scenic area'];

// How strongly bad weather affects a place (multiplier on weather penalties).
const EXPOSURE_FACTOR = { exposed: 1, partial: 0.6, sheltered: 0.3, indoor: 0 };

const STORAGE_KEYS = {
  favorites: 'greenescape.favorites',
  prefs: 'greenescape.prefs',
  theme: 'greenescape.theme',
  weatherPrefix: 'greenescape.weather.',
  zipPrefix: 'greenescape.zip.',
  placesCache: 'greenescape.places',
  parkingPrefix: 'greenescape.parking.',
  schedule: 'greenescape.schedule',
  tests: 'greenescape.tests',
  welcomed: 'greenescape.welcomed',
};

const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

/* ---------------------------------------------------------------------
   2. SMALL UTILITIES
   --------------------------------------------------------------------- */

/** LocalStorage wrapper: never throws (private mode, blocked storage, full quota). */
const store = {
  get(key, fallback) {
    try {
      const raw = localStorage.getItem(key);
      return raw == null ? fallback : JSON.parse(raw);
    } catch (err) {
      return fallback;
    }
  },
  set(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(value));
      return true;
    } catch (err) {
      return false;
    }
  },
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));
const addMin = (date, min) => new Date(date.getTime() + min * 60000);
const minutesBetween = (a, b) => (b.getTime() - a.getTime()) / 60000;
const minDate = (...ds) => new Date(Math.min(...ds.map((d) => d.getTime())));
const maxDate = (...ds) => new Date(Math.max(...ds.map((d) => d.getTime())));

/** Escape text before putting it into HTML strings. */
function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/** "3:05 PM" (adds "tomorrow" if the date isn't today) */
function fmtTime(date, { hourOnly = false, relativeDay = true } = {}) {
  const opts = hourOnly ? { hour: 'numeric' } : { hour: 'numeric', minute: '2-digit' };
  const text = date.toLocaleTimeString([], opts);
  if (!relativeDay) return text;
  const today = new Date();
  const tomorrow = addMin(new Date(today.getFullYear(), today.getMonth(), today.getDate()), 24 * 60);
  if (date >= tomorrow && date < addMin(tomorrow, 24 * 60)) return `${text} tomorrow`;
  return text;
}

/** "45 min", "1 hr", "1 hr 30 min" */
function fmtDuration(min) {
  const m = Math.round(min);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const rest = m % 60;
  return rest ? `${h} hr ${rest} min` : `${h} hr`;
}

const kmToMi = (km) => km * 0.621371;

/** "restrooms, benches and shade" */
function listText(items) {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`;
}

const capitalize = (s) => s.charAt(0).toUpperCase() + s.slice(1);

/** YYYY-MM-DD in the device's local time zone. */
function localDateKey(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Look up a symmetric "a|b" pair in a relatedness table. */
function relatedness(table, a, b) {
  if (a === b) return 1;
  return table[`${a}|${b}`] ?? table[`${b}|${a}`] ?? 0;
}

/** Simple string hash, used to vary the illustrations deterministically. */
function hashString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** fetch() + JSON with a timeout. */
async function fetchJson(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/* ---------------------------------------------------------------------
   3. DATA LOADING
   --------------------------------------------------------------------- */
const state = {
  data: null,        // full destinations.json
  curated: [],       // data.destinations: hand-picked San Jose places
  zips: {},          // data.area.zipCodes: offline fallback for San Jose ZIPs
  index: new Map(),  // id -> place, for every place we've seen (curated, live, favorites)
  results: null,     // last search results (see runSearch)
};

async function loadData() {
  const data = await fetchJson(CONFIG.DATA_URL, 10000);
  state.data = data;
  state.curated = (data.destinations || []).map((p) => ({
    ...p, source: 'curated', activities: (p.activities || []).filter((a) => ACTIVITIES[a]),
  }));
  state.zips = (data.area && data.area.zipCodes) || {};
  indexPlaces(state.curated);
  return data;
}

function indexPlaces(places) {
  places.forEach((p) => state.index.set(p.id, p));
}

const findPlace = (id) => state.index.get(id);

/* ---------------------------------------------------------------------
   3b. LIVE PLACES (Geoapify)
   1) ZIP -> coordinates with the Geocoding API.
   2) Parks & nature around it with the Places API (OpenStreetMap data).
   OpenStreetMap doesn't know visit lengths, and often lacks hours or
   amenities, so those are ESTIMATED from each place's category and name,
   and "not listed" amenities score as unknown (half credit).
   --------------------------------------------------------------------- */

const GEO = {
  key: ((window.GREENESCAPE_CONFIG && window.GREENESCAPE_CONFIG.GEOAPIFY_KEY) || '').trim(),
  geocodeUrl: 'https://api.geoapify.com/v1/geocode/search',
  placesUrl: 'https://api.geoapify.com/v2/places',
  // What each "Looking for" choice searches. Parks: everyday parks closest to
  // you, plus bigger preserves across the whole radius (so they aren't crowded
  // out). College/university points are fetched only to filter campus "parks" out.
  kinds: {
    parks: {
      nearby: ['leisure.park', 'education.college', 'education.university'],
      nature: ['leisure.park.nature_reserve', 'national_park'],
      safe: ['leisure.park', 'national_park'], // retried if the API rejects a category name
    },
    study: {
      nearby: ['education.library', 'catering.cafe'],
      safe: ['education.library'],
    },
  },
  nearbyLimit: 60,
  natureLimit: 40,
  radiusBucketsKm: [1.5, 3, 5, 8, 12, 20, 30, 40], // rounding radii up = more cache hits
  cacheDays: 7,
  cacheEntries: 6,
};

// Skip things that show up as "parks" but aren't an escape.
const EXCLUDED_NAMES = /\b(dog park|dog run|playground|tot lot|skate ?park|parking|ball ?fields?|golf)\b/i;
// Campus grounds (quads, sunken gardens...) that map data calls "parks".
const CAMPUS_WORDS = /\b(college|university|campus)\b/i;

// Estimated visit lengths (minutes) for places without curated data.
const DEFAULT_VISIT = {
  relaxing: { min: 15, typical: 40 }, walking: { min: 20, typical: 45 }, hiking: { min: 60, typical: 120 },
  exercise: { min: 25, typical: 45 }, picnic: { min: 30, typical: 60 },
  studying: { min: 30, typical: 90 },
  default: { min: 20, typical: 40 },
};

/** Thrown for problems the user can fix (shown next to the ZIP field). */
class SearchError extends Error {
  constructor(message) { super(message); this.name = 'SearchError'; }
}

/** ZIP -> { zip, lat, lng, label }. Cached forever (ZIP centers don't move). */
async function resolveZip(zip) {
  const cacheKey = `${STORAGE_KEYS.zipPrefix}${zip}`;
  const cached = store.get(cacheKey, null);
  if (cached && Number.isFinite(cached.lat)) return cached;
  const local = state.zips[zip] ? { zip, ...state.zips[zip] } : null;

  if (GEO.key) {
    try {
      const params = new URLSearchParams({
        text: zip, type: 'postcode', filter: 'countrycode:us', format: 'json', limit: '1', apiKey: GEO.key,
      });
      const data = await fetchJson(`${GEO.geocodeUrl}?${params}`, 8000);
      const r = (data.results || [])[0];
      if (r && Number.isFinite(r.lat) && (r.postcode === zip || r.result_type === 'postcode')) {
        const label = [r.city || r.county, r.state_code || r.state].filter(Boolean).join(', ') || r.formatted || zip;
        const origin = { zip, lat: r.lat, lng: r.lon, label };
        store.set(cacheKey, origin);
        return origin;
      }
      if (!local) throw new SearchError(`We couldn't find ZIP ${zip}. Double-check it and try again.`);
    } catch (err) {
      if (err instanceof SearchError) throw err;
      console.warn('[Reach] ZIP lookup failed:', err.message);
      if (!local) {
        throw new SearchError(err.status === 401 || err.status === 403
          ? 'The Geoapify API key was rejected. Check GEOAPIFY_KEY in config.js.'
          : `Couldn't look up ZIP ${zip} (are you offline?). San Jose ZIPs still work offline.`);
      }
    }
  }
  if (local) return local;
  throw new SearchError('Live search is off (no Geoapify key in config.js), so only San Jose ZIPs work right now.');
}

/** How far away a place could possibly fit, given time and mode (km, straight line). */
function searchRadiusKm(prefs) {
  const mode = CONFIG.MODES[prefs.mode];
  // No trip back is counted, so anything you can reach before your time runs out is a candidate.
  const oneWayMin = prefs.freeMin - CONFIG.BUFFER_MIN - 1 - mode.extraThereMin;
  const km = (Math.max(0, oneWayMin) / 60) * mode.speedKmh / CONFIG.DETOUR_FACTOR;
  return clamp(km, GEO.radiusBucketsKm[0], GEO.radiusBucketsKm[GEO.radiusBucketsKm.length - 1]);
}

/** One Places API request. Retries with safe categories if the API rejects one. */
async function fetchPlaces(categories, origin, radiusKm, limit, safe) {
  const url = (cats) => `${GEO.placesUrl}?${new URLSearchParams({
    categories: cats.join(','),
    filter: `circle:${origin.lng},${origin.lat},${Math.round(radiusKm * 1000)}`,
    bias: `proximity:${origin.lng},${origin.lat}`,
    limit: String(limit),
    apiKey: GEO.key,
  })}`;
  try {
    const data = await fetchJson(url(categories), 12000);
    return data.features || [];
  } catch (err) {
    if (err.status === 400 && safe && categories !== safe) {
      console.warn('[Reach] Places API rejected categories, retrying with safe list:', categories.join(','));
      const data = await fetchJson(url(safe), 12000);
      return data.features || [];
    }
    throw err;
  }
}

const isCampusFeature = (f) => ((f.properties && f.properties.categories) || []).some((c) => c.startsWith('education.college') || c.startsWith('education.university'));

/** Is this place on campus grounds? (explicit no-recommend areas, or right at a college that isn't a named park) */
function isOnCampus(place, campuses) {
  if (CONFIG.EXCLUDED_AREAS.some((a) => haversineKm(a, place) <= a.radiusKm)) return true;
  if (/\bpark\b/i.test(place.name)) return false;
  return campuses.some((c) => haversineKm(c, place) <= CONFIG.CAMPUS_BUFFER_KM);
}

/** Live places near the origin -> { places, status: live|cache|stale|nokey|badkey|offline } */
async function searchLivePlaces(origin, radiusKm, kind = 'parks') {
  if (!GEO.key) return { places: [], status: 'nokey' };
  const cfg = GEO.kinds[kind] || GEO.kinds.parks;
  const bucket = GEO.radiusBucketsKm.find((b) => b >= radiusKm) || radiusKm;
  const key = `${kind}:${origin.lat.toFixed(3)},${origin.lng.toFixed(3)},${bucket}`;
  const cache = store.get(STORAGE_KEYS.placesCache, {}) || {};
  const hit = cache[key];
  if (hit && Date.now() - hit.fetchedAt < GEO.cacheDays * 864e5) {
    return { places: hit.places, status: 'cache', radiusKm: bucket };
  }
  try {
    const requests = [fetchPlaces(cfg.nearby, origin, bucket, GEO.nearbyLimit, cfg.safe)];
    if (cfg.nature) requests.push(fetchPlaces(cfg.nature, origin, bucket, GEO.natureLimit, cfg.safe));
    const features = (await Promise.all(requests)).reverse().flat(); // bigger nature spots first
    const campuses = features.filter(isCampusFeature).map((f) => ({
      lat: f.properties.lat ?? f.geometry.coordinates[1], lng: f.properties.lon ?? f.geometry.coordinates[0],
    }));
    let places = features.filter((f) => !isCampusFeature(f)).map((f) => normalizeFeature(f, kind)).filter(Boolean);
    if (kind === 'parks') places = places.filter((p) => !isOnCampus(p, campuses));
    places = dedupePlaces(places);
    // Keep only the most recent few searches so LocalStorage doesn't fill up.
    cache[key] = { fetchedAt: Date.now(), places };
    const keep = Object.entries(cache).sort((a, b) => b[1].fetchedAt - a[1].fetchedAt).slice(0, GEO.cacheEntries);
    store.set(STORAGE_KEYS.placesCache, Object.fromEntries(keep));
    return { places, status: 'live', radiusKm: bucket };
  } catch (err) {
    console.warn('[Reach] Place search failed:', err.message);
    if (hit) return { places: hit.places, status: 'stale', radiusKm: bucket };
    return { places: [], status: err.status === 401 || err.status === 403 ? 'badkey' : 'offline', radiusKm: bucket };
  }
}

/** 'yes'/true -> true, 'no'/false -> false, anything else -> null (unknown) */
function triState(v) {
  if (v === true || v === 'yes' || v === 'designated') return true;
  if (v === false || v === 'no') return false;
  return null;
}

/** Guess type, environment, activities and exposure from Geoapify categories + the name. */
function classifyPlace(categories, name) {
  const has = (prefix) => categories.some((c) => c === prefix || c.startsWith(`${prefix}.`));
  let k;
  if (has('national_park')) {
    k = { type: 'scenic area', label: 'National park', environment: ['scenic', 'quiet'], activities: ['hiking', 'walking', 'picnic'], exposure: 'partial', shade: null };
  } else if (has('leisure.park.nature_reserve') || has('natural.protected_area')) {
    k = { type: 'trail', label: 'Nature preserve', environment: ['quiet', 'scenic'], activities: ['hiking', 'walking'], exposure: 'partial', shade: null };
  } else if (has('natural.forest')) {
    k = { type: 'trail', label: 'Forest', environment: ['forest', 'quiet'], activities: ['hiking', 'walking'], exposure: 'sheltered', shade: true };
  } else if (has('beach')) {
    k = { type: 'scenic area', label: 'Beach', environment: ['water', 'scenic', 'open field'], activities: ['relaxing', 'walking', 'picnic'], exposure: 'exposed', shade: false };
  } else if (has('tourism.attraction.viewpoint')) {
    k = { type: 'scenic area', label: 'Viewpoint', environment: ['scenic'], activities: ['relaxing'], exposure: 'exposed', shade: false };
  } else if (has('leisure.park.garden')) {
    k = { type: 'garden', label: 'Garden', environment: ['garden', 'quiet'], activities: ['relaxing', 'walking'], exposure: 'partial', shade: null };
  } else {
    k = { type: 'park', label: 'Park', environment: ['open field'], activities: ['relaxing', 'walking', 'picnic', 'exercise'], exposure: 'partial', shade: null };
  }

  // Name hints add tags OpenStreetMap categories miss.
  const n = name.toLowerCase();
  const add = (list, ...items) => items.forEach((i) => { if (!list.includes(i)) list.push(i); });
  if (/\b(lake|creek|river|pond|bay|lagoon|falls|reservoir|marsh|slough|harbou?r|shore|waterfront|springs?)\b/.test(n)) add(k.environment, 'water');
  if (/\b(forest|woods?|woodlands?|grove|redwoods?|oaks?|pines?)\b/.test(n)) add(k.environment, 'forest');
  if (/\b(gardens?|arboretum|botanic(al)?|rose)\b/.test(n)) { add(k.environment, 'garden', 'quiet'); add(k.activities, 'relaxing'); }
  if (/\b(trails?|preserve|open space|canyon|ridge|hills?|mountain|peak|regional park|state park|county park|wilderness)\b/.test(n)) {
    add(k.environment, 'scenic');
    add(k.activities, 'hiking');
    if (k.type === 'park' && /\b(trails?|preserve|open space|canyon|ridge|wilderness)\b/.test(n)) k.type = 'trail';
  }
  return k;
}

/** Libraries & cafes for "Study spots". Libraries are quiet; cafes can get busy. */
function classifyStudy(categories) {
  const has = (prefix) => categories.some((c) => c === prefix || c.startsWith(`${prefix}.`));
  if (has('education.library')) {
    return { type: 'library', label: 'Library', environment: ['quiet'], activities: ['studying'], exposure: 'indoor', shade: true,
             visit: { studying: { min: 30, typical: 90 } }, blurb: 'Usually quiet, with seats for studying.' };
  }
  return { type: 'cafe', label: 'Cafe', environment: [], activities: ['studying'], exposure: 'indoor', shade: true,
           visit: { studying: { min: 30, typical: 75 } }, blurb: 'Good for coffee and some work. Can get busy.' };
}

/** Wi-Fi from map tags: "wlan"/"yes" = has it, "no" = doesn't. */
function wifiState(v) {
  if (v === true || /^(wlan|yes|wifi|free|customers)$/i.test(String(v || ''))) return true;
  if (v === false || v === 'no') return false;
  return null;
}

/** Parse simple OpenStreetMap opening_hours ("Mo-Su 06:00-22:00", "sunrise-sunset", "24/7"). */
function parseOsmHours(str) {
  if (!str || typeof str !== 'string') return null;
  const s = str.trim();
  if (/^24\/7$/.test(s)) return { open: '00:00', close: '24:00', raw: s };
  if (/^(sunrise|dawn)\s*-\s*(sunset|dusk)$/i.test(s)) return { open: 'sunrise', close: 'sunset', raw: s };

  const OSM_DAYS = ['su', 'mo', 'tu', 'we', 'th', 'fr', 'sa'];
  const normTime = (t) => {
    const low = t.toLowerCase();
    if (low === 'dawn' || low === 'sunrise') return 'sunrise';
    if (low === 'dusk' || low === 'sunset') return 'sunset';
    const [h, m] = t.split(':');
    return `${h.padStart(2, '0')}:${m}`;
  };
  const expandDays = (spec) => {
    const out = [];
    spec.split(',').map((x) => x.trim().toLowerCase()).forEach((part) => {
      const [a, b] = part.split('-').map((x) => OSM_DAYS.indexOf(x.trim()));
      if (a < 0) return;
      if (b === undefined || b < 0) { out.push(a); return; }
      for (let d = a; ; d = (d + 1) % 7) { out.push(d); if (d === b) break; }
    });
    return out;
  };

  const DAY = '(?:Mo|Tu|We|Th|Fr|Sa|Su)';
  const TIME = '(\\d{1,2}:\\d{2}|sunrise|sunset|dawn|dusk)';
  const RULE = new RegExp(`^(?:(${DAY}(?:\\s*[-,]\\s*${DAY})*)\\s+)?(?:(off|closed)|${TIME}\\s*-\\s*${TIME})$`, 'i');
  const byDay = {};
  for (const rule of s.split(';').map((r) => r.trim()).filter(Boolean)) {
    const m = RULE.exec(rule);
    if (!m) return null; // holidays, months, split shifts... too complex: treat as "not listed"
    const days = m[1] ? expandDays(m[1]) : [0, 1, 2, 3, 4, 5, 6];
    const value = m[2] ? null : { open: normTime(m[3]), close: normTime(m[4]) };
    days.forEach((d) => { byDay[DAY_KEYS[d]] = value; });
  }
  DAY_KEYS.forEach((k) => { if (!(k in byDay)) byDay[k] = null; }); // days not mentioned are closed
  return { byDay, raw: s };
}

/** Geoapify GeoJSON feature -> Reach place (same shape as destinations.json entries). */
function normalizeFeature(feature, kind = 'parks') {
  const p = (feature && feature.properties) || {};
  const raw = (p.datasource && p.datasource.raw) || {};
  const fac = p.facilities || {};
  const name = String(p.name || raw.name || '').trim();
  const study = kind === 'study';
  if (!name || (!study && EXCLUDED_NAMES.test(name))) return null;
  if (raw.access === 'private' || raw.access === 'no') return null;
  // Campus grounds labeled as parks (e.g. a college's quad or sunken garden)
  if (!study && ((CAMPUS_WORDS.test(name) && !/\bpark\b/i.test(name))
    || CAMPUS_WORDS.test(String(raw.operator || '')) || CAMPUS_WORDS.test(String(p.address_line2 || p.formatted || '')))) return null;

  const coords = (feature.geometry && feature.geometry.coordinates) || [];
  const lat = Number.isFinite(p.lat) ? p.lat : coords[1];
  const lng = Number.isFinite(p.lon) ? p.lon : coords[0];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

  const k = study ? classifyStudy(p.categories || []) : classifyPlace(p.categories || [], name);
  const wheelchair = triState(fac.wheelchair ?? raw.wheelchair);
  const hours = parseOsmHours(p.opening_hours || raw.opening_hours)
    || (study ? { open: '09:00', close: '18:00', assumed: true } : { open: 'sunrise', close: 'sunset+30', assumed: true });
  const amenities = {
    restrooms: triState(fac.toilets ?? raw.toilets),
    benches: triState(raw.bench),
    shade: k.shade,
    waterFountain: triState(fac.drinking_water ?? raw.drinking_water),
    parking: triState(raw.parking === undefined ? undefined : raw.parking !== 'no'),
    wifi: wifiState(raw.internet_access ?? fac.internet_access),
  };
  const listed = (study ? STUDY_AMENITIES : PARK_AMENITIES).filter((a) => amenities[a] === true).map((a) => AMENITY_LABELS[a]);

  return {
    id: `geo-${p.place_id || `${lat.toFixed(5)}_${lng.toFixed(5)}`}`,
    name,
    lat,
    lng,
    address: p.address_line2 || p.formatted || [p.city, p.state_code].filter(Boolean).join(', '),
    city: p.city || '',
    type: k.type,
    kindLabel: k.label,
    environment: k.environment,
    activities: k.activities,
    amenities,
    hours,
    visitMinutes: { ...DEFAULT_VISIT, ...(k.visit || {}) },
    exposure: k.exposure,
    accessibility: wheelchair === true ? 'Listed as wheelchair accessible.' : wheelchair === false ? 'Listed as not wheelchair accessible.' : 'Accessibility not listed.',
    description: [`${k.label}${p.city ? ` in ${p.city}` : ''}.`, k.blurb, listed.length ? `Has ${listText(listed)}.` : '']
      .filter(Boolean).join(' '),
    website: p.website || raw.website || '',
    photo: '',
    source: 'live',
  };
}

const normName = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();

/** Drop duplicates: same id, or same name within 1.5 km (e.g. a park listed twice). */
function dedupePlaces(places) {
  const out = [];
  places.forEach((p) => {
    const dup = out.some((q) => q.id === p.id || (normName(q.name) === normName(p.name) && haversineKm(q, p) < 1.5));
    if (!dup) out.push(p);
  });
  return out;
}

/* --- Driving start point ---
   In driving mode Google Maps snaps "Your location" to the nearest road a car
   can use. On a campus or in a big park that can be a freeway. So when you
   drive from your current location, directions start at the nearest car
   parking lot instead (that's where your drive really starts). */
const PARKING = { categories: ['parking.cars'], safe: ['parking'], radiusKm: 0.5, limit: 15, cacheHours: 24 };

async function findStartParking(origin) {
  if (!GEO.key || origin.source !== 'location') return null;
  const here = origin.precise || origin;
  const key = `${STORAGE_KEYS.parkingPrefix}${here.lat.toFixed(4)},${here.lng.toFixed(4)}`;
  const cached = store.get(key, null);
  if (cached && Date.now() - cached.at < PARKING.cacheHours * 3600e3) return cached.lot;
  try {
    const features = await fetchPlaces(PARKING.categories, here, PARKING.radiusKm, PARKING.limit, PARKING.safe);
    const lots = features.map((f) => {
      const p = f.properties || {};
      const raw = (p.datasource && p.datasource.raw) || {};
      const cats = p.categories || [];
      const lat = Number.isFinite(p.lat) ? p.lat : f.geometry && f.geometry.coordinates[1];
      const lng = Number.isFinite(p.lon) ? p.lon : f.geometry && f.geometry.coordinates[0];
      return { name: String(p.name || raw.name || '').trim(), lat, lng, cats, access: raw.access };
    }).filter((l) => Number.isFinite(l.lat) && Number.isFinite(l.lng)
      && !['private', 'no'].includes(l.access)
      && !l.cats.some((c) => /bicycle|motorcycle/.test(c)))
      .map((l) => ({ ...l, km: haversineKm(here, l) }))
      .filter((l) => l.km <= PARKING.radiusKm)
      .sort((a, b) => a.km - b.km);
    const best = lots[0];
    const lot = best ? { name: best.name, lat: best.lat, lng: best.lng, km: best.km } : null;
    store.set(key, { at: Date.now(), lot });
    return lot;
  } catch (err) {
    console.warn('[Reach] Parking lookup failed:', err.message);
    return null;
  }
}

/** Curated places near the origin (parks only) + live places that aren't already curated. */
function mergePlaces(origin, radiusKm, livePlaces, kind = 'parks') {
  const curated = kind === 'parks'
    ? state.curated.filter((p) => haversineKm(origin, p) <= radiusKm * 1.5 && !isOnCampus(p, []))
    : [];
  const live = livePlaces.filter((lp) => !curated.some((cp) =>
    haversineKm(cp, lp) < 0.4 || normName(cp.name) === normName(lp.name)));
  return [...curated, ...live];
}

/* ---------------------------------------------------------------------
   4. TRAVEL TIME ESTIMATES
   Straight-line (Haversine) distance x 1.3 detour factor, divided by an
   average speed for the mode, plus fixed overheads (parking, waiting).
   --------------------------------------------------------------------- */

/** Great-circle distance in km between {lat,lng} points. */
function haversineKm(a, b) {
  const R = 6371;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2
          + Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Estimated one-way travel minutes (rounded up) to a place. */
function estimateTravel(origin, place, modeKey) {
  const mode = CONFIG.MODES[modeKey];
  const straightKm = haversineKm(origin, place);
  const routeKm = straightKm * CONFIG.DETOUR_FACTOR;
  const movingMin = (routeKm / mode.speedKmh) * 60;
  return {
    straightKm,
    routeKm,
    thereMin: Math.max(1, Math.ceil(movingMin + mode.extraThereMin)),
    backMin: Math.max(1, Math.ceil(movingMin + mode.extraBackMin)),
  };
}

/* ---------------------------------------------------------------------
   5. SUN & OPENING HOURS
   --------------------------------------------------------------------- */

/**
 * Offline fallback for sunrise/sunset (standard "sunrise equation",
 * accurate to a few minutes). Used only when Open-Meteo is unavailable.
 */
function calcSunTimes(date, lat, lng) {
  const rad = Math.PI / 180;
  const y = date.getFullYear(), mo = date.getMonth(), d = date.getDate();
  const dayOfYear = Math.round((new Date(y, mo, d) - new Date(y, 0, 0)) / 864e5);
  const lngHour = lng / 15;

  const calc = (rising) => {
    const t = dayOfYear + ((rising ? 6 : 18) - lngHour) / 24;
    const M = 0.9856 * t - 3.289;
    let L = M + 1.916 * Math.sin(M * rad) + 0.02 * Math.sin(2 * M * rad) + 282.634;
    L = ((L % 360) + 360) % 360;
    let RA = ((Math.atan(0.91764 * Math.tan(L * rad)) / rad) + 360) % 360;
    RA = (RA + Math.floor(L / 90) * 90 - Math.floor(RA / 90) * 90) / 15;
    const sinDec = 0.39782 * Math.sin(L * rad);
    const cosDec = Math.cos(Math.asin(sinDec));
    const cosH = (Math.cos(90.833 * rad) - sinDec * Math.sin(lat * rad)) / (cosDec * Math.cos(lat * rad));
    if (cosH > 1 || cosH < -1) return null; // polar day/night: not an issue in San Jose
    let H = Math.acos(cosH) / rad;
    if (rising) H = 360 - H;
    const T = H / 15 + RA - 0.06571 * t - 6.622;
    const UT = (((T - lngHour) % 24) + 24) % 24;
    // UT is hours after UTC midnight; pick the day that lands closest to local noon.
    let ms = Date.UTC(y, mo, d) + UT * 3600e3;
    const noon = new Date(y, mo, d, 12).getTime();
    while (ms < noon - 12 * 3600e3) ms += 864e5;
    while (ms > noon + 12 * 3600e3) ms -= 864e5;
    return new Date(ms);
  };

  return {
    sunrise: calc(true) || new Date(y, mo, d, 6, 30),
    sunset: calc(false) || new Date(y, mo, d, 18, 30),
  };
}

/** Sunrise/sunset for a date: Open-Meteo when available, otherwise calculated. */
function getSun(date, weather, origin) {
  const daily = weather && weather.forecast && weather.forecast.daily;
  if (daily && Array.isArray(daily.time)) {
    const key = localDateKey(date);
    const i = daily.time.findIndex((t) => localDateKey(new Date(t * 1000)) === key);
    if (i >= 0 && daily.sunset[i] && daily.sunrise[i]) {
      return { sunrise: new Date(daily.sunrise[i] * 1000), sunset: new Date(daily.sunset[i] * 1000), source: 'Open-Meteo' };
    }
  }
  return { ...calcSunTimes(date, origin.lat, origin.lng), source: 'calculated' };
}

/**
 * Turn an hours spec into a Date on the given day.
 * Accepts "08:30", "sunset", "sunrise", "sunset+30", "sunset-15".
 */
function resolveClock(spec, day, sun) {
  const m = /^(sunrise|sunset)\s*([+-])?\s*(\d+)?$/i.exec(String(spec).trim());
  if (m) {
    const base = sun[m[1].toLowerCase()];
    const offset = m[3] ? Number(m[3]) * (m[2] === '-' ? -1 : 1) : 0;
    return addMin(base, offset);
  }
  const [h, min] = String(spec).split(':').map(Number);
  const d = new Date(day);
  d.setHours(h, min || 0, 0, 0); // "24:00" correctly rolls to midnight
  return d;
}

/** Human-readable hours spec: "8:00 AM", "30 min after sunset" */
function describeClock(spec) {
  const m = /^(sunrise|sunset)\s*([+-])?\s*(\d+)?$/i.exec(String(spec).trim());
  if (m) {
    if (!m[3]) return m[1].toLowerCase();
    return `${m[3]} min ${m[2] === '-' ? 'before' : 'after'} ${m[1].toLowerCase()}`;
  }
  const [h, min] = String(spec).split(':').map(Number);
  const d = new Date();
  d.setHours(h, min || 0, 0, 0);
  return fmtTime(d, { relativeDay: false });
}

/** Opening hours for a specific day -> { open, close, closed } (specs, not Dates). */
function hoursOn(place, date) {
  const h = place.hours || {};
  const day = DAY_KEYS[date.getDay()];
  if (h.byDay) {
    const d = h.byDay[day];
    return d ? { open: d.open, close: d.close, closed: false } : { open: '00:00', close: '00:00', closed: true };
  }
  return { open: h.open || '00:00', close: h.close || '24:00', closed: (h.closedDays || []).includes(day) };
}

/* ---------------------------------------------------------------------
   6. WEATHER (Open-Meteo: free, no API key)
   We fetch the hourly forecast for the user's ZIP center and cache it in
   LocalStorage so the app still works (with an older forecast) offline.
   --------------------------------------------------------------------- */

function weatherUrl(origin) {
  const params = new URLSearchParams({
    latitude: origin.lat.toFixed(4),
    longitude: origin.lng.toFixed(4),
    hourly: [
      'temperature_2m', 'apparent_temperature', 'precipitation_probability', 'precipitation',
      'weather_code', 'wind_speed_10m', 'wind_gusts_10m', 'uv_index',
    ].join(','),
    daily: 'sunrise,sunset',
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    timeformat: 'unixtime',
    forecast_days: '3',
  });
  return `https://api.open-meteo.com/v1/forecast?${params}`;
}

/**
 * Returns { forecast, fetchedAt, source: 'live'|'cache'|'stale' } or null.
 */
async function getWeather(origin) {
  const key = `${STORAGE_KEYS.weatherPrefix}${origin.lat.toFixed(2)},${origin.lng.toFixed(2)}`;
  const cached = store.get(key, null);
  const ageMin = cached ? (Date.now() - cached.fetchedAt) / 60000 : Infinity;

  if (cached && ageMin < CONFIG.WEATHER_FRESH_MIN) {
    return { forecast: cached.forecast, fetchedAt: cached.fetchedAt, source: 'cache' };
  }
  try {
    const forecast = await fetchJson(weatherUrl(origin), CONFIG.WEATHER_TIMEOUT_MS);
    if (!forecast.hourly || !Array.isArray(forecast.hourly.time)) throw new Error('Unexpected forecast format');
    const fetchedAt = Date.now();
    store.set(key, { fetchedAt, forecast });
    return { forecast, fetchedAt, source: 'live' };
  } catch (err) {
    console.warn('[Reach] Weather unavailable:', err.message);
    if (cached && ageMin < CONFIG.WEATHER_STALE_MIN) {
      return { forecast: cached.forecast, fetchedAt: cached.fetchedAt, source: 'stale' };
    }
    return null;
  }
}

/** Convert Open-Meteo's parallel arrays into one object per hour. */
function hourlyRows(forecast) {
  const h = forecast.hourly;
  return h.time.map((t, i) => ({
    t: new Date(t * 1000),
    temp: h.temperature_2m?.[i],
    feels: h.apparent_temperature?.[i] ?? h.temperature_2m?.[i],
    pop: h.precipitation_probability?.[i] ?? 0,
    precip: h.precipitation?.[i] ?? 0,
    code: h.weather_code?.[i] ?? 0,
    wind: h.wind_speed_10m?.[i] ?? 0,
    gust: h.wind_gusts_10m?.[i] ?? 0,
    uv: h.uv_index?.[i] ?? 0,
  }));
}

/** WMO weather codes -> short label + emoji */
function describeWeatherCode(code) {
  if (code === 0) return { label: 'clear' };
  if (code <= 2) return { label: 'partly cloudy' };
  if (code === 3) return { label: 'overcast' };
  if (code === 45 || code === 48) return { label: 'foggy' };
  if (code >= 51 && code <= 57) return { label: 'drizzle' };
  if (code >= 61 && code <= 67) return { label: 'rain' };
  if (code >= 71 && code <= 77) return { label: 'snow' };
  if (code >= 80 && code <= 82) return { label: 'showers' };
  if (code >= 85 && code <= 86) return { label: 'snow showers' };
  if (code >= 95) return { label: 'thunderstorms' };
  return { label: 'mixed' };
}

/**
 * Check the user's time window [start, end) for rain, heat, cold, wind and UV.
 * Returns flags (used by scoring) and friendly messages (shown in the banner).
 */
function analyzeWeather(weather, start, end) {
  const T = CONFIG.WEATHER;
  if (!weather) {
    return {
      available: false, flags: {},
      messages: [{ level: 'info', text: "Couldn't load the weather (offline?). Scores assume average conditions, so check the sky before you go." }],
    };
  }

  const rows = hourlyRows(weather.forecast);
  // An hourly row covers [t, t + 1h), so include any hour that overlaps the window.
  const inWindow = rows.filter((r) => r.t.getTime() + 3600e3 > start.getTime() && r.t < end);
  if (!inWindow.length) {
    return {
      available: false, flags: {},
      messages: [{ level: 'info', text: "The forecast doesn't cover that time yet. Scores assume average conditions." }],
    };
  }

  const isRainy = (r) => r.pop >= T.rainProbPct || r.precip >= T.rainInches;
  const rainHour = inWindow.find(isRainy);
  const lookAheadEnd = addMin(end, T.lookAheadHours * 60);
  const rainAfter = rainHour ? null : rows.find((r) => r.t >= end && r.t < lookAheadEnd && isRainy(r));

  const temps = inWindow.map((r) => r.temp);
  const feels = inWindow.map((r) => r.feels);
  const summary = {
    tempMin: Math.round(Math.min(...temps)),
    tempMax: Math.round(Math.max(...temps)),
    feelsMax: Math.round(Math.max(...feels)),
    feelsMin: Math.round(Math.min(...feels)),
    popMax: Math.max(...inWindow.map((r) => r.pop)),
    windMax: Math.round(Math.max(...inWindow.map((r) => r.wind))),
    gustMax: Math.round(Math.max(...inWindow.map((r) => r.gust))),
    uvMax: Math.round(Math.max(...inWindow.map((r) => r.uv))),
    sky: describeWeatherCode(inWindow[0].code),
  };

  const flags = {
    rain: Boolean(rainHour),
    storm: inWindow.some((r) => r.code >= 95),
    heat: summary.feelsMax >= T.heatFeelsF,
    cold: summary.feelsMin <= T.coldFeelsF,
    wind: summary.windMax >= T.windMph || summary.gustMax >= T.gustMph,
    uv: summary.uvMax >= T.uvHigh,
  };

  const messages = [];
  const endText = fmtTime(end);

  if (flags.storm) {
    messages.push({ level: 'bad', text: 'Thunderstorms are possible during your window. Consider staying close to shelter.' });
  } else if (rainHour) {
    const when = rainHour.t <= start ? 'right away' : `around ${fmtTime(rainHour.t, { hourOnly: true })}`;
    messages.push({ level: 'bad', text: `Rain is likely ${when} (${Math.round(rainHour.pop)}% chance), before your window ends at ${endText}. Sheltered and shaded spots rank higher.` });
  } else if (rainAfter) {
    messages.push({ level: 'good', text: `Rain is likely around ${fmtTime(rainAfter.t, { hourOnly: true })}. Your window ends at ${endText}, so you're fine.` });
  } else {
    messages.push({ level: 'good', text: `No rain expected before ${endText}.` });
  }
  if (flags.heat) messages.push({ level: 'warn', text: `Feels like up to ${summary.feelsMax}°F. Bring water and favor shade.` });
  if (flags.cold) messages.push({ level: 'warn', text: `Feels as cold as ${summary.feelsMin}°F. Bring a warm layer.` });
  if (flags.wind) messages.push({ level: 'warn', text: `Wind up to ${summary.windMax} mph (gusts ${summary.gustMax}). Exposed hills will feel it.` });
  if (flags.uv) messages.push({ level: 'warn', text: `UV index up to ${summary.uvMax} (very high). Wear sunscreen.` });

  return { available: true, flags, summary, messages, source: weather.source, fetchedAt: weather.fetchedAt };
}

/**
 * How suitable the weather is at a specific place (0-1), plus text.
 * Exposed places lose more points in bad weather; shade helps with heat & UV.
 */
function weatherFitForPlace(place, wx) {
  if (place.exposure === 'indoor') return { value: 1, text: "Indoors, so the weather won't matter.", minusText: '' };
  if (!wx.available) {
    return { value: 0.7, text: '', minusText: 'Weather unknown, so it counts as neutral.' };
  }
  const exp = EXPOSURE_FACTOR[place.exposure] ?? 0.6;
  const shade = Boolean(place.amenities && place.amenities.shade);
  const f = wx.flags;
  let penalty = 0;
  const bad = [];
  const good = [];

  if (f.storm) { penalty += 0.2 + 0.8 * exp; bad.push('thunderstorms are possible'); }
  else if (f.rain) {
    penalty += 0.6 * exp;
    if (exp >= 1) bad.push('rain is likely and there is little cover');
    else { bad.push('rain is likely'); good.push('trees and shelters give some cover from the rain'); }
  }
  if (f.heat) {
    penalty += shade ? 0.2 : 0.4;
    if (shade) good.push('shade helps with the heat'); else bad.push("it'll be hot with little shade");
  }
  if (f.cold) { penalty += 0.25; bad.push("it'll be chilly"); }
  if (f.wind) { penalty += 0.3 * exp; bad.push("it'll be windy here"); }
  if (f.uv && !shade) { penalty += 0.2; bad.push('UV is high and shade is scarce'); }

  const value = clamp(1 - penalty);
  let text;
  if (!bad.length && good.length) text = `Good pick for today: ${good.join(' and ')}.`;
  else if (!bad.length) text = 'Weather looks good for your window.';
  else text = good.length ? `${capitalize(good.join(' and '))}.` : '';
  const minusText = bad.length ? `Heads-up: ${listText(bad)}.` : '';
  return { value, text, minusText };
}

/* ---------------------------------------------------------------------
   7. FIT CHECK (the main feature)
   needed = travel there + (wait for opening) + minimum visit + travel back + buffer
   It fits if needed <= free time AND the place is open (and, for trails,
   still light) for at least the minimum visit.
   --------------------------------------------------------------------- */

/* How long you can stay = your free time - time to get there - safety buffer
   (cut short if the place closes, or for unlit trails, when it gets dark).
   green  ('fits')  = you get at least the stay you asked for
   yellow ('short') = you can get there, but you'd get less than you asked for
   'no'             = closed, or no time left once you arrive (not shown on the map) */

/**
 * @returns {object} fit result with verdict 'fits' | 'short' | 'no' and the numbers behind it
 */
function checkFit(place, ctx) {
  const { origin, mode, freeMin, wantStayMin, start, sun } = ctx;
  const B = CONFIG.BUFFER_MIN;

  const travel = estimateTravel(origin, place, mode);
  const arrive = addMin(start, travel.thereMin);
  const windowEnd = addMin(start, freeMin);

  // Opening hours on the arrival day
  const hours = hoursOn(place, arrive);
  const opens = resolveClock(hours.open, arrive, sun);
  let closes = resolveClock(hours.close, arrive, sun);
  if (!hours.closed && closes <= opens) closes = addMin(closes, 24 * 60); // e.g. "18:00-02:00"

  // Unlit trails/hillsides effectively "close" at sunset.
  const darkSensitive = DARK_SENSITIVE_TYPES.includes(place.type);
  const darkStop = darkSensitive ? sun.sunset : null;
  const hardStop = darkStop ? minDate(closes, darkStop) : closes;
  const stopReason = darkStop && darkStop < closes ? 'sunset' : 'closing';

  const waitMin = Math.max(0, Math.ceil(minutesBetween(arrive, opens)));
  const visitStart = maxDate(arrive, opens);
  const leaveBy = minDate(addMin(windowEnd, -B), hardStop);
  const onSiteMin = Math.max(0, Math.floor(minutesBetween(visitStart, leaveBy)));

  const result = {
    place, travel, arrive, opens, closes, hardStop, stopReason, waitMin, visitStart, leaveBy,
    onSiteMin, wantStayMin, shortByMin: Math.max(0, wantStayMin - onSiteMin), freeMin, bufferMin: B,
    verdict: 'fits', reason: '', notes: [],
  };

  // --- Not reachable: one clear reason ---
  const by = CONFIG.MODES[mode].by;
  if (hours.closed) {
    result.verdict = 'no';
    result.reason = `Closed on ${arrive.toLocaleDateString([], { weekday: 'long' })}s.`;
  } else if (arrive >= hardStop) {
    result.verdict = 'no';
    result.reason = stopReason === 'sunset'
      ? `You'd arrive at ${fmtTime(arrive)}, after sunset (${fmtTime(hardStop)}), and the trails aren't lit.`
      : `You'd arrive at ${fmtTime(arrive)}, after it closes at ${fmtTime(hardStop)}.`;
  } else if (onSiteMin <= 0) {
    result.verdict = 'no';
    const wait = waitMin ? ` and opens ${waitMin} min after you'd arrive` : '';
    result.reason = `It's ${travel.thereMin} min away ${by}${wait}, so with the ${B} min buffer there's no time left to stay.`;
  }
  if (result.verdict === 'no') return result;

  // --- Green or yellow ---
  result.verdict = onSiteMin >= wantStayMin ? 'fits' : 'short';

  // Short notes, only when something other than your free time limits the visit.
  if (waitMin > 0) result.notes.push(`Opens at ${fmtTime(opens)}`);
  if (leaveBy.getTime() === hardStop.getTime()) {
    result.notes.push(stopReason === 'sunset' ? `Gets dark at ${fmtTime(hardStop)}` : `Closes at ${fmtTime(hardStop)}`);
  } else if (!darkSensitive && place.exposure !== 'indoor' && leaveBy > sun.sunset) {
    result.notes.push(`Gets dark at ${fmtTime(sun.sunset)}`);
  }
  return result;
}

const activityLabel = (key) => (ACTIVITIES[key] ? ACTIVITIES[key].label.toLowerCase() : key);

/* ---------------------------------------------------------------------
   8. ESCAPE SCORE (0-100), only for places that fit
   activity 35% · environment 25% · amenities 15% · distance 15% · weather 10%
   Each part is a 0-1 value. Score = sum(weight x value).
   --------------------------------------------------------------------- */

function scorePlace(fit, prefs, wx) {
  const W = CONFIG.WEIGHTS;
  const p = fit.place;
  const parts = [];

  // Activity match (35)
  {
    const act = ACTIVITIES[prefs.activity];
    let value = 0, text = '', minusText = '';
    if (p.activities.includes(prefs.activity)) {
      value = 1;
      text = `Great for ${act.phrase}. ${ACTIVITY_TIPS[prefs.activity] || ''}`.trim();
    } else {
      let best = { key: null, r: 0 };
      p.activities.forEach((a) => {
        const r = relatedness(RELATED_ACTIVITIES, prefs.activity, a);
        if (r > best.r) best = { key: a, r };
      });
      value = best.r;
      minusText = best.key
        ? `Not a classic spot for ${act.phrase}, but good for ${ACTIVITIES[best.key].phrase}.`
        : `Not really set up for ${act.phrase}.`;
    }
    parts.push({ key: 'activity', weight: W.activity, value, text, minusText });
  }

  // Environment match (25)
  {
    const env = prefs.kind === 'study'
      ? { ...ENVIRONMENTS.quiet, match: 'Quiet place to focus.', miss: 'Can get noisy' }
      : ENVIRONMENTS[prefs.environment];
    let value = 0, text = '', minusText = '';
    if (p.environment.includes(prefs.environment)) {
      value = 1;
      text = env.match;
    } else {
      let best = { key: null, r: 0 };
      p.environment.forEach((e) => {
        const r = relatedness(RELATED_ENVIRONMENTS, prefs.environment, e);
        if (r > best.r) best = { key: e, r };
      });
      value = best.r;
      minusText = best.key ? `${env.miss}, though ${ENVIRONMENTS[best.key].has}.` : `${env.miss}.`;
    }
    parts.push({ key: 'environment', weight: W.environment, value, text, minusText });
  }

  // Amenities that matter for this activity (15). Parking counts when driving.
  {
    const wanted = [...ACTIVITIES[prefs.activity].amenities];
    if (prefs.mode === 'driving') wanted.push('parking');
    // true = has it, false = doesn't, null = not listed (half credit)
    const val = (k) => (p.amenities ? p.amenities[k] : null);
    const have = wanted.filter((k) => val(k) === true);
    const missing = wanted.filter((k) => val(k) === false);
    const unknown = wanted.filter((k) => val(k) !== true && val(k) !== false);
    const value = wanted.length ? (have.length + 0.5 * unknown.length) / wanted.length : 1;
    let text = have.length ? `Has ${listText(have.map((k) => AMENITY_LABELS[k]))}.` : '';
    if (prefs.mode === 'driving' && val('parking') === true && p.parkingNote) text += ` Parking: ${p.parkingNote}.`;
    let minusText = '';
    if (missing.length) minusText = `No ${listText(missing.map((k) => AMENITY_LABELS[k]))} on site.`;
    else if (unknown.length) minusText = `Not listed: ${listText(unknown.map((k) => AMENITY_LABELS[k]))}. Bring what you need.`;
    parts.push({ key: 'amenities', weight: W.amenities, value, text, minusText });
  }

  // Distance: share of your free time spent travelling (15)
  {
    const share = fit.travel.thereMin / fit.freeMin;
    const value = clamp(1 - share / CONFIG.DISTANCE_ZERO_SHARE);
    const by = CONFIG.MODES[prefs.mode].by;
    const text = `Only ${fit.travel.thereMin} min away ${by}, so most of your free time goes to the visit, not travel.`;
    const minusText = `${fit.travel.thereMin} min each way ${by} eats into your time.`;
    parts.push({ key: 'distance', weight: W.distance, value, text, minusText });
  }

  // Weather suitability (10)
  {
    const wf = weatherFitForPlace(p, wx);
    parts.push({ key: 'weather', weight: W.weather, value: wf.value, text: wf.text, minusText: wf.minusText });
  }

  const score = Math.round(parts.reduce((sum, part) => sum + part.weight * part.value, 0));

  // Reasons: top 3 strongest positives, plus the biggest heads-up (if it cost 5+ points).
  const positives = parts
    .filter((part) => part.value >= 0.6 && part.text)
    .sort((a, b) => b.weight * b.value - a.weight * a.value)
    .slice(0, 3)
    .map((part) => part.text);
  const worst = parts
    .filter((part) => part.minusText && part.weight * (1 - part.value) >= 5)
    .sort((a, b) => b.weight * (1 - b.value) - a.weight * (1 - a.value))[0];

  return { score, parts, reasons: positives, headsUp: worst ? worst.minusText : '' };
}

/* ---------------------------------------------------------------------
   9. SEARCH PIPELINE
   --------------------------------------------------------------------- */

/** Work out the trip start time from the "Leaving" inputs. */
function computeStart(when, laterTime) {
  const now = new Date();
  now.setSeconds(0, 0);
  if (when !== 'later' || !laterTime) return now;
  const [h, m] = laterTime.split(':').map(Number);
  const d = new Date(now);
  d.setHours(h, m, 0, 0);
  if (d < addMin(now, -1)) d.setDate(d.getDate() + 1); // a time earlier than now means tomorrow
  return d;
}

/**
 * Close enough to walk? If you chose driving/transit and a place is within
 * CONFIG.WALKABLE_MI (straight line), plan it as a walk instead: the card's
 * times, green/yellow and "Get directions" use walking, and your chosen mode
 * moves to the blue box. Kept on your mode if walking would leave no time there.
 */
function walkSwap(fit, ctx) {
  const close = kmToMi(fit.travel.straightKm) <= CONFIG.WALKABLE_MI;
  if (ctx.mode === 'walking' || !close) return { ...fit, mode: ctx.mode };
  const walkFit = checkFit(fit.place, { ...ctx, mode: 'walking' });
  if (walkFit.verdict === 'no' && fit.verdict !== 'no') return { ...fit, mode: ctx.mode };
  return { ...walkFit, mode: 'walking', alt: { mode: ctx.mode, thereMin: fit.travel.thereMin } };
}

async function runSearch(formPrefs) {
  // Food (and the other every-day places) are found by places.js: nearest places that are open and fit your time.
  // The stay you chose decides which give you enough time.
  if (window.ReachPlaces && window.ReachPlaces.CATEGORIES[formPrefs.kind]) {
    return window.ReachPlaces.search({ ...formPrefs, honorStay: true }, formPrefs.kind);
  }
  // "Study spots" always means: activity = studying, environment = quiet.
  const kind = formPrefs.kind === 'study' ? 'study' : 'parks';
  const prefs = kind === 'study' ? { ...formPrefs, kind, activity: 'studying', environment: 'quiet' } : { ...formPrefs, kind };
  const origin = await getOrigin(prefs);                // may throw SearchError
  const start = computeStart(prefs.when, prefs.laterTime);
  const end = addMin(start, prefs.freeMin);
  const radiusKm = searchRadiusKm(prefs);

  // Weather and place search run in parallel.
  const [weather, live, parking] = await Promise.all([
    getWeather(origin),
    searchLivePlaces(origin, radiusKm, kind),
    prefs.mode === 'driving' ? findStartParking(origin) : null,
  ]);
  const places = mergePlaces(origin, live.radiusKm || radiusKm, live.places, kind);
  indexPlaces(places);

  const sun = getSun(start, weather, origin);
  const wx = analyzeWeather(weather, start, end);

  const wantStayMin = prefs.wantStayMin || 30;
  const ctx = { origin, mode: prefs.mode, activity: prefs.activity, freeMin: prefs.freeMin, wantStayMin, start, sun };
  const all = places.map((place) => walkSwap(checkFit(place, ctx), ctx));

  const fitting = all
    .filter((r) => r.verdict !== 'no')
    .map((r) => ({ ...r, scoring: scorePlace(r, { ...prefs, mode: r.mode }, wx) }))
    // Green (enough time) first, then yellow; best score first within each.
    .sort((a, b) => (a.verdict === 'fits' ? 0 : 1) - (b.verdict === 'fits' ? 0 : 1)
      || b.scoring.score - a.scoring.score || b.onSiteMin - a.onSiteMin);

  // Closest misses first, so users can see what *almost* worked.
  const notFitting = all
    .filter((r) => r.verdict === 'no')
    .sort((a, b) => a.travel.thereMin - b.travel.thereMin);

  state.results = {
    prefs, formPrefs, origin: parking ? { ...origin, parking } : origin, start, end, sun, wx, fitting, notFitting,
    live: { status: live.status, radiusKm: live.radiusKm || radiusKm, count: places.length },
  };
  return state.results;
}

/* ---------------------------------------------------------------------
   10. RENDERING
   --------------------------------------------------------------------- */

/** Google Maps directions link with the matching travel mode (no API key needed). */
function directionsUrl(place, mode, origin) {
  const params = new URLSearchParams({
    api: '1',
    // Name + address lets Google find the real place, even if our sample coordinates are slightly off.
    destination: `${place.name}, ${place.address || `${place.lat},${place.lng}`}`,
    travelmode: CONFIG.MODES[mode] ? CONFIG.MODES[mode].gmaps : 'driving',
  });
  // Driving from your location: start at the nearest parking lot (see findStartParking).
  // From a ZIP: start there. Otherwise leave origin out, so Google Maps uses where you are.
  if (mode === 'driving' && origin && origin.parking) params.set('origin', `${origin.parking.lat},${origin.parking.lng}`);
  else if (origin && origin.source !== 'location' && origin.zip) params.set('origin', origin.zip);
  return `https://www.google.com/maps/dir/?${params}`;
}

/**
 * Built-in illustration used when a place has no photo (or the photo fails).
 * Simple layered landscape; colors come from CSS variables so it follows dark mode.
 */
function sceneSVG(place) {
  const env = new Set(place.environment || []);
  const h = hashString(place.id);
  const r = (n, i) => ((h >> (i * 3)) % n);   // small deterministic "random" numbers
  const hill1 = 120 + r(30, 1);
  const hill2 = 140 + r(25, 2);
  const parts = [];

  if (isStudyPlace(place)) {
    parts.push(`<path class="art-near" d="M0 170 H320 V200 H0Z"/>`);
    parts.push(`<path class="art-trunk" d="M90 170 V95 L160 60 L230 95 V170Z"/>`);
    for (let i = 0; i < 3; i++) parts.push(`<rect class="art-water" x="${108 + i * 38}" y="108" width="24" height="34" rx="3"/>`);
    parts.push(`<rect class="art-sun" x="148" y="146" width="24" height="24" rx="2"/>`);
    return `<svg class="scene" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Illustration of ${esc(place.name)}">${parts.join('')}</svg>`;
  }

  parts.push(`<circle class="art-sun" cx="${60 + r(220, 3)}" cy="${45 + r(25, 4)}" r="18"/>`);
  if (env.has('scenic') || place.type === 'scenic area' || place.type === 'trail') {
    parts.push(`<path class="art-far" d="M0 ${hill1} L70 ${hill1 - 55} L120 ${hill1 - 25} L190 ${hill1 - 70} L260 ${hill1 - 20} L320 ${hill1 - 45} L320 200 L0 200Z"/>`);
  } else {
    parts.push(`<path class="art-far" d="M0 ${hill1} Q80 ${hill1 - 40} 160 ${hill1 - 10} T320 ${hill1 - 20} L320 200 L0 200Z"/>`);
  }
  parts.push(`<path class="art-near" d="M0 ${hill2} Q100 ${hill2 - 30} 200 ${hill2} T320 ${hill2 - 10} L320 200 L0 200Z"/>`);

  if (env.has('water')) {
    parts.push(`<ellipse class="art-water" cx="${170 + r(60, 5)}" cy="178" rx="95" ry="14"/>`);
    parts.push(`<path class="art-ripple" d="M${130 + r(40, 6)} 176 h30 M${190 + r(30, 7)} 182 h22"/>`);
  }
  if (env.has('forest')) {
    for (let i = 0; i < 9; i++) {
      const x = 12 + i * 34 + r(10, i % 8);
      const base = hill2 + 8 - (i % 3) * 6;
      const tall = 34 + ((h >> i) % 18);
      parts.push(`<path class="art-tree${i % 2 ? '-2' : ''}" d="M${x} ${base} l12 -${tall} l12 ${tall}Z"/>`);
    }
  } else if (place.type === 'park' || env.has('open field')) {
    [40, 250].forEach((x, i) => {
      const cx = x + r(30, i + 2);
      parts.push(`<rect class="art-trunk" x="${cx - 2}" y="${hill2 - 18}" width="4" height="18"/>`);
      parts.push(`<circle class="art-tree" cx="${cx}" cy="${hill2 - 26}" r="15"/>`);
    });
  }
  if (env.has('garden')) {
    for (let i = 0; i < 14; i++) {
      const x = 20 + i * 21 + r(8, i % 8);
      const y = 168 + ((h >> (i + 2)) % 22);
      parts.push(`<circle class="art-flower-${i % 3}" cx="${x}" cy="${y}" r="4"/>`);
    }
  }
  if (place.type === 'trail' || place.type === 'scenic area') {
    parts.push('<path class="art-path" d="M150 200 C170 180 130 168 165 150 S190 140 185 132"/>');
  }

  return `<svg class="scene" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid slice" role="img" aria-label="Illustration of ${esc(place.name)}">${parts.join('')}</svg>`;
}

/** Small label saying where a place's data comes from. */
function sourceTagHTML(place) {
  return place.source === 'live' ? '' : '<span class="source-tag source-curated">Reach pick</span>';
}

/** Photo if we have one, otherwise the illustration. */
function mediaHTML(place) {
  if (place.photo) {
    return `<img class="card-photo" src="${esc(place.photo)}" alt="${esc(place.name)}" loading="lazy" data-place="${esc(place.id)}">`;
  }
  return sceneSVG(place);
}

function saveButtonHTML(placeId, compact = false) {
  const saved = isFavorite(placeId);
  return `<button type="button" class="btn ${compact ? 'btn-small' : ''} btn-save" data-save="${esc(placeId)}" aria-pressed="${saved}">
    <span class="save-label">${saved ? 'Saved' : 'Save'}</span>
  </button>`;
}

/** The two numbers that matter: time to get there, and time you can spend there.
    `openEnded` (no class to be back for, and no time given): only the time to get there. */
function tripStatsHTML(fit, mode, openEnded = false) {
  const short = fit.verdict === 'short' && !openEnded;
  return `<div class="trip-stats">
      <div class="trip-stat"><span class="trip-value">${esc(fmtDuration(fit.travel.thereMin))}</span><span class="trip-label">to get there ${esc(mode.by)}</span></div>
      ${openEnded ? '' : `<div class="trip-stat stay-stat ${short ? 'is-short' : 'is-enough'}"><span class="trip-value">${esc(fmtDuration(fit.onSiteMin))}</span><span class="trip-label">you can spend there</span></div>`}
    </div>
    ${short ? `<p class="short-note">Less than the ${esc(fmtDuration(fit.wantStayMin))} you wanted</p>` : ''}`;
}

function amenityChipsHTML(place) {
  return (isStudyPlace(place) ? STUDY_AMENITIES : PARK_AMENITIES).map((k) => {
    const v = place.amenities ? place.amenities[k] : null;
    const label = AMENITY_LABELS[k];
    if (v === true) return `<li class="amenity has">${capitalize(label)}</li>`;
    if (v === false) return `<li class="amenity missing">No ${label}</li>`;
    return `<li class="amenity unknown">${capitalize(label)}: not listed</li>`;
  }).join('');
}

function hoursText(place, date = new Date()) {
  const h = place.hours || {};
  if (h.assumed) return `Not listed. Assuming ${describeClock(h.open)} to ${describeClock(h.close)}`;
  if (h.byDay) {
    const today = hoursOn(place, date);
    return today.closed ? `Closed today (${h.raw})` : `Today ${describeClock(today.open)} to ${describeClock(today.close)}`;
  }
  if (!h.open) return 'Hours not listed';
  const closed = (h.closedDays || []).length ? ` · Closed ${h.closedDays.join(', ')}` : '';
  return `${describeClock(h.open)} to ${describeClock(h.close)}${closed}`;
}

/** Shared "details" block: description, amenities, hours, accessibility. */
function detailsHTML(place) {
  return `<details class="more-info">
      <summary>About this place</summary>
      <p>${esc(place.description)}</p>
      <ul class="amenities">${amenityChipsHTML(place)}</ul>
      <dl class="facts">
        <div><dt>Hours</dt><dd>${esc(hoursText(place))}</dd></div>
        ${place.parkingNote ? `<div><dt>Parking</dt><dd>${esc(place.parkingNote)}</dd></div>` : ''}
        <div><dt>Access</dt><dd>${esc(place.accessibility || 'No notes yet')}</dd></div>
        ${place.address ? `<div><dt>Address</dt><dd>${esc(place.address)}</dd></div>` : ''}
        ${place.website ? `<div><dt>Website</dt><dd><a href="${esc(place.website)}" target="_blank" rel="noopener">Official site</a></dd></div>` : ''}
      </dl>
      ${place.source === 'live'
        ? '<p class="verify-note">Hours and visit length are estimates. Check before you go.</p>'
        : (place.verify && place.verify.length ? `<p class="verify-note">Sample data. Still to verify: ${esc(place.verify.join(', '))}.</p>` : '')}
    </details>`;
}

/** The card shown on top of the map for the current recommendation. */
function mapCardHTML(fit, i, results) {
  const { place, scoring } = fit;
  const { origin, fitting } = results;
  const modeKey = fit.mode || results.prefs.mode;
  const mode = CONFIG.MODES[modeKey];
  const miles = kmToMi(fit.travel.routeKm);
  const sub = [place.kindLabel || TYPE_LABELS[place.type] || place.type, `${miles.toFixed(1)} mi away`];
  if (place.source !== 'live') sub.push('Reach pick');
  return `<article class="map-card">
      <div class="mc-top">
        <span class="mc-count">${i + 1} of ${fitting.length}</span>
        <div class="score score-sm" style="--score:${scoring.score}" role="img" aria-label="Match score ${scoring.score} out of 100">
          <span class="score-num">${scoring.score}</span>
          <span class="score-cap">score</span>
        </div>
      </div>
      <h2 class="mc-title">${esc(place.name)}</h2>
      <p class="mc-sub">${esc(sub.join(' · '))}</p>
      ${tripStatsHTML(fit, mode, Boolean(results.prefs.openEnded))}
      ${altModeHTML(fit, results)}
      ${fit.notes.map((n) => `<p class="note">${esc(n)}</p>`).join('')}
      <p class="mc-desc">${esc(place.description)}</p>
      <ul class="reasons">${scoring.reasons.slice(0, 2).map((t) => `<li class="reason-good">${esc(t)}</li>`).join('')}</ul>
      ${modeKey === 'driving' ? parkingStartHTML(results) : ''}
      <div class="actions">
        <a class="btn btn-primary" href="${esc(directionsUrl(place, modeKey, origin))}" target="_blank" rel="noopener">Get directions</a>
        ${saveButtonHTML(place.id)}
      </div>
    </article>`;
}

/** "Driving directions start at <lot>, 3 min walk from you." */
function parkingStartHTML(results) {
  const { prefs, origin } = results;
  if (prefs.mode !== 'driving' || !origin.parking) return '';
  const lot = origin.parking;
  const walkMin = Math.max(1, Math.ceil((lot.km * CONFIG.DETOUR_FACTOR / CONFIG.MODES.walking.speedKmh) * 60));
  const name = lot.name || 'the nearest parking lot';
  return `<p class="note start-note">Driving directions start at ${esc(name)}, ${walkMin} min walk from you.</p>`;
}

/** Blue box on walk-swapped places: offers the mode you originally picked. */
function altModeHTML(fit, results) {
  if (!fit.alt) return '';
  const { origin } = results;
  const alt = fit.alt;
  const how = alt.mode === 'driving'
    ? `Driving would take about ${fmtDuration(alt.thereMin)}, including parking.`
    : `Transit would take about ${fmtDuration(alt.thereMin)}, including the wait.`;
  const label = alt.mode === 'driving' ? 'Driving directions' : 'Transit directions';
  return `<div class="walk-note">
      <p><strong>Close enough to walk.</strong> ${esc(how)}</p>
      <a href="${esc(directionsUrl(fit.place, alt.mode, origin))}" target="_blank" rel="noopener">${label}</a>
    </div>`;
}

/** Card shown when nothing fits: friendly message plus the nearest miss. */
function emptyCardHTML(results) {
  const { notFitting, prefs, sun, start } = results;
  const nearest = notFitting.filter((f) => f.arrive < f.hardStop).sort((a, b) => a.travel.thereMin - b.travel.thereMin)[0];
  const tips = [];
  if (nearest) {
    const by = CONFIG.MODES[prefs.mode].by;
    tips.push(`The closest option, <strong>${esc(nearest.place.name)}</strong>, is ${nearest.travel.thereMin} min away ${esc(by)}, `
      + `which leaves no time to stay once you count the ${nearest.bufferMin} min buffer.`);
  }
  if (prefs.mode === 'walking') tips.push('Try <strong>transit</strong> or <strong>driving</strong> to reach more places.');
  if (start > addMin(sun.sunset, -30)) tips.push(`Most parks close around sunset (${esc(fmtTime(sun.sunset))}). Try a <strong>Later</strong> start tomorrow.`);
  else if (prefs.freeMin < 120) tips.push('Or give yourself a little more time.');
  return `<article class="map-card map-card-empty">
      <h2 class="mc-title">Nothing fits in ${esc(fmtDuration(prefs.freeMin))}</h2>
      ${tips.map((t) => `<p class="mc-desc">${t}</p>`).join('')}
      <div class="actions"><a class="btn btn-primary" href="#/plan">Adjust my plan</a></div>
    </article>`;
}

/** Weather chip (bottom of the map) + its panel with the full details. */
function renderWeatherChip(results) {
  const { wx, sun, prefs, origin, start, end } = results;
  const mode = CONFIG.MODES[prefs.mode];
  let chip;
  if (!wx.available) chip = 'Weather unavailable';
  else {
    const s = wx.summary;
    const temp = s.tempMin === s.tempMax ? `${s.tempMax}°F` : `${s.tempMin}–${s.tempMax}°F`;
    const alert = wx.flags.storm ? 'Storms' : wx.flags.rain ? 'Rain likely' : wx.flags.heat ? 'Hot' : wx.flags.wind ? 'Windy' : 'No rain';
    chip = `${temp} · ${alert}`;
  }
  $('#wx-chip').textContent = chip;

  const act = ACTIVITIES[prefs.activity];
  const env = ENVIRONMENTS[prefs.environment];
  const where = origin.source === 'location'
    ? `Near you${origin.label && origin.label !== 'your location' ? ` (${origin.label})` : ''}`
    : `${origin.zip}${origin.label ? ` (${origin.label})` : ''}`;
  const items = wx.messages.map((m) => `<li class="wx-${m.level}">${esc(m.text)}</li>`);
  items.push(`<li class="wx-info">Sunset at ${esc(fmtTime(sun.sunset))}${sun.source === 'calculated' ? ' (calculated offline)' : ''}.</li>`);
  items.push(liveStatusHTML(results));
  if (wx.available && wx.source === 'stale') items.push(`<li class="wx-info">Offline: using the forecast saved at ${esc(fmtTime(new Date(wx.fetchedAt)))}.</li>`);
  if (mode.note) items.push(`<li class="wx-info">${esc(mode.label)} times are estimates (${esc(mode.note)}).</li>`);
  const stay = `Stay ${fmtDuration(prefs.wantStayMin || 30)}`;
  const travel = capitalize(mode.by); // "On foot", "By car", "By transit"
  const planBits = prefs.kindLabel ? [prefs.kindLabel, stay, travel] // food and other every-day places (places.js)
    : prefs.kind === 'study' ? ['Study spots', stay, travel] : ['Parks', stay, travel, act.label, env.label];
  $('#wx-panel').innerHTML = `
    <p class="wx-plan">${esc(planBits.join(' · '))}<br>
      From ${esc(where)} · ${esc(fmtTime(start))} to ${esc(fmtTime(end))}</p>
    <ul>${items.join('')}</ul>`;
}

/** One line explaining how many places we checked and where they came from. */
function liveStatusHTML(results) {
  const { live, origin } = results;
  const miles = kmToMi(live.radiusKm).toFixed(live.radiusKm < 5 ? 1 : 0);
  const where = origin.source === 'location' ? 'you' : esc(origin.label || origin.zip);
  const what = results.prefs.kindPlural || (results.prefs.kind === 'study' ? 'libraries and cafes' : 'parks');
  const messages = {
    live: `Checked ${live.count} ${what} within ${miles} mi of ${where}.`,
    cache: `Checked ${live.count} ${what} within ${miles} mi of ${where}.`,
    stale: `Offline: using places saved from an earlier search (${live.count} spots).`,
    nokey: "Live place search is off (no Geoapify key), so you're seeing Reach's San Jose picks only.",
    badkey: 'The Geoapify key was rejected, so live results are missing. Check config.js. Showing curated picks only.',
    offline: "Couldn't reach the place search (offline?), so you're seeing curated picks only.",
  };
  const bad = ['nokey', 'badkey', 'offline'].includes(live.status);
  return `<li class="${bad ? 'wx-warn' : 'wx-info'}">${messages[live.status] || ''}</li>`;
}

function renderResults() {
  const results = state.results;
  if (!results) return;
  const { prefs, fitting } = results;
  $('#results-title').textContent = fitting.length
    ? `${fitting.length} ${fitting.length === 1 ? 'place fits' : 'places fit'} your ${fmtDuration(prefs.freeMin)}`
    : 'Nothing fits this window';
  renderWeatherChip(results);
  setWeatherPanel(false);

  const map = ensureMap();
  $('#map-fallback').hidden = Boolean(map);
  if (map) {
    // The view was hidden until now, so let Leaflet measure its container first.
    map.invalidateSize();
    drawMarkers(results);
  }
  // Coming back with "Back to map": reopen the place you were looking at, not #1
  const resume = MAP.resume && MAP.index < results.fitting.length ? MAP.index : 0;
  MAP.resume = false;
  showRecommendation(resume, { animate: false });
}

/* ---------------------------------------------------------------------
   10b. MAP VIEW (Leaflet, bundled in vendor/leaflet)
   The results page is a full-screen map. One recommendation at a time is
   shown in the card on top; the back/next buttons (or arrow keys, a swipe on the
   card, or tapping a pin) step through them in Escape Score order.
   --------------------------------------------------------------------- */
const MAP = { map: null, tiles: null, layer: null, pins: [], index: 0, resume: false, tileLoads: 0, tileErrors: 0, tileStep: 0 };

function isDarkTheme() {
  const forced = document.documentElement.getAttribute('data-theme');
  if (forced) return forced === 'dark';
  return Boolean(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
}

/** Tile styles to try, best first: (dark style) -> bright style -> plain OpenStreetMap. */
function tileCandidates() {
  const t = CONFIG.MAP_TILES;
  const list = CONFIG.MAP_DARK_TILES && isDarkTheme() ? [t.dark, t.light, t.fallback] : [t.light, t.fallback];
  return list.filter((c) => !c.needsKey || GEO.key);
}

/** (Re)load the tile layer. If a style keeps failing, step down to the next candidate. */
function setTiles({ resetFallback = true } = {}) {
  if (!MAP.map) return;
  if (resetFallback) MAP.tileStep = 0;
  const candidates = tileCandidates();
  const cfg = candidates[Math.min(MAP.tileStep, candidates.length - 1)];
  if (MAP.tiles) MAP.map.removeLayer(MAP.tiles);
  MAP.tileLoads = 0;
  MAP.tileErrors = 0;
  MAP.tiles = L.tileLayer(cfg.url, { attribution: cfg.attribution, maxZoom: cfg.maxZoom, apiKey: GEO.key }).addTo(MAP.map);
  MAP.tiles.on('tileload', () => { MAP.tileLoads += 1; });
  MAP.tiles.on('tileerror', () => {
    MAP.tileErrors += 1;
    if (MAP.tileLoads === 0 && MAP.tileErrors >= 4 && MAP.tileStep < candidates.length - 1) {
      MAP.tileStep += 1;
      console.warn('[Reach] Map tiles failed, trying', candidates[MAP.tileStep].url.split('?')[0]);
      setTiles({ resetFallback: false });
    }
  });
}

/** Create the Leaflet map once. Returns null if Leaflet didn't load. */
function ensureMap() {
  if (MAP.map) return MAP.map;
  if (!window.L) return null;
  MAP.map = L.map('map', { zoomControl: false, center: [37.3382, -121.8863], zoom: 12 });
  L.control.zoom({ position: 'bottomright' }).addTo(MAP.map);
  MAP.map.attributionControl.setPrefix('<a href="https://leafletjs.com" target="_blank" rel="noopener">Leaflet</a>');
  MAP.map.attributionControl.addAttribution('Places via <a href="https://www.geoapify.com/" target="_blank" rel="noopener">Geoapify</a> · Weather <a href="https://open-meteo.com/" target="_blank" rel="noopener">Open-Meteo</a>');
  MAP.layer = L.layerGroup().addTo(MAP.map);
  MAP.map.on('click', () => setWeatherPanel(false));
  setTiles();
  return MAP.map;
}

/** Fly the map so `latlng` appears at screen point {x, y} (pixels inside the map). */
function flyToSpot(latlng, spot, { zoom, animate = true } = {}) {
  const map = MAP.map;
  const z = zoom ?? Math.max(map.getZoom(), CONFIG.MAP_FOCUS_ZOOM);
  const size = map.getSize();
  const offset = L.point(spot.x - size.x / 2, spot.y - size.y / 2);
  const center = map.unproject(map.project(latlng, z).subtract(offset), z);
  if (animate && !prefersReducedMotion()) map.flyTo(center, z, { duration: 0.7 });
  else map.setView(center, z, { animate: false });
}

/** Map-relative rectangles of the card and the back/next buttons. */
function overlayRects() {
  const m = $('#map').getBoundingClientRect();
  const rel = (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left - m.left, right: r.right - m.left, top: r.top - m.top, bottom: r.bottom - m.top };
  };
  return { width: m.width, height: m.height, card: rel($('#map-card')), next: rel($('#map-next')), prev: rel($('#map-prev')) };
}

/**
 * Where the selected pin's head goes:
 * - wide screens: just right of the card, on the line between the card and
 *   the next button, level with the back/next buttons (about a quarter of the way across)
 * - phones (no room beside the card): just under the card, level with the back/next buttons
 */
function selectedSpot() {
  const o = overlayRects();
  const navHidden = $('#map-next').hidden;
  const nextLeft = navHidden ? o.width - 16 : o.next.left;
  const navMid = navHidden ? o.height / 2 : (o.next.top + o.next.bottom) / 2;
  const room = nextLeft - o.card.right;
  if (room >= 160) {
    const x = o.card.right + Math.min(Math.max(room * 0.28, 70), 240);
    return { x, y: Math.min(Math.max(navMid, 90), o.height - 120) };
  }
  return { x: o.width / 2, y: Math.min(Math.max(o.card.bottom + 46, navMid), o.height - 120) };
}

const PIN_HEAD_TO_TIP = 38; // px from a selected (1.5x) pin's head to its tip

function placeSelected(latlng, animate) {
  const spot = selectedSpot();
  flyToSpot(latlng, { x: spot.x, y: spot.y + PIN_HEAD_TO_TIP }, { animate });
}

/** Middle of the part of the map you can see (below the card, above the chips). */
function visibleCenter() {
  const o = overlayRects();
  const top = Math.max(0, Math.min(o.card.bottom, o.height * 0.7));
  return { x: o.width / 2, y: top + (o.height - top - 70) / 2 };
}

function centerOnMe() {
  const r = state.results;
  if (!MAP.map || !r) return;
  flyToSpot([r.origin.lat, r.origin.lng], visibleCenter());
}

function pinIcon(fit, rank, active) {
  return L.divIcon({
    className: 'pin-wrap',
    html: `<div class="pin-box${active ? ' is-active' : ''}"><div class="pin${fit.verdict === 'short' ? ' pin-short' : ''}"><span>${rank + 1}</span></div></div>`,
    iconSize: [36, 44],
    iconAnchor: [18, 43],
  });
}

/** Draw you and the reachable recommendations (numbered pins). Places that don't fit aren't shown. */
function drawMarkers(results) {
  const { origin, fitting } = results;
  MAP.layer.clearLayers();
  MAP.pins = [];

  const youLabel = origin.source === 'location' ? 'You' : 'Start';
  L.marker([origin.lat, origin.lng], {
    icon: L.divIcon({
      className: 'pin-wrap',
      html: `<div class="you-marker"><span class="you-pulse"></span><span class="you-dot"></span><span class="you-label">${youLabel}</span></div>`,
      iconSize: [64, 64], iconAnchor: [32, 32],
    }),
    keyboard: false, zIndexOffset: 4000, // above other pins, below the selected one
    title: origin.source === 'location' ? 'You are here' : `Starting from ZIP ${origin.zip}`,
  }).addTo(MAP.layer);

  fitting.forEach((f, i) => {
    const marker = L.marker([f.place.lat, f.place.lng], {
      icon: pinIcon(f, i, false), title: `${i + 1}. ${f.place.name}`, zIndexOffset: (fitting.length - i) * 10,
    }).addTo(MAP.layer);
    marker.on('click', () => showRecommendation(i));
    MAP.pins.push(marker);
  });
}

/** Show recommendation i: update the card, highlight its pin, and move it next to the card. */
function showRecommendation(i, { animate = true } = {}) {
  const results = state.results;
  if (!results) return;
  const { fitting } = results;
  const prev = $('#map-prev');
  const next = $('#map-next');
  setWeatherPanel(false);

  if (!fitting.length) {
    $('#map-card').innerHTML = emptyCardHTML(results);
    prev.hidden = true;
    next.hidden = true;
    frameEverything(results);
    return;
  }

  const old = MAP.index;
  MAP.index = Math.max(0, Math.min(fitting.length - 1, i));
  const fit = fitting[MAP.index];
  $('#map-card').innerHTML = mapCardHTML(fit, MAP.index, results);
  $('#map-card').scrollTop = 0;
  prev.hidden = fitting.length < 2;
  next.hidden = fitting.length < 2;
  prev.disabled = MAP.index === 0;
  next.disabled = MAP.index === fitting.length - 1;

  if (MAP.map && MAP.pins.length) {
    if (MAP.pins[old]) MAP.pins[old].setIcon(pinIcon(fitting[old], old, false)).setZIndexOffset((fitting.length - old) * 10);
    MAP.pins[MAP.index].setIcon(pinIcon(fit, MAP.index, true)).setZIndexOffset(5000);
    placeSelected([fit.place.lat, fit.place.lng], animate);
  }
}

const prefersReducedMotion = () => Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);

/** Nothing fits: just show where you are. */
function frameEverything(results) {
  if (!MAP.map) return;
  flyToSpot([results.origin.lat, results.origin.lng], visibleCenter(), { zoom: 13, animate: false });
}

function setWeatherPanel(open) {
  $('#wx-panel').hidden = !open;
  $('#wx-chip').setAttribute('aria-expanded', String(open));
}

function setupMapControls() {
  $('#map-prev').addEventListener('click', () => showRecommendation(MAP.index - 1));
  $('#map-next').addEventListener('click', () => showRecommendation(MAP.index + 1));
  $('#wx-chip').addEventListener('click', () => setWeatherPanel($('#wx-panel').hidden));
  $('#map-locate').addEventListener('click', centerOnMe);

  // Arrow keys (when not typing in a field)
  document.addEventListener('keydown', (e) => {
    if ($('#view-results').hidden) return;
    if (isSheetOpen()) { if (e.key === 'Escape') closePlanSheet(); return; }
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName)) return;
    if (e.key === 'ArrowLeft') showRecommendation(MAP.index - 1);
    if (e.key === 'ArrowRight') showRecommendation(MAP.index + 1);
    if (e.key === 'Escape') setWeatherPanel(false);
  });

  // Swipe left/right on the card
  let startX = null;
  let startY = null;
  const card = $('#map-card');
  card.addEventListener('touchstart', (e) => { startX = e.touches[0].clientX; startY = e.touches[0].clientY; }, { passive: true });
  card.addEventListener('touchend', (e) => {
    if (startX === null) return;
    const dx = e.changedTouches[0].clientX - startX;
    const dy = e.changedTouches[0].clientY - startY;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) showRecommendation(MAP.index + (dx < 0 ? 1 : -1));
    startX = null;
  }, { passive: true });

  // Map height = screen minus header (kept in a CSS variable)
  const setHeaderHeight = () => document.documentElement.style.setProperty('--header-h', `${$('.site-header').offsetHeight}px`);
  setHeaderHeight();
  window.addEventListener('resize', () => {
    setHeaderHeight();
    if (MAP.map && !$('#view-results').hidden) MAP.map.invalidateSize();
  });

  // Follow theme changes with matching map tiles
  if (window.matchMedia) window.matchMedia('(prefers-color-scheme: dark)').addEventListener?.('change', setTiles);
}

/* ---------------------------------------------------------------------
   11. FAVORITES (LocalStorage)
   Stored as [{ id, savedAt, place? }]. Curated places are looked up by id
   (so edits to destinations.json show up); live places keep a snapshot.
   --------------------------------------------------------------------- */

const getFavorites = () => {
  const favs = store.get(STORAGE_KEYS.favorites, []);
  return Array.isArray(favs) ? favs.filter((f) => f && typeof f.id === 'string') : [];
};
const isFavorite = (id) => getFavorites().some((f) => f.id === id);

function toggleFavorite(id) {
  const favs = getFavorites();
  const exists = favs.some((f) => f.id === id);
  const place = findPlace(id);
  const entry = { id, savedAt: Date.now() };
  if (place && place.source === 'live') entry.place = place; // live places only exist in this snapshot
  const next = exists ? favs.filter((f) => f.id !== id) : [...favs, entry];
  const ok = store.set(STORAGE_KEYS.favorites, next);
  if (!ok) showToast("Couldn't save. Your browser is blocking storage.");
  else showToast(exists ? `Removed ${place ? place.name : 'place'} from favorites` : `Saved ${place ? place.name : 'place'} to favorites`);
  syncSaveButtons();
  updateFavCount();
  return !exists;
}

function syncSaveButtons() {
  $$('[data-save]').forEach((btn) => {
    const saved = isFavorite(btn.dataset.save);
    btn.setAttribute('aria-pressed', String(saved));
    btn.querySelector('.save-label').textContent = saved ? 'Saved' : 'Save';
  });
}

function updateFavCount() {
  const n = getFavorites().filter((f) => findPlace(f.id) || f.place).length;
  const el = $('#fav-count');
  el.textContent = String(n);
  el.hidden = n === 0;
}

function renderFavorites() {
  const favs = getFavorites()
    .map((f) => ({ ...f, place: findPlace(f.id) || f.place }))
    .filter((f) => f.place && f.place.name)
    .sort((a, b) => b.savedAt - a.savedAt);
  const lastPrefs = store.get(STORAGE_KEYS.prefs, {});
  const mode = CONFIG.MODES[lastPrefs.mode] ? lastPrefs.mode : 'driving';
  const origin = lastPrefs.origin === 'zip' && /^\d{5}$/.test(lastPrefs.zip || '') ? { zip: lastPrefs.zip } : null;

  renderWheel(favs.map((f) => f.place), mode, origin);

  if (!favs.length) {
    $('#favorites-list').innerHTML = `<div class="empty">
        <h2>No favorites yet</h2>
        <p>Tap <strong>Save</strong> on any recommendation and it will show up here, even offline.</p>
        <a class="btn btn-primary" href="#/plan">Find an escape</a>
      </div>`;
    return;
  }

  const list = $('#favorites-list');
  if (!favs.some((f) => f.place.id === FAV_TREE.selected)) FAV_TREE.selected = null;
  FAV_TREE.picked.forEach((id) => { if (!favs.some((f) => f.place.id === id)) FAV_TREE.picked.delete(id); });
  list.classList.toggle('is-selecting', FAV_TREE.selecting);
  list.innerHTML = '<div class="fav-toolbar" id="fav-toolbar"></div>' + favTreeHTML(favs)
    + '<div class="fav-detail" id="fav-detail" aria-live="polite"></div>';
  renderFavToolbar(favs);
  renderFavDetail(favs, mode, origin);
  list.onclick = (e) => {
    const act = e.target.closest('[data-fav-act]');
    if (act) { onFavAction(act.dataset.favAct, favs); return; }
    const leaf = e.target.closest('[data-fav-leaf]');
    if (!leaf) return;
    const id = leaf.dataset.favLeaf;
    if (FAV_TREE.selecting) {
      // Select mode: tap to mark places for removal
      if (FAV_TREE.picked.has(id)) FAV_TREE.picked.delete(id); else FAV_TREE.picked.add(id);
      $$('[data-fav-leaf]', list).forEach((b) => b.setAttribute('aria-pressed', String(FAV_TREE.picked.has(b.dataset.favLeaf))));
      renderFavToolbar(favs);
      return;
    }
    // Tap a bubble to raise it and show the place below the tree; tap it again to put it back.
    FAV_TREE.selected = FAV_TREE.selected === id ? null : id;
    $$('[data-fav-leaf]', list).forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.favLeaf === FAV_TREE.selected)));
    renderFavDetail(favs, mode, origin);
    if (FAV_TREE.selected) $('#fav-detail').scrollIntoView({ behavior: prefersReducedMotion() ? 'auto' : 'smooth', block: 'nearest' });
  };
}

/* --- Removing favorites: Select (pick several) and Remove all --- */
function renderFavToolbar(favs) {
  const n = FAV_TREE.picked.size;
  $('#fav-toolbar').innerHTML = FAV_TREE.selecting
    ? `<span class="fav-picked" aria-live="polite">${n ? `${n} selected` : 'Tap places to select them'}</span>
       <button type="button" class="btn btn-small btn-danger" data-fav-act="remove-picked"${n ? '' : ' disabled'}>Remove selected</button>
       <button type="button" class="btn btn-small" data-fav-act="cancel">Cancel</button>`
    : `<button type="button" class="btn btn-small" data-fav-act="select">Select</button>
       <button type="button" class="btn btn-small btn-danger" data-fav-act="remove-all">Remove all</button>`;
  const hint = $('.fav-hint');
  if (hint) hint.textContent = FAV_TREE.selecting ? 'Tap the places you want to remove.' : 'Tap one of your places to see it.';
}

function onFavAction(action, favs) {
  if (action === 'select') {
    FAV_TREE.selecting = true;
    FAV_TREE.selected = null;
    FAV_TREE.picked.clear();
  } else if (action === 'cancel') {
    FAV_TREE.selecting = false;
    FAV_TREE.picked.clear();
  } else if (action === 'remove-picked') {
    removeFavorites([...FAV_TREE.picked]);
    FAV_TREE.selecting = false;
    FAV_TREE.picked.clear();
  } else if (action === 'remove-all') {
    const n = favs.length;
    if (!window.confirm(`Remove all ${n} favorite${n === 1 ? '' : 's'}? This can't be undone.`)) return;
    removeFavorites(favs.map((f) => f.place.id));
  }
  renderFavorites();
}

/** Remove several favorites at once (one save, one message). */
function removeFavorites(ids) {
  if (!ids.length) return;
  const gone = new Set(ids);
  if (!store.set(STORAGE_KEYS.favorites, getFavorites().filter((f) => !gone.has(f.id)))) {
    showToast("Couldn't save. Your browser is blocking storage.");
    return;
  }
  syncSaveButtons();
  updateFavCount();
  showToast(ids.length === 1 ? 'Removed 1 favorite' : `Removed ${ids.length} favorites`);
}

/* --- Favorites tree ---
   Each favorite is a round bubble on a tree (most recent at the top), on its own branch.
   Bubbles are buttons placed over an SVG tree by percentage, so branches and bubbles stay
   lined up at any size. Spare spots get plain bubbles so the canopy is always full. */
const FAV_TREE = {
  // The tree, in a 1000 x 900 drawing: a curved trunk, wide at the roots and tapering up into the crown,
  // with one branch off the right side ending in a point. Filled outlines worked out from smooth centerlines.
  bark: [
    'M571 875 L569 872 L566 870 L562 866 L558 863 L554 859 L550 855 L546 851 L542 847 L538 842 L536 838 L533 833 L531 829 L530 824 L528 820 L527 816 L526 812 L526 809 L525 805 L524 802 L524 799 L524 795 L523 791 L523 787 L523 783 L523 779 L523 774 L523 770 L524 765 L524 761 L524 756 L525 752 L525 748 L526 743 L527 739 L528 734 L529 729 L530 724 L531 719 L532 714 L533 709 L534 705 L535 700 L536 696 L537 692 L538 687 L539 682 L540 677 L542 672 L543 667 L543 661 L544 656 L545 651 L545 645 L546 640 L546 635 L546 630 L546 625 L546 620 L546 615 L546 610 L546 605 L545 599 L545 594 L544 589 L544 585 L543 581 L542 577 L542 573 L541 570 L541 567 L540 564 L540 561 L540 558 L539 555 L539 553 L539 550 L539 548 L538 546 L538 544 L538 543 L478 547 L478 549 L478 550 L478 552 L478 555 L478 557 L479 560 L479 563 L479 566 L479 569 L479 573 L479 577 L480 581 L480 585 L481 589 L481 593 L482 596 L482 600 L482 604 L482 607 L482 610 L482 614 L482 618 L481 621 L481 625 L480 629 L480 633 L479 637 L478 641 L477 645 L477 649 L476 652 L475 656 L474 660 L472 663 L471 667 L470 672 L468 676 L466 681 L465 686 L463 691 L462 696 L460 700 L459 705 L457 710 L455 715 L454 721 L452 726 L450 732 L449 738 L448 744 L446 749 L445 755 L444 761 L443 766 L443 772 L442 778 L441 783 L441 789 L440 795 L440 801 L440 807 L440 813 L441 819 L441 825 L442 830 L442 835 L442 839 L442 844 L442 848 L440 852 L439 857 L437 862 L434 867 L432 872 L429 878 L426 883 L423 886 L420 886 L418 886 L417 886 Z',
    'M522 714 L524 712 L527 710 L530 707 L534 704 L538 700 L542 697 L546 693 L551 689 L555 685 L559 682 L563 678 L567 675 L571 672 L575 668 L580 665 L584 661 L588 657 L593 653 L597 649 L601 645 L605 641 L608 636 L612 631 L616 625 L619 620 L622 615 L625 610 L628 606 L630 603 L632 600 L630 602 L626 605 L623 608 L619 612 L614 616 L610 620 L605 624 L600 628 L596 632 L591 635 L587 638 L583 641 L578 643 L573 646 L569 649 L564 652 L559 654 L554 657 L550 660 L545 662 L540 665 L536 668 L531 670 L526 673 L521 676 L516 678 L512 681 L508 683 L505 685 L502 686 Z',
  ],
  // The canopy: a round crown of bubbles packed in offset rows (a dome that sits on the trunk), like leaves
  // bunching together. Favorites fill it from the middle outward (newest first); spare spots get plain
  // bubbles, so the crown is always full and round. [x, y, size]. The drawing is 1000 x 900.
  // Wide screens: 17 bubbles in rows of 1, 4, 5, 4 and 3, just touching.
  slots: [
    [512, 330, 1], [437, 200, 1], [587, 200, 1], [437, 460, 1], [587, 460, 1], [362, 330, 1],
    [662, 330, 1], [512, 75, 1], [287, 200, 1], [737, 200, 1], [212, 330, 1], [812, 330, 1],
    [287, 460, 1], [737, 460, 1], [362, 590, 1], [662, 590, 1], [512, 590, 1],
  ],
  // Phones: 7 bigger bubbles in a round 2-3-2 crown, so names stay readable.
  phoneSlots: [
    [512, 405, 1], [395, 200, 1], [630, 200, 1], [277, 405, 1], [747, 405, 1], [395, 610, 1], [630, 610, 1],
  ],
  phone: () => Boolean(window.matchMedia && window.matchMedia('(max-width: 600px)').matches),
  top: 0, height: 900, // the part of the drawing that's shown
  selected: null,     // id of the bubble that's raised, with its details shown below
  selecting: false,   // Select mode: tapping marks places for removal instead
  picked: new Set(),  // ids marked in Select mode
};

/** Where a bubble sits, as percentages of the tree (drawing units: x 0-1000, y shown from FAV_TREE.top). */
const placeStyle = (x, y, size) => `left:${x / 10}%;top:${((y - FAV_TREE.top) / FAV_TREE.height) * 100}%;--s:${size}`;

function favTreeHTML(favs) {
  const { bark } = FAV_TREE;
  const slots = FAV_TREE.phone() ? FAV_TREE.phoneSlots : FAV_TREE.slots;
  const onTree = favs.slice(0, slots.length);
  // Spare spots in the canopy: plain bubbles (just foliage, not buttons)
  const fillers = slots.slice(onTree.length).map(([x, y, size], k) => {
    const i = onTree.length + k;
    return `<span class="fav-leaf is-filler" aria-hidden="true" style="${placeStyle(x, y, size)}"></span>`;
  }).join('');
  const bubble = (f, i, extra = '') => {
    const slot = slots[i];
    const pos = slot ? ` style="${placeStyle(...slot)}"` : '';
    return `<button type="button" class="fav-leaf${extra}"${pos}
        data-fav-leaf="${esc(f.place.id)}" aria-pressed="${f.place.id === FAV_TREE.selected}"
        aria-label="${esc(f.place.name)}: show details"><span class="fav-leaf-name">${esc(f.place.name)}</span></button>`;
  };
  const more = favs.slice(slots.length);
  return `<div class="fav-tree" role="group" aria-label="Your favorite places, as bubbles on a tree">
      <svg class="tree-art" viewBox="0 ${FAV_TREE.top} 1000 ${FAV_TREE.height}" aria-hidden="true">
        <ellipse class="tree-ground" cx="495" cy="880" rx="230" ry="16"/>
        ${bark.map((d) => `<path class="tree-trunk" d="${d}"/>`).join('')}
      </svg>
      ${fillers}
      ${onTree.map((f, i) => bubble(f, i)).join('')}
    </div>
    ${more.length ? `<div class="fav-more"><p class="fav-more-title">More favorites</p>${more.map((f, i) => bubble(f, slots.length + i, ' is-chip')).join('')}</div>` : ''}
    <p class="fav-hint">Tap one of your places to see it.</p>`;
}

/** The raised bubble's place, below the tree (same details and buttons as before: directions, remove). */
function renderFavDetail(favs, mode, origin) {
  const box = $('#fav-detail');
  const f = favs.find((x) => x.place.id === FAV_TREE.selected);
  if (!f) { box.innerHTML = ''; return; }
  const { place, savedAt } = f;
  box.innerHTML = `
    <article class="card fav-card">
      <div class="card-body">
        <p class="card-eyebrow">${esc(place.kindLabel || TYPE_LABELS[place.type] || place.type)} · saved ${esc(new Date(savedAt).toLocaleDateString([], { month: 'short', day: 'numeric' }))}</p>
        <h2 class="card-title">${esc(place.name)}</h2>
        <p class="fav-desc">${esc(place.description)}</p>
        <p class="note">${esc(hoursText(place))}</p>
        <ul class="tags">${place.environment.map((e) => `<li>${esc(ENVIRONMENTS[e] ? ENVIRONMENTS[e].label : e)}</li>`).join('')}</ul>
        ${detailsHTML(place)}
        <div class="actions">
          <a class="btn btn-primary" href="${esc(directionsUrl(place, mode, origin))}" target="_blank" rel="noopener">Directions</a>
          <button type="button" class="btn btn-danger" data-remove="${esc(place.id)}">Remove</button>
        </div>
      </div>
    </article>`;
}

/* --- Spin the wheel (Favorites page) ---
   Each favorite gets an equal slice. The pick is made first (crypto random),
   then the wheel animates so that slice stops under the pointer at the top. */
const WHEEL = {
  colors: ['#2f6b4f', '#b9772f', '#5f9a72', '#8a6a3b', '#3f7d5a', '#c8873a', '#245740', '#a8894f'],
  maxSlices: 16,       // most recent favorites on the wheel
  spinMs: 4200,
  rotation: 0,
  spinning: false,
  places: [],
  mode: 'driving',
  origin: null,
};

function randomInt(n) {
  try {
    const a = new Uint32Array(1);
    crypto.getRandomValues(a);
    return a[0] % n;
  } catch (err) {
    return Math.floor(Math.random() * n);
  }
}

/** Point on a circle; 0 deg = top, clockwise. */
function wheelPoint(r, deg) {
  const a = ((deg - 90) * Math.PI) / 180;
  return `${(r * Math.cos(a)).toFixed(2)} ${(r * Math.sin(a)).toFixed(2)}`;
}

/** Slice label along the radius, ending near the rim, always reading left-to-right. */
function wheelLabel(name, mid, outer, font) {
  const right = mid <= 180; // right half reads outward; left half is flipped so it isn't upside down
  const transform = right ? `rotate(${(mid - 90).toFixed(2)})` : `rotate(${(mid + 90).toFixed(2)})`;
  const x = right ? outer : -outer;
  return `<text transform="${transform}" x="${x.toFixed(2)}" y="0" text-anchor="${right ? 'end' : 'start'}" dominant-baseline="middle"
    font-size="${font}" font-weight="700" fill="#fff">${esc(name)}</text>`;
}

function wheelSVG(places) {
  const n = places.length;
  const seg = 360 / n;
  const R = 98;
  const font = n <= 4 ? 8.5 : n <= 8 ? 7.5 : n <= 12 ? 6.2 : 5.2;
  const inner = 18;  // keep clear of the center hub
  const outer = R - 7;
  const maxChars = Math.floor((outer - inner) / (font * 0.56)); // what fits between hub and rim
  const slices = places.map((p, i) => {
    const a0 = i * seg;
    const a1 = (i + 1) * seg;
    const mid = a0 + seg / 2;
    const large = seg > 180 ? 1 : 0;
    const color = WHEEL.colors[i % WHEEL.colors.length];
    const name = p.name.length > maxChars ? `${p.name.slice(0, maxChars - 1).trim()}…` : p.name;
    return `<path d="M0 0 L${wheelPoint(R, a0)} A${R} ${R} 0 ${large} 1 ${wheelPoint(R, a1)} Z" fill="${color}" stroke="#fff" stroke-width="1"/>
      ${wheelLabel(name, mid, outer, font)}`;
  }).join('');
  return `<svg viewBox="-100 -100 200 200" class="wheel-svg" role="img" aria-label="Wheel with ${n} favorite places">
      <circle r="99.5" fill="#fff"/>${slices}<circle r="14" fill="#fff"/><circle r="9" fill="var(--primary)"/>
    </svg>`;
}

function renderWheel(places, mode, origin) {
  const box = $('#spin-section');
  WHEEL.places = places.slice(0, WHEEL.maxSlices);
  WHEEL.mode = mode;
  WHEEL.origin = origin;
  WHEEL.spinning = false;
  if (places.length === 0) { box.innerHTML = ''; return; }
  if (places.length < 2) {
    box.innerHTML = `<section class="spin-panel spin-panel-small">
        <h2 class="spin-title">Spin the wheel</h2>
        <p class="spin-help">Save at least one more place and the wheel can pick between your favorites for you.</p>
      </section>`;
    return;
  }
  const more = places.length > WHEEL.maxSlices ? ` (your ${WHEEL.maxSlices} most recent)` : '';
  box.innerHTML = `<section class="spin-panel" aria-labelledby="spin-title">
      <div class="spin-head">
        <h2 class="spin-title" id="spin-title">Can't decide? Spin the wheel</h2>
        <p class="spin-help">The wheel picks one of your ${WHEEL.places.length} favorites${more} at random.</p>
      </div>
      <div class="wheel-wrap">
        <div class="wheel-pointer" aria-hidden="true"></div>
        <div class="wheel" id="wheel" style="transform: rotate(${WHEEL.rotation}deg)">${wheelSVG(WHEEL.places)}</div>
      </div>
      <div class="spin-controls">
        <button type="button" class="btn btn-primary spin-btn" id="spin-btn">Spin</button>
        <div class="spin-result" id="spin-result" aria-live="polite"></div>
      </div>
    </section>`;
  $('#spin-btn').addEventListener('click', spinWheel);
}

function spinWheel() {
  if (WHEEL.spinning || WHEEL.places.length < 2) return;
  const n = WHEEL.places.length;
  const pick = randomInt(n);
  const seg = 360 / n;
  const jitter = (randomInt(1000) / 1000 - 0.5) * seg * 0.6; // land somewhere inside the slice, not dead center
  const finalAngle = (((360 - ((pick + 0.5) * seg + jitter)) % 360) + 360) % 360;
  const current = WHEEL.rotation;
  let next = current - (((current % 360) + 360) % 360) + 360 * 5 + finalAngle;
  if (next - current < 360 * 4) next += 360;

  const wheel = $('#wheel');
  const btn = $('#spin-btn');
  const instant = prefersReducedMotion();
  WHEEL.spinning = true;
  WHEEL.rotation = next;
  btn.disabled = true;
  btn.textContent = 'Spinning…';
  $('#spin-result').innerHTML = '';
  wheel.style.transition = instant ? 'none' : `transform ${WHEEL.spinMs}ms cubic-bezier(.12, .62, .08, 1)`;
  wheel.style.transform = `rotate(${next}deg)`;
  setTimeout(() => {
    WHEEL.spinning = false;
    btn.disabled = false;
    btn.textContent = 'Spin again';
    showSpinResult(WHEEL.places[pick]);
  }, instant ? 0 : WHEEL.spinMs + 100);
}

function showSpinResult(place) {
  $('#spin-result').innerHTML = `<div class="spin-pick">
      <p class="eyebrow">The wheel picked</p>
      <h3 class="spin-pick-name">${esc(place.name)}</h3>
      <p class="spin-pick-meta">${esc(place.kindLabel || TYPE_LABELS[place.type] || place.type)} · ${esc(hoursText(place))}</p>
      <div class="spin-pick-actions">
        <a class="btn btn-primary" href="${esc(directionsUrl(place, WHEEL.mode, WHEEL.origin))}" target="_blank" rel="noopener">Get directions</a>
        <button type="button" class="btn" id="spin-map"><span class="btn-label">Show on map</span><span class="spinner" aria-hidden="true"></span></button>
      </div>
    </div>`;
  $('#spin-map').addEventListener('click', (e) => showPlaceOnMap(place, e.currentTarget));
}

/** Open the results map on one place (the wheel's pick): pin #1, with its card showing.
    Uses this session's search if there is one, otherwise runs one from your location (or ZIP)
    with your last plan. A place outside the plan still shows, with the reason as a note. */
async function showPlaceOnMap(place, btn) {
  const label = btn.querySelector('.btn-label');
  btn.classList.add('loading');
  btn.disabled = true;
  label.textContent = 'Opening map…';
  try {
    let results = state.results;
    if (!results) {
      const saved = { ...DEFAULT_PREFS, freeMin: 120, wantStayMin: 30, ...store.get(STORAGE_KEYS.prefs, {}) };
      if (locationState.status === 'pending') await Promise.race([locationState.promise, new Promise((r) => setTimeout(r, 6000))]);
      if (locationState.status === 'ok') saved.origin = 'location';
      else if (/^\d{5}$/.test(saved.zip || '')) saved.origin = 'zip';
      else {
        showToast('Set your starting point on the Plan page first.');
        location.hash = '#/plan';
        return;
      }
      results = await runSearch(saved);
    }
    putPlaceFirst(results, place);
    state.results = results;
    if (location.hash === '#/results') route(); else location.hash = '#/results';
  } catch (err) {
    if (!(err instanceof SearchError)) console.error(err);
    showToast(err instanceof SearchError ? err.message : "Couldn't open the map. Please try again.");
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
    label.textContent = 'Show on map';
  }
}

/** Move a place to the front of the results, adding it (fit-checked against the same plan) if it isn't there. */
function putPlaceFirst(results, place) {
  const i = results.fitting.findIndex((f) => f.place.id === place.id);
  if (i >= 0) { results.fitting.unshift(...results.fitting.splice(i, 1)); return; }
  indexPlaces([place]);
  const ctx = {
    origin: results.origin, mode: results.prefs.mode, activity: results.prefs.activity, freeMin: results.prefs.freeMin,
    wantStayMin: results.prefs.wantStayMin || 30, start: results.start, sun: results.sun,
  };
  const fit = walkSwap(checkFit(place, ctx), ctx);
  const missed = fit.verdict === 'no';
  results.fitting.unshift({
    ...fit,
    verdict: missed ? 'short' : fit.verdict, // it's on the map because you asked for it, so show it rather than hide it
    notes: missed ? [fit.reason.replace(/\.$/, ''), ...fit.notes] : fit.notes,
    scoring: scorePlace(fit, { ...results.prefs, mode: fit.mode }, results.wx),
  });
}

/* ---------------------------------------------------------------------
   12. APP WIRING: form, routing, theme, service worker
   --------------------------------------------------------------------- */

const DEFAULT_PREFS = {
  kind: 'parks', time: '60', customMinutes: '', stay: '30', stayCustom: '', when: 'now', laterTime: '',
  activity: 'walking', mode: 'walking', environment: 'quiet', zip: '',
};

/** Render a group of radio "chips" into a [data-group] container. */
function renderChips(root, group, options, selected) {
  const box = root.querySelector(`[data-group="${group}"]`);
  box.innerHTML = options.map((o) => `
    <label class="chip">
      <input type="radio" name="${group}" value="${esc(o.value)}" ${o.value === selected ? 'checked' : ''}>
      <span class="chip-face">${esc(o.label)}</span>
    </label>`).join('');
}

const toOptions = (obj) => Object.entries(obj).filter(([, o]) => !o.hidden).map(([value, o]) => ({ value, label: o.label }));

/** Fill a plan form (the main form or the change-plan sheet) with prefs. */
function fillForm(form, prefs) {
  const p = { ...DEFAULT_PREFS, ...prefs };
  if (!ACTIVITIES[p.activity] || ACTIVITIES[p.activity].hidden) p.activity = DEFAULT_PREFS.activity;
  renderChips(form, 'kind', KIND_OPTIONS, p.kind);
  renderChips(form, 'time', TIME_OPTIONS, p.time);
  renderChips(form, 'stay', STAY_OPTIONS, p.stay);
  renderChips(form, 'when', WHEN_OPTIONS, p.when);
  renderChips(form, 'activity', toOptions(ACTIVITIES), p.activity);
  renderChips(form, 'mode', toOptions(CONFIG.MODES), p.mode);
  renderChips(form, 'environment', toOptions(ENVIRONMENTS), p.environment);
  setHoursMins(form, 'custom', p.customMinutes);
  setHoursMins(form, 'stay', p.stayCustom);
  form.elements.laterTime.value = p.laterTime || '';
  form.elements.zip.value = p.zip || '';
  syncReveals(form);
}

/* Custom times are typed as hours + minutes (two boxes); plans still store total minutes. */
/** Total minutes from a form's `<name>Hours` and `<name>Mins` boxes, or '' when both are empty. */
function readHoursMins(form, name) {
  const h = form.elements[`${name}Hours`].value.trim();
  const m = form.elements[`${name}Mins`].value.trim();
  if (!h && !m) return '';
  return String(Number(h || 0) * 60 + Number(m || 0));
}

/** Fill a form's hour and minute boxes from total minutes (90 -> 1 hr 30 min). */
function setHoursMins(form, name, minutes) {
  const total = Number(minutes);
  const has = minutes !== '' && minutes != null && Number.isFinite(total);
  form.elements[`${name}Hours`].value = has && total >= 60 ? String(Math.floor(total / 60)) : '';
  form.elements[`${name}Mins`].value = has && total % 60 ? String(total % 60) : (has && total < 60 ? '0' : '');
}

/** Show the custom time / start-time inputs only when those chips are picked,
    and hide the park-only questions (activity, environment) for study spots and food. */
function syncReveals(form) {
  const notParks = form.elements.kind.value !== 'parks';
  form.querySelectorAll('[data-parks-only]').forEach((el) => { el.hidden = notParks; });
  const time = form.elements.time.value;
  const when = form.elements.when.value;
  form.querySelector('[data-reveal="custom"]').hidden = time !== 'custom';
  form.querySelector('[data-reveal="stay-custom"]').hidden = form.elements.stay.value !== 'custom';
  form.querySelector('[data-reveal="later"]').hidden = when !== 'later';
  if (when === 'later' && !form.elements.laterTime.value) {
    const d = addMin(new Date(), 60);
    form.elements.laterTime.value = `${String(d.getHours()).padStart(2, '0')}:00`;
  }
}

function setupForm() {
  const form = $('#plan-form');
  fillForm(form, store.get(STORAGE_KEYS.prefs, {}));
  form.addEventListener('change', () => syncReveals(form));

  requestLocation();

  // Live ZIP feedback (only visible when location is off)
  const zipInput = $('#zip');
  const syncZip = () => {
    zipInput.value = zipInput.value.replace(/\D/g, '').slice(0, 5);
    const z = zipInput.value;
    const label = $('#zip-label');
    const known = z.length === 5 && (store.get(`${STORAGE_KEYS.zipPrefix}${z}`, null) || state.zips[z]);
    if (known) { label.textContent = known.label; label.className = 'zip-label ok'; }
    else if (z.length === 5 && !GEO.key) { label.textContent = 'Only San Jose ZIPs work without a Geoapify key'; label.className = 'zip-label warn'; }
    else { label.textContent = ''; label.className = 'zip-label'; }
    $('#zip-error').hidden = true;
  };
  zipInput.addEventListener('input', syncZip);
  syncZip();

  form.addEventListener('submit', onSubmit);
}

/** Read + validate a plan form. Returns { prefs } or { error, field } (field = input name). */
function readForm(form) {
  const f = form.elements;
  const raw = {
    kind: ['study', 'food'].includes(f.kind.value) ? f.kind.value : 'parks',
    time: f.time.value, customMinutes: readHoursMins(form, 'custom'),
    stay: f.stay.value, stayCustom: readHoursMins(form, 'stay'),
    when: f.when.value, laterTime: f.laterTime.value,
    activity: f.activity.value, mode: f.mode.value, environment: f.environment.value,
    zip: f.zip.value.trim(),
  };
  let freeMin = Number(raw.time);
  if (raw.time === 'custom') {
    freeMin = raw.customMinutes === '' ? NaN : Number(raw.customMinutes);
    if (!Number.isFinite(freeMin) || freeMin < 10 || freeMin > 720) {
      return { error: 'Enter a custom time between 10 min and 12 hr.', field: 'customHours' };
    }
  }
  let wantStayMin = Number(raw.stay);
  if (raw.stay === 'custom') {
    wantStayMin = raw.stayCustom === '' ? NaN : Number(raw.stayCustom);
    if (!Number.isFinite(wantStayMin) || wantStayMin < 5 || wantStayMin > 600) {
      return { error: 'Enter how long you want to stay, between 5 min and 10 hr.', field: 'stayHours' };
    }
  }
  raw.wantStayMin = Math.round(wantStayMin || 30);
  if (raw.when === 'later' && !raw.laterTime) return { error: 'Pick a start time.', field: 'laterTime' };
  if (locationState.status === 'ok') return { prefs: { ...raw, origin: 'location', freeMin: Math.round(freeMin) } };
  if (!/^\d{5}$/.test(raw.zip)) return { error: 'Enter a 5-digit US ZIP code.', field: 'zip', zip: true };
  return { prefs: { ...raw, origin: 'zip', freeMin: Math.round(freeMin) } };
}

async function onSubmit(event) {
  event.preventDefault();
  $('#form-error').hidden = true;
  $('#zip-error').hidden = true;

  // Still waiting on the location prompt? Give it a few seconds, then fall back to ZIP.
  if (locationState.status === 'pending') {
    await Promise.race([locationState.promise, new Promise((r) => setTimeout(r, 6000))]);
    if (locationState.status === 'pending') {
      showZipFallback("Still waiting for location access. You can enter your ZIP code instead:");
      $('#zip').focus();
      return;
    }
  }

  const form = $('#plan-form');
  const parsed = readForm(form);
  if (parsed.error) {
    const box = parsed.zip ? $('#zip-error') : $('#form-error');
    box.textContent = parsed.error;
    box.hidden = false;
    form.elements[parsed.field].focus();
    return;
  }

  store.set(STORAGE_KEYS.prefs, parsed.prefs);
  const btn = $('#submit-btn');
  btn.classList.add('loading');
  btn.disabled = true;
  btn.querySelector('.btn-label').textContent = 'Finding places near you…';
  try {
    const results = await runSearch(parsed.prefs);
    if (results.origin.source !== 'location') {
      const label = $('#zip-label');
      label.textContent = results.origin.label;
      label.className = 'zip-label ok';
    }
    if (location.hash === '#/results') route(); else location.hash = '#/results';
  } catch (err) {
    if (!(err instanceof SearchError)) console.error(err);
    const box = err instanceof SearchError ? $('#zip-error') : $('#form-error');
    box.textContent = err instanceof SearchError ? err.message : 'Something went wrong while searching. Please try again.';
    box.hidden = false;
    if (err instanceof SearchError && !$('#zip-wrap').hidden) $('#zip').focus();
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = 'Find my escape';
  }
}

/* --- "Change plan" sheet on the results map ---
   Slides up with the same options as the plan form. "Recalculate plan"
   re-runs the search in place; "Cancel" closes it without changes. */
function openPlanSheet() {
  const results = state.results;
  const form = $('#sheet-form');
  fillForm(form, (results && results.formPrefs) || store.get(STORAGE_KEYS.prefs, {}));
  const usingLocation = locationState.status === 'ok';
  $('#sheet-location').hidden = !usingLocation;
  if (usingLocation) $('#sheet-location').textContent = $('#location-status').textContent;
  $('#sheet-zip-wrap').hidden = usingLocation;
  $('#sheet-error').hidden = true;
  setWeatherPanel(false);
  $('#sheet-backdrop').hidden = false;
  $('#plan-sheet').hidden = false;
  requestAnimationFrame(() => {
    $('#plan-sheet').classList.add('open');
    $('#sheet-backdrop').classList.add('open');
  });
  form.querySelector('input:checked').focus({ preventScroll: true });
}

function closePlanSheet() {
  const sheet = $('#plan-sheet');
  if (sheet.hidden) return;
  sheet.classList.remove('open');
  $('#sheet-backdrop').classList.remove('open');
  const done = () => { sheet.hidden = true; $('#sheet-backdrop').hidden = true; };
  if (prefersReducedMotion()) done(); else setTimeout(done, 260);
  $('#change-plan-btn').focus({ preventScroll: true });
}

const isSheetOpen = () => !$('#plan-sheet').hidden;

async function recalculatePlan(event) {
  event.preventDefault();
  const form = $('#sheet-form');
  const err = $('#sheet-error');
  err.hidden = true;
  const parsed = readForm(form);
  if (parsed.error) {
    err.textContent = parsed.error;
    err.hidden = false;
    form.elements[parsed.field].focus();
    return;
  }
  const btn = $('#sheet-recalc');
  btn.classList.add('loading');
  btn.disabled = true;
  btn.querySelector('.btn-label').textContent = 'Recalculating…';
  try {
    await runSearch(parsed.prefs);
    store.set(STORAGE_KEYS.prefs, parsed.prefs);
    fillForm($('#plan-form'), parsed.prefs); // keep the Plan page in sync
    closePlanSheet();
    renderResults();
  } catch (e) {
    if (!(e instanceof SearchError)) console.error(e);
    err.textContent = e instanceof SearchError ? e.message : 'Something went wrong while searching. Please try again.';
    err.hidden = false;
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
    btn.querySelector('.btn-label').textContent = 'Recalculate plan';
  }
}

function setupPlanSheet() {
  const form = $('#sheet-form');
  form.addEventListener('change', () => syncReveals(form));
  form.addEventListener('submit', recalculatePlan);
  form.elements.zip.addEventListener('input', () => { form.elements.zip.value = form.elements.zip.value.replace(/\D/g, '').slice(0, 5); });
  $('#change-plan-btn').addEventListener('click', openPlanSheet);
  $('#sheet-cancel').addEventListener('click', closePlanSheet);
  $('#sheet-backdrop').addEventListener('click', closePlanSheet);
}

/* --- Starting point: device location first, ZIP code only as a fallback ---
   Coordinates are rounded to ~100 m before they're sent to Geoapify / Open-Meteo. */
const locationState = { status: 'pending', origin: null, promise: Promise.resolve(null) };
const round3 = (n) => Math.round(n * 1000) / 1000;
const round4 = (n) => Math.round(n * 10000) / 10000; // ~10 m, used only to find the nearest parking lot

function requestLocation() {
  locationState.promise = new Promise((resolve) => {
    if (!('geolocation' in navigator)) { resolve({ error: "This browser can't share your location." }); return; }
    if (!window.isSecureContext) { resolve({ error: 'Location only works on https or localhost.' }); return; }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({
        lat: round3(pos.coords.latitude), lng: round3(pos.coords.longitude),
        precise: { lat: round4(pos.coords.latitude), lng: round4(pos.coords.longitude) },
      }),
      (err) => resolve({ error: err.code === 1 ? 'Location access is off.' : "We couldn't get your location." }),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 5 * 60000 },
    );
  }).then((res) => {
    if (res.error) {
      locationState.status = 'off';
      showZipFallback(`${res.error} Enter your ZIP code instead:`);
      return null;
    }
    const origin = { lat: res.lat, lng: res.lng, precise: res.precise, label: 'your location', source: 'location' };
    locationState.status = 'ok';
    locationState.origin = origin;
    renderLocationStatus();
    reverseGeocode(origin).then((label) => { if (label) { origin.label = label; renderLocationStatus(); } });
    return origin;
  });
  return locationState.promise;
}

function renderLocationStatus() {
  const el = $('#location-status');
  const o = locationState.origin;
  el.textContent = `Using your current location${o.label !== 'your location' ? ` (${o.label})` : ''}`;
  el.className = 'location-status ok';
  $('#zip-wrap').hidden = true;
}

function showZipFallback(message) {
  const el = $('#location-status');
  el.hidden = true;
  $('#zip-prompt').textContent = message;
  $('#zip-wrap').hidden = false;
}

/** "San Jose, CA" for the location label (optional nicety, cached). */
async function reverseGeocode(origin) {
  if (!GEO.key) return '';
  const key = `${STORAGE_KEYS.zipPrefix}rev.${origin.lat.toFixed(2)},${origin.lng.toFixed(2)}`;
  const cached = store.get(key, null);
  if (cached) return cached;
  try {
    const params = new URLSearchParams({ lat: String(origin.lat), lon: String(origin.lng), format: 'json', apiKey: GEO.key });
    const data = await fetchJson(`https://api.geoapify.com/v1/geocode/reverse?${params}`, 8000);
    const r = (data.results || [])[0];
    const label = r ? [r.city || r.town || r.village || r.county, r.state_code].filter(Boolean).join(', ') : '';
    if (label) store.set(key, label);
    return label;
  } catch (err) {
    return '';
  }
}

/** Origin for a search: device location if allowed, otherwise the ZIP. */
async function getOrigin(prefs) {
  if (prefs.origin === 'location') {
    const o = locationState.origin || await locationState.promise;
    if (o) return o;
    throw new SearchError('Location is off. Enter your ZIP code instead.');
  }
  return resolveZip(prefs.zip);
}

/* --- Class schedule (#/schedule) ---
   Classes are saved on this device: { id, name, room, days: ['mon', ...], start: 'HH:MM', end: 'HH:MM' }.
   Tests: { id, classId, type, date: 'YYYY-MM-DD', time: 'HH:MM' or '', note }.
   The Plan page uses both to offer "free until your next class" and study-spot nudges before tests. */
const SCHEDULE_DAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
const DAY_LABELS = { mon: 'Mon', tue: 'Tue', wed: 'Wed', thu: 'Thu', fri: 'Fri', sat: 'Sat', sun: 'Sun' };
const DAY_NAMES = { mon: 'Monday', tue: 'Tuesday', wed: 'Wednesday', thu: 'Thursday', fri: 'Friday', sat: 'Saturday', sun: 'Sunday' };
const TEST_TYPES = ['Quiz', 'Test', 'Midterm', 'Final'];
let editingClassId = null;
let editingTestId = null;
const timeFields = {}; // smart time fields by input id

const pad2 = (n) => String(n).padStart(2, '0');
const hhmmToMin = (t) => { const [h, m] = String(t).split(':').map(Number); return h * 60 + m; };
const nowMin = (d = new Date()) => d.getHours() * 60 + d.getMinutes();
/** "13:30" -> "1:30 PM" in the user's locale */
const fmtClock = (t) => { const d = new Date(); d.setHours(...String(t).split(':').map(Number), 0, 0); return fmtTime(d, { relativeDay: false }); };
const isoDate = (d = new Date()) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
const parseIsoDate = (s) => { const [y, m, d] = String(s).split('-').map(Number); return new Date(y, m - 1, d); };
/** Whole days from today until a 'YYYY-MM-DD' date (0 = today, negative = past). */
const daysUntil = (s) => Math.round((parseIsoDate(s) - parseIsoDate(isoDate())) / 86400000);
const countdownText = (n) => (n === 0 ? 'Today' : n === 1 ? 'Tomorrow' : `In ${n} days`);
const fmtDay = (s) => parseIsoDate(s).toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });

/* --- Smart time field ---
   One text box instead of separate hour / minute / AM-PM parts. Type "930" and it reads "9:30" with
   AM or PM picked for you; "1330" works too. Type "a" or "p", or tap the AM/PM button, to switch.
   `after` (optional) returns minutes-after-midnight that this time should come after (an end time
   follows its start), which decides the AM/PM guess. */

/** "930" -> ['9', '30'], "1015" -> ['10', '15'], "1" -> ['1', ''] (could still become 10-12). */
function splitTimeDigits(d) {
  const twoDigitHour = d[0] === '0' || (d[0] === '1' && d[1] <= '2')
    || (d.length === 4 && (d[0] === '1' || (d[0] === '2' && d[1] <= '3'))); // 24-hour "1330", "2015"
  return twoDigitHour && d.length >= 2 ? [d.slice(0, 2), d.slice(2)] : [d.slice(0, 1), d.slice(1)];
}

function makeSmartTime(input, { after, onChange } = {}) {
  let digits = '';
  let explicit = ''; // 'AM' | 'PM' once the user picks one
  const wrap = document.createElement('div');
  wrap.className = 'time-field';
  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'meridiem';
  input.parentNode.insertBefore(wrap, input);
  wrap.append(input, btn);

  const parts = () => { const [hd, md] = splitTimeDigits(digits); return { hd, md, h: Number(hd), m: Number(md || 0) }; };
  const meridiem = () => {
    const { hd, h, m } = parts();
    if (!hd) return '';
    if (explicit) return explicit;
    const start = after ? after() : null;
    if (start != null) return (h % 12) * 60 + m > start ? 'AM' : 'PM'; // earliest time after the start
    return h === 12 || h <= 6 ? 'PM' : 'AM'; // classes rarely start before 7 AM or after 6 PM
  };

  function render() {
    let { hd, md, h } = parts();
    if (md.length === 2 && hd.length === 2) {
      // Turn 24-hour input into 12-hour + AM/PM so the button still works.
      if (h > 12 && h <= 23) { digits = pad2(h - 12) + md; explicit = 'PM'; }
      if (h === 0) { digits = `12${md}`; explicit = 'AM'; }
      ({ hd, md, h } = parts());
    }
    if (!digits) explicit = '';
    const hourDone = hd.length === 2 || hd >= '2';
    input.value = !hd ? '' : !md && !hourDone ? hd : `${Number(hd)}:${md}`;
    const bad = md.length === 2 && (Number(md) > 59 || h > 12 || h === 0);
    if (bad) input.setAttribute('aria-invalid', 'true'); else input.removeAttribute('aria-invalid');
    const mer = meridiem();
    btn.textContent = mer;
    btn.hidden = !mer;
    btn.setAttribute('aria-label', `${mer}. Switch to ${mer === 'AM' ? 'PM' : 'AM'}`);
  }

  // Fill in what's missing when leaving the box: "9" -> 9:00, "9:3" -> 9:30.
  function finish() {
    const { hd, md } = parts();
    if (hd && md.length < 2) { digits = pad2(Number(hd)) + `${md}00`.slice(0, 2); render(); }
  }

  input.addEventListener('input', (e) => {
    const typed = e.inputType === 'insertText' && e.data && e.data.length === 1 && input.value !== e.data ? e.data : null;
    if (typed) {
      if (/\d/.test(typed)) { if (digits.length < 4) digits += typed; }
      else if (typed === ':' && digits.length === 1) digits = `0${digits}`; // "1:" means 1 o'clock, not 10-12
      else if (/[ap]/i.test(typed)) explicit = /a/i.test(typed) ? 'AM' : 'PM';
    } else if (e.inputType === 'deleteContentBackward' && input.value) {
      digits = digits.slice(0, -1);
    } else { // paste, autofill, typing over a selection
      digits = input.value.replace(/\D/g, '').slice(0, 4);
      if (/a/i.test(input.value)) explicit = 'AM'; else if (/p/i.test(input.value)) explicit = 'PM';
    }
    render();
    if (onChange) onChange();
  });
  input.addEventListener('blur', () => { finish(); if (onChange) onChange(); });
  btn.addEventListener('click', () => {
    explicit = meridiem() === 'AM' ? 'PM' : 'AM';
    render();
    if (onChange) onChange();
  });

  const field = {
    /** 'HH:MM' (24-hour), '' when empty, or null when it isn't a real time. */
    get() { finish(); return field.peek(); },
    /** Same as get(), without completing a half-typed time (safe to call while the user types). */
    peek() {
      const { hd, md, h, m } = parts();
      if (!hd) return '';
      if (md.length !== 2 || m > 59 || h < 1 || h > 12) return null;
      return `${pad2((h % 12) + (meridiem() === 'PM' ? 12 : 0))}:${pad2(m)}`;
    },
    set(hhmm) {
      if (!hhmm) { field.clear(); return; }
      const [h, m] = hhmm.split(':').map(Number);
      digits = pad2(h % 12 || 12) + pad2(m);
      explicit = h >= 12 ? 'PM' : 'AM';
      render();
    },
    clear() { digits = ''; explicit = ''; render(); },
    refresh: render,
  };
  render();
  timeFields[input.id] = field;
  return field;
}

function getClasses() {
  const list = store.get(STORAGE_KEYS.schedule, []);
  return Array.isArray(list) ? list.filter((c) => c && c.id && Array.isArray(c.days)) : [];
}

function getTests() {
  const list = store.get(STORAGE_KEYS.tests, []);
  return Array.isArray(list) ? list.filter((t) => t && t.id && /^\d{4}-\d{2}-\d{2}$/.test(t.date || '')) : [];
}

/** Tests from today on, soonest first. */
function upcomingTests() {
  return getTests()
    .filter((t) => daysUntil(t.date) >= 0)
    .sort((a, b) => (a.date + (a.time || '99')).localeCompare(b.date + (b.time || '99')));
}

const className = (id) => { const c = getClasses().find((x) => x.id === id); return c ? c.name : 'Class'; };

/** Today's situation: the class you're in now, or the next one today (with minutes until it starts). */
/** Today's fixed points, earliest first: your classes, plus today's tests (every test has a time).
    A test at its class's usual time takes that class's place; a test at another time (a 7 PM final)
    is added, lasting as long as its class (or an hour). Each has { name, start, end } like a class. */
function todaysEvents(date = new Date()) {
  const day = DAY_KEYS[date.getDay()];
  const events = getClasses().filter((c) => c.days.includes(day)).map((c) => ({ ...c }));
  getTests().filter((t) => t.date === isoDate(date) && t.time).forEach((t) => {
    const cls = getClasses().find((c) => c.id === t.classId);
    const name = `${cls ? cls.name : 'Class'} ${t.type}`; // "PHYS 4A Test"
    const sameSlot = events.find((e) => e.id === t.classId && e.start === t.time);
    if (sameSlot) { sameSlot.name = name; sameSlot.test = t; return; }
    const endMin = Math.min(24 * 60 - 1, hhmmToMin(t.time) + (cls ? hhmmToMin(cls.end) - hhmmToMin(cls.start) : 60));
    events.push({ id: t.id, name, start: t.time, end: `${pad2(Math.floor(endMin / 60))}:${pad2(endMin % 60)}`, test: t });
  });
  return events.sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start));
}

function scheduleStatus(date = new Date()) {
  const n = nowMin(date);
  const todays = todaysEvents(date); // classes and tests, so free time ends at a test too
  const current = todays.find((c) => hhmmToMin(c.start) <= n && n < hhmmToMin(c.end));
  const next = todays.find((c) => hhmmToMin(c.start) > n);
  return { hasClasses: getClasses().length > 0, current, next, freeMin: next ? hhmmToMin(next.start) - n : null };
}

/** One-line summary used on both the Plan and Schedule pages. */
function scheduleStatusText(s) {
  if (s.current) return `You're in <strong>${esc(s.current.name)}</strong> until ${esc(fmtClock(s.current.end))}.`;
  if (s.next) return `You're free for <strong>${esc(fmtDuration(s.freeMin))}</strong>, until ${esc(s.next.name)} at ${esc(fmtClock(s.next.start))}.`;
  return 'No more classes today. Your time is yours.';
}

/** The next test in the coming 3 days that hasn't started yet. */
function soonTest() {
  return upcomingTests().find((t) => daysUntil(t.date) <= 3 && !(daysUntil(t.date) === 0 && t.time && hhmmToMin(t.time) <= nowMin()));
}

/** Pick the kind of spot and the time window from the schedule:
    a test in the next 3 days -> a quiet study spot; otherwise -> a relaxing park.
    The window runs until the next class or test (minus 5 minutes to walk in), or starts when the current one ends. */
function decideSpot(s = scheduleStatus()) {
  const test = soonTest();
  const study = Boolean(test);
  let when = 'now';
  let laterTime = '';
  let untilMin = s.next ? hhmmToMin(s.next.start) : null;
  if (s.current) {
    // In class now: leave when it ends, and be back for the class after it.
    when = 'later';
    laterTime = s.current.end;
    const after = todaysEvents().find((c) => hhmmToMin(c.start) >= hhmmToMin(s.current.end)); // class or test
    untilMin = after ? hhmmToMin(after.start) : null;
  }
  const fromMin = s.current ? hhmmToMin(s.current.end) : nowMin();
  // No class to be back for: search a 2-hour window, but it's open-ended, so cards don't claim a stay time.
  const openEnded = untilMin == null;
  const freeMin = openEnded ? 120 : Math.min(720, Math.floor((untilMin - fromMin - 5) / 5) * 5);
  // Study: stay for most of the window. Relax: a calm half hour (less if the gap is short).
  const stayMin = Math.max(10, Math.min(study ? 90 : 30, Math.floor((freeMin * (study ? 0.6 : 0.4)) / 5) * 5));
  return { study, test, when, laterTime, freeMin, stayMin, openEnded, label: study ? 'Find a study spot' : 'Find a relaxation spot' };
}

/** Plan page banner: free time before your next class, a heads-up about tests,
    and one button that picks the best spot for right now and opens it on the map. */
function renderScheduleHint() {
  const box = $('#schedule-hint');
  const s = scheduleStatus();
  const pick = decideSpot(s);
  const rows = [];
  if (!s.hasClasses) {
    rows.push(`<p>Add your <a href="#/schedule">class schedule</a> and we'll fit escapes between your classes.</p>`);
  } else {
    rows.push(`<p>${scheduleStatusText(s)}</p>`);
  }
  const tooShort = pick.freeMin < 15;
  const why = pick.study
    ? `A quiet study spot you can reach and leave in time${s.next || s.current ? ' for your next class' : ''}.`
    : `A relaxing park for a ${fmtDuration(pick.stayMin)} break${s.next || s.current ? ' that gets you back before class' : ''}.`;
  box.innerHTML = `${rows.map((r) => `<div class="hint-row">${r}</div>`).join('')}
    <div class="hint-row hint-action">
      <p class="hint-why">${tooShort ? 'Not enough time for a trip before your next class.' : esc(why)}</p>
      ${tooShort ? '' : `<button type="button" class="btn btn-small btn-primary" id="hint-go">
        <span class="btn-label">${esc(pick.label)}</span><span class="spinner" aria-hidden="true"></span>
      </button>`}
    </div>`;
  box.hidden = false;
  if (!tooShort) $('#hint-go').addEventListener('click', (e) => goToBestSpot(pick, e.currentTarget));
}

/** Run the search for the picked spot and open the map on the top recommendation. */
async function goToBestSpot(pick, btn) {
  const form = $('#plan-form');
  const saved = { ...DEFAULT_PREFS, ...store.get(STORAGE_KEYS.prefs, {}) };
  const prefs = {
    ...saved,
    kind: pick.study ? 'study' : 'parks',
    activity: pick.study ? 'studying' : 'relaxing',
    environment: pick.study ? 'quiet' : saved.environment,
    time: 'custom', customMinutes: String(pick.freeMin), freeMin: pick.freeMin,
    stay: 'custom', stayCustom: String(pick.stayMin), wantStayMin: pick.stayMin,
    when: pick.when, laterTime: pick.laterTime,
    openEnded: Boolean(pick.openEnded), // no class to be back for: don't show a stay time
  };
  fillForm(form, prefs); // so the form matches if they come back to tweak it

  const label = btn.querySelector('.btn-label');
  btn.classList.add('loading');
  btn.disabled = true;
  label.textContent = 'Picking the best spot…';
  try {
    if (locationState.status === 'pending') await Promise.race([locationState.promise, new Promise((r) => setTimeout(r, 6000))]);
    if (locationState.status === 'ok') prefs.origin = 'location';
    else if (/^\d{5}$/.test(prefs.zip || '')) prefs.origin = 'zip';
    else {
      showZipFallback('Enter your ZIP code so we can find spots near you:');
      $('#zip').focus();
      return;
    }
    store.set(STORAGE_KEYS.prefs, prefs);
    await runSearch(prefs);
    // The map opens on recommendation #1, the best match.
    if (location.hash === '#/results') route(); else location.hash = '#/results';
  } catch (err) {
    if (!(err instanceof SearchError)) console.error(err);
    showToast(err instanceof SearchError ? err.message : 'Something went wrong while searching. Please try again.');
  } finally {
    btn.classList.remove('loading');
    btn.disabled = false;
    label.textContent = pick.label;
  }
}

function renderTests() {
  const classes = getClasses();
  $('#add-test-btn').hidden = !classes.length;
  const tests = upcomingTests();
  if (!classes.length) {
    $('#tests-list').innerHTML = '<p class="muted-note">Add a class first, then you can add its tests.</p>';
    return;
  }
  if (!tests.length) {
    $('#tests-list').innerHTML = '<p class="muted-note">No tests coming up. Tap <strong>Add test</strong> when one is announced.</p>';
    return;
  }
  $('#tests-list').innerHTML = `<ul class="test-list">${tests.map((t) => {
    const n = daysUntil(t.date);
    return `<li class="test-item${n <= 2 ? ' is-soon' : ''}">
      <span class="test-when"><span class="countdown">${countdownText(n)}</span>
        <span class="class-time">${esc(fmtDay(t.date))} · ${t.time ? esc(fmtClock(t.time)) : '<strong class="needs-time">Add a time</strong>'}</span></span>
      <span class="class-info"><strong>${esc(t.type)} · ${esc(className(t.classId))}</strong>${t.note ? `<span class="class-room">${esc(t.note)}</span>` : ''}</span>
      <span class="class-actions">
        <button type="button" class="btn btn-small" data-edit-test="${esc(t.id)}">Edit</button>
        <button type="button" class="btn btn-small btn-danger" data-delete-test="${esc(t.id)}" aria-label="Delete ${esc(t.type)} for ${esc(className(t.classId))}">Delete</button>
      </span>
    </li>`;
  }).join('')}</ul>`;
}

function renderSchedule() {
  const classes = getClasses();
  const s = scheduleStatus();
  $('#schedule-now').innerHTML = s.hasClasses ? scheduleStatusText(s) : '';
  renderTests();

  if (!classes.length) {
    $('#schedule-list').innerHTML = `<div class="empty">
        <h2>No classes yet</h2>
        <p>Add your classes above. Reach will show how much free time you have before the next one.</p>
      </div>`;
    return;
  }
  const today = DAY_KEYS[new Date().getDay()];
  $('#schedule-list').innerHTML = SCHEDULE_DAYS.map((day) => {
    const list = classes.filter((c) => c.days.includes(day)).sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start));
    if (!list.length) return '';
    return `<section class="schedule-day${day === today ? ' is-today' : ''}">
      <h2>${DAY_NAMES[day]}${day === today ? ' <span class="today-tag">Today</span>' : ''}</h2>
      <ul>${list.map((c) => `
        <li class="class-item">
          <span class="class-time">${esc(fmtClock(c.start))} – ${esc(fmtClock(c.end))}</span>
          <span class="class-info"><strong>${esc(c.name)}</strong>${c.room ? `<span class="class-room">${esc(c.room)}</span>` : ''}</span>
          <span class="class-actions">
            <button type="button" class="btn btn-small" data-add-test="${esc(c.id)}" aria-label="Add a test for ${esc(c.name)}">+ Test</button>
            <button type="button" class="btn btn-small" data-edit-class="${esc(c.id)}">Edit</button>
            <button type="button" class="btn btn-small btn-danger" data-delete-class="${esc(c.id)}" aria-label="Delete ${esc(c.name)}">Delete</button>
          </span>
        </li>`).join('')}</ul>
    </section>`;
  }).join('');
}

function resetClassForm() {
  const form = $('#class-form');
  form.reset();
  timeFields['class-start'].clear();
  timeFields['class-end'].clear();
  editingClassId = null;
  $('#class-form-title').textContent = 'Add a class';
  $('#class-submit').textContent = 'Add class';
  $('#class-cancel').hidden = true;
  $('#class-error').hidden = true;
}

/** Show an error under a form and focus the field it's about. */
function formError(box, msg, field) {
  box.textContent = msg;
  box.hidden = false;
  if (field) field.focus();
}

/** Open the test form, empty (optionally for one class) or filled in for editing. */
function openTestForm({ classId, test } = {}) {
  const form = $('#test-form');
  const classes = getClasses().slice().sort((a, b) => a.name.localeCompare(b.name));
  const pick = test ? test.classId : classId || (classes[0] && classes[0].id);
  form.elements.classId.innerHTML = classes.map((c) => `<option value="${esc(c.id)}"${c.id === pick ? ' selected' : ''}>${esc(c.name)}</option>`).join('');
  $$('input[name="testType"]', form).forEach((i) => { i.checked = i.value === (test ? test.type : 'Test'); });
  form.elements.date.min = isoDate();
  form.elements.date.value = test ? test.date : '';
  form.elements.note.value = test ? test.note || '' : '';
  timeFields['test-time'].set(test ? test.time : '');
  editingTestId = test ? test.id : null;
  $('#test-form-title').textContent = test ? 'Edit test' : 'Add a test';
  $('#test-submit').textContent = test ? 'Save changes' : 'Add test';
  $('#test-error').hidden = true;
  form.hidden = false;
  $('#add-test-btn').hidden = true;
  form.scrollIntoView({ behavior: 'smooth', block: 'start' });
  form.elements.date.focus({ preventScroll: true });
}

function closeTestForm() {
  $('#test-form').hidden = true;
  editingTestId = null;
  $('#add-test-btn').hidden = !getClasses().length;
}

/** If the test's class meets on the picked day, use the class time as the test time. */
function suggestTestTime() {
  const form = $('#test-form');
  const cls = getClasses().find((c) => c.id === form.elements.classId.value);
  if (!cls || !form.elements.date.value || timeFields['test-time'].get()) return;
  if (cls.days.includes(DAY_KEYS[parseIsoDate(form.elements.date.value).getDay()])) timeFields['test-time'].set(cls.start);
}

function setupSchedule() {
  const form = $('#class-form');
  $('#class-days').innerHTML = SCHEDULE_DAYS.map((d) => `
    <label class="chip">
      <input type="checkbox" name="days" value="${d}">
      <span class="chip-face">${DAY_LABELS[d]}</span>
    </label>`).join('');

  const startField = makeSmartTime($('#class-start'), { onChange: () => timeFields['class-end'] && timeFields['class-end'].refresh() });
  const endField = makeSmartTime($('#class-end'), {
    after: () => { const v = startField.peek(); return v ? hhmmToMin(v) : null; },
  });

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = form.elements;
    const name = f.name.value.trim();
    const days = $$('input[name="days"]:checked', form).map((i) => i.value);
    const start = startField.get();
    const end = endField.get();
    const showError = (msg, field) => formError($('#class-error'), msg, field);
    if (!name) return showError('Give the class a name.', f.name);
    if (!days.length) return showError('Pick at least one day.');
    if (!start) return showError(start === null ? 'That start time doesn\'t look right. Try something like 930.' : 'Enter a start time.', f.start);
    if (!end) return showError(end === null ? 'That end time doesn\'t look right. Try something like 1045.' : 'Enter an end time.', f.end);
    if (hhmmToMin(end) <= hhmmToMin(start)) return showError('The class has to end after it starts.', f.end);

    const entry = { id: editingClassId || `c${Date.now().toString(36)}`, name, room: f.room.value.trim(), days, start, end };
    const list = getClasses().filter((c) => c.id !== entry.id).concat(entry);
    if (!store.set(STORAGE_KEYS.schedule, list)) return showError("Couldn't save. Your browser is blocking storage.");
    showToast(editingClassId ? `Updated ${name}` : `Added ${name}`);
    resetClassForm();
    renderSchedule();
  });

  $('#class-cancel').addEventListener('click', resetClassForm);

  // Tests
  const testForm = $('#test-form');
  $('#test-types').innerHTML = TEST_TYPES.map((t) => `
    <label class="chip">
      <input type="radio" name="testType" value="${t}">
      <span class="chip-face">${t}</span>
    </label>`).join('');
  makeSmartTime($('#test-time'));
  $('#add-test-btn').addEventListener('click', () => openTestForm());
  $('#test-cancel').addEventListener('click', closeTestForm);
  testForm.elements.date.addEventListener('change', suggestTestTime);
  testForm.elements.classId.addEventListener('change', suggestTestTime);

  testForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const f = testForm.elements;
    const time = timeFields['test-time'].get();
    const showError = (msg, field) => formError($('#test-error'), msg, field);
    if (!f.classId.value) return showError('Pick a class.', f.classId);
    if (!f.date.value) return showError('Pick the date of the test.', f.date);
    if (daysUntil(f.date.value) < 0) return showError('That date has already passed.', f.date);
    // Required: Reach plans your free time around the test, so it needs to know when it starts.
    if (!time) return showError(time === null ? 'That time doesn\'t look right. Try something like 930.' : 'Enter the time of the test.', f.time);

    const type = TEST_TYPES.includes(f.testType.value) ? f.testType.value : 'Test';
    const entry = { id: editingTestId || `t${Date.now().toString(36)}`, classId: f.classId.value, type, date: f.date.value, time, note: f.note.value.trim() };
    // Keep the list tidy: drop tests that are more than a week old.
    const list = getTests().filter((t) => t.id !== entry.id && daysUntil(t.date) >= -7).concat(entry);
    if (!store.set(STORAGE_KEYS.tests, list)) return showError("Couldn't save. Your browser is blocking storage.");
    showToast(`${editingTestId ? 'Updated' : 'Added'} ${type.toLowerCase()} for ${className(entry.classId)}`);
    closeTestForm();
    renderSchedule();
  });

  $('#tests-list').addEventListener('click', (e) => {
    const del = e.target.closest('[data-delete-test]');
    if (del) {
      store.set(STORAGE_KEYS.tests, getTests().filter((t) => t.id !== del.dataset.deleteTest));
      if (editingTestId === del.dataset.deleteTest) closeTestForm();
      showToast('Test deleted');
      renderSchedule();
      return;
    }
    const edit = e.target.closest('[data-edit-test]');
    if (edit) {
      const test = getTests().find((t) => t.id === edit.dataset.editTest);
      if (test) openTestForm({ test });
    }
  });

  $('#schedule-list').addEventListener('click', (e) => {
    const addTest = e.target.closest('[data-add-test]');
    if (addTest) { openTestForm({ classId: addTest.dataset.addTest }); return; }
    const del = e.target.closest('[data-delete-class]');
    if (del) {
      const id = del.dataset.deleteClass;
      const cls = getClasses().find((c) => c.id === id);
      const tests = getTests();
      const theirs = tests.filter((t) => t.classId === id).length;
      store.set(STORAGE_KEYS.schedule, getClasses().filter((c) => c.id !== id));
      if (theirs) store.set(STORAGE_KEYS.tests, tests.filter((t) => t.classId !== id));
      if (editingClassId === id) resetClassForm();
      if (!getClasses().length) closeTestForm();
      if (cls) showToast(`Deleted ${cls.name}${theirs ? ` and its ${theirs === 1 ? 'test' : `${theirs} tests`}` : ''}`);
      renderSchedule();
      return;
    }
    const edit = e.target.closest('[data-edit-class]');
    if (edit) {
      const cls = getClasses().find((c) => c.id === edit.dataset.editClass);
      if (!cls) return;
      editingClassId = cls.id;
      const f = form.elements;
      f.name.value = cls.name;
      f.room.value = cls.room || '';
      startField.set(cls.start);
      endField.set(cls.end);
      $$('input[name="days"]', form).forEach((i) => { i.checked = cls.days.includes(i.value); });
      $('#class-form-title').textContent = `Edit ${cls.name}`;
      $('#class-submit').textContent = 'Save changes';
      $('#class-cancel').hidden = false;
      $('#class-error').hidden = true;
      form.scrollIntoView({ behavior: 'smooth', block: 'start' });
      f.name.focus({ preventScroll: true });
    }
  });
}

/* --- Hash routing: #/welcome, #/plan, #/schedule, #/results, #/favorites --- */
async function route() {
  // First visit with no page in the URL: show the welcome cover once.
  const fallback = store.get(STORAGE_KEYS.welcomed, false) ? 'plan' : 'welcome';
  let view = (location.hash.replace(/^#\/?/, '') || fallback).split('?')[0];
  if (!['welcome', 'plan', 'schedule', 'results', 'favorites'].includes(view)) view = 'plan';
  if (view === 'welcome') store.set(STORAGE_KEYS.welcomed, true);

  if (view === 'results' && !state.results) {
    // Page was refreshed on #/results: re-run the last search if we can.
    const prefs = store.get(STORAGE_KEYS.prefs, null);
    try {
      if (prefs && prefs.freeMin && (prefs.origin === 'location' || prefs.zip)) await runSearch(prefs);
      else view = 'plan';
    } catch (err) {
      view = 'plan';
    }
  }

  $$('.view').forEach((v) => { v.hidden = v.dataset.view !== view; });
  document.body.classList.toggle('map-mode', view === 'results'); // full-screen map, no footer
  $('#back-to-map').hidden = view === 'results' || !state.results; // "Back to map" once there's a map to go back to
  if (view !== 'results' && isSheetOpen()) closePlanSheet();
  $$('[data-nav]').forEach((a) => {
    const active = a.dataset.nav === view || (view === 'results' && a.dataset.nav === 'plan');
    if (active) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
  });

  if (view === 'plan') renderScheduleHint();
  if (view === 'schedule') renderSchedule();
  if (view === 'results') renderResults();
  if (view === 'favorites') renderFavorites();
  window.scrollTo({ top: 0 });
  $('#main').focus({ preventScroll: true });
}

/* --- Theme: auto (follows system) -> light -> dark --- */
const THEMES = ['auto', 'light', 'dark'];
const svgIcon = (body) => `<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;
const THEME_ICONS = {
  auto: svgIcon('<circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor"/>'),
  light: svgIcon('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4"/>'),
  dark: svgIcon('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
};

function applyTheme(theme) {
  if (theme === 'auto') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.setAttribute('data-theme', theme);
  $('#theme-icon').innerHTML = THEME_ICONS[theme];
  $('#theme-toggle').setAttribute('aria-label', `Color theme: ${theme}. Tap to change.`);
}

function setupTheme() {
  let theme = store.get(STORAGE_KEYS.theme, 'auto');
  if (!THEMES.includes(theme)) theme = 'auto';
  applyTheme(theme);
  $('#theme-toggle').addEventListener('click', () => {
    theme = THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length];
    store.set(STORAGE_KEYS.theme, theme);
    applyTheme(theme);
    setTiles(); // light/dark map tiles
  });
}

/* --- Toast --- */
let toastTimer;
function showToast(text) {
  const t = $('#toast');
  t.textContent = text;
  t.hidden = false;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.classList.remove('show');
    setTimeout(() => { t.hidden = true; }, 250);
  }, 2400);
}

/* --- Global click handling (event delegation) --- */
function setupDelegation() {
  document.addEventListener('click', (e) => {
    const save = e.target.closest('[data-save]');
    if (save) { toggleFavorite(save.dataset.save); return; }
    const remove = e.target.closest('[data-remove]');
    if (remove) { toggleFavorite(remove.dataset.remove); renderFavorites(); }
  });
  // Swap broken photos for the illustration ('error' doesn't bubble, so listen in the capture phase).
  document.addEventListener('error', (e) => {
    const img = e.target;
    if (img.tagName === 'IMG' && img.classList.contains('card-photo')) {
      const place = findPlace(img.dataset.place);
      if (place) img.outerHTML = sceneSVG(place);
    }
  }, true);
}

/* --- Offline support: cache app files with a tiny service worker --- */
function registerServiceWorker() {
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('sw.js').catch((err) => console.warn('[Reach] SW not registered:', err));
  }
}

/* --- Back to map ---
   Bottom-left button on the other pages, shown once you've searched. It reopens the results map
   on the place you were looking at (MAP.index), without searching again. */
function setupBackToMap() {
  $('#back-to-map').addEventListener('click', () => { MAP.resume = true; });
}

async function init() {
  setupTheme();
  setupBackToMap();
  setupDelegation();
  try {
    await loadData();
  } catch (err) {
    console.error(err);
    $('#plan-form').innerHTML = `<div class="empty">
        <h2>Couldn't load destinations</h2>
        <p>If you opened <code>index.html</code> directly from your files, browsers block loading <code>destinations.json</code>.
        Start a local server instead (see README): <code>python3 -m http.server 8000</code>, then open <code>http://localhost:8000</code>.</p>
      </div>`;
    return;
  }
  indexPlaces(getFavorites().map((f) => f.place).filter((p) => p && p.id));
  setupMapControls();
  setupPlanSheet();
  setupForm();
  setupSchedule();
  updateFavCount();
  window.addEventListener('hashchange', route);
  // The favorites tree has a phone layout and a wide layout: redraw it when the screen crosses over.
  if (window.matchMedia) window.matchMedia('(max-width: 600px)').addEventListener?.('change', () => { if (!$('#view-favorites').hidden) renderFavorites(); });
  await route();
  registerServiceWorker();
}

document.addEventListener('DOMContentLoaded', init);

// Expose pure functions for quick testing in the browser console (window.Reach.checkFit(...)).
window.Reach = window.GreenEscape = {
  CONFIG, GEO, haversineKm, estimateTravel, checkFit, scorePlace, analyzeWeather, calcSunTimes,
  parseOsmHours, normalizeFeature, classifyPlace, searchRadiusKm, state,
};
