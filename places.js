/* =====================================================================
   Reach: places.js (add-on, loaded after app.js and routing.js)
   Every-day places for Ask Reach: food, dessert, malls, groceries,
   restrooms, pharmacies, gyms, museums, movies, bookstores, drinking
   fountains, ATMs and gas stations.

   app.js searches parks and study spots with scoring built around
   activities and settings. These places just need to be open, close,
   and fit your time, so they get their own simpler search:
     1. Find places of that kind (Geoapify Places, same GEOAPIFY_KEY)
        within reach of your free time and travel mode, closest first.
     2. Fill in hours the map data doesn't list with typical ones
        (marked "assumed"), and a visit length for that kind of place.
     3. Run each through app.js's fit check (travel there + visit +
        buffer, opening hours), and keep the ones that fit, nearest first.
   The result has the same shape as app.js runSearch(), so Ask Reach,
   real route times (routing.js) and the results map all work with it.
   ===================================================================== */
(() => {
'use strict';

/* Each kind of place: what to search, the words that ask for it, typical hours when none are
   listed ([open, close], or null = treat as always open), and how long a visit takes (minutes). */
const CATEGORIES = {
  restroom: {
    label: 'Restroom', one: 'restroom', plural: 'restrooms', geo: ['amenity.toilet'], hours: null, stay: 5,
    unnamed: 'Public restroom', say: "Here's the closest one that works.",
    words: /\b(rest ?rooms?|bath ?rooms?|toilets?|wash ?rooms?|pee|potty|loo|wc)\b/,
  },
  water: {
    label: 'Drinking fountain', one: 'drinking fountain', plural: 'drinking fountains', geo: ['amenity.drinking_water'], hours: null, stay: 3,
    unnamed: 'Drinking fountain', say: 'Time to refill.',
    words: /\b((water|drinking) fountains?|refill (my )?(water|bottle)|drinking water|fill (up )?my (water|bottle))\b/,
  },
  atm: {
    label: 'ATM', one: 'ATM', plural: 'ATMs', geo: ['service.financial.atm'], hours: null, stay: 5,
    unnamed: 'ATM', say: "Here's an ATM.",
    words: /\b(atms?|cash machines?|get (some )?cash|withdraw (some )?(cash|money))\b/,
  },
  gas: {
    label: 'Gas station', one: 'gas station', plural: 'gas stations', geo: ['service.vehicle.fuel'], hours: ['06:00', '23:00'], stay: 10,
    unnamed: 'Gas station', say: "Let's fill up.",
    words: /\b(gas stations?|get gas|need gas|fuel|petrol)\b/,
  },
  pharmacy: {
    label: 'Pharmacy', one: 'pharmacy', plural: 'pharmacies', geo: ['healthcare.pharmacy'], hours: ['09:00', '21:00'], stay: 10,
    say: "Here's a pharmacy.",
    words: /\b(pharmac(y|ies)|drug ?stores?|cvs|walgreens|rite aid|medicine|meds)\b/,
  },
  dessert: {
    label: 'Dessert', one: 'dessert spot', plural: 'dessert spots', geo: ['catering.ice_cream', 'commercial.food_and_drink.bakery'],
    hours: ['10:00', '21:00'], stay: 20, say: 'Treat yourself.',
    words: /\b(desserts?|ice cream|gelato|froyo|frozen yogurt|bakery|bakeries|pastry|pastries|donuts?|doughnuts?|something sweet|sweets|cake)\b/,
  },
  food: {
    label: 'Food', one: 'place to eat', plural: 'places to eat',
    geo: ['catering.restaurant', 'catering.fast_food', 'catering.food_court'], hours: ['11:00', '21:00'],
    stay: (cats) => (cats.some((c) => c.startsWith('catering.restaurant')) ? 45 : 20), // sit-down vs quick bite
    say: "Let's get you fed.",
    words: /\b(hungry|starving|food|eat|eats|lunch|dinner|breakfast|brunch|restaurants?|burgers?|pizza|tacos?|burritos?|sushi|ramen|pho|noodles|sandwich(es)?|fast food|a bite)\b/,
  },
  groceries: {
    label: 'Groceries', one: 'store', plural: 'grocery stores', geo: ['commercial.supermarket', 'commercial.convenience'],
    hours: ['08:00', '22:00'], stay: 20, say: "Here's a store.",
    words: /\b(groceries|grocery( store)?|supermarkets?|convenience stores?|corner stores?)\b/,
  },
  mall: {
    label: 'Mall', one: 'mall', plural: 'malls', geo: ['commercial.shopping_mall'], hours: ['10:00', '21:00'], stay: 60,
    say: 'Shopping trip it is.',
    words: /\b(malls?|shopping (cent(er|re)|plaza)|go shopping|shopping)\b/,
  },
  gym: {
    label: 'Gym', one: 'gym', plural: 'gyms', geo: ['sport.fitness.fitness_centre'], hours: ['06:00', '22:00'], stay: 60,
    say: "Let's get a workout in.",
    words: /\b(gyms?|fitness (cent(er|re)|club)|lift(ing)? weights|weight room)\b/,
  },
  museum: {
    label: 'Museum', one: 'museum', plural: 'museums', geo: ['entertainment.museum'], hours: ['10:00', '17:00'], stay: 90,
    say: 'A bit of culture.',
    words: /\b(museums?|art galler(y|ies)|exhibits?|exhibitions?)\b/,
  },
  movies: {
    label: 'Movies', one: 'movie theater', plural: 'movie theaters', geo: ['entertainment.cinema'], hours: ['11:00', '23:00'], stay: 150,
    say: 'Movie time.',
    words: /\b(movies?|cinemas?|movie theat(er|re)s?|see a film|watch a film)\b/,
  },
  books: {
    label: 'Bookstore', one: 'bookstore', plural: 'bookstores', geo: ['commercial.books'], hours: ['10:00', '20:00'], stay: 30,
    say: 'Time to browse.',
    words: /\b(book ?stores?|book ?shops?|buy (a |some )?books?)\b/,
  },
};

/** The kind of place a message asks for ("I need a restroom" -> 'restroom'), or null. */
function detect(t) {
  return Object.keys(CATEGORIES).find((k) => CATEGORIES[k].words.test(t)) || null;
}

/** Visit length for a place of this kind. */
const stayFor = (cat, cats = []) => (typeof cat.stay === 'function' ? cat.stay(cats) : cat.stay);
/** Typical visit for the kind overall (used when planning, before places are known). */
const typicalStay = (key) => stayFor(CATEGORIES[key], ['catering.fast_food']);

const titleCase = (s) => s.replace(/(^|[\s_-])\w/g, (m) => m.toUpperCase()).replace(/_/g, ' ');

/** "Mexican restaurant", "Fast food", "Food court", or the kind's label. */
function kindLabel(key, cats, raw) {
  if (key !== 'food') return CATEGORIES[key].label;
  if (cats.some((c) => c.startsWith('catering.fast_food'))) return 'Fast food';
  if (cats.some((c) => c.startsWith('catering.food_court'))) return 'Food court';
  const cuisine = String(raw.cuisine || '').split(/[;,]/)[0].trim();
  return cuisine ? `${titleCase(cuisine)} restaurant` : 'Restaurant';
}

/** Geoapify feature -> a place app.js can fit-check and show (same shape as its own places). */
function toPlace(feature, key) {
  const cat = CATEGORIES[key];
  const p = (feature && feature.properties) || {};
  const raw = (p.datasource && p.datasource.raw) || {};
  const coords = (feature.geometry && feature.geometry.coordinates) || [];
  const lat = Number.isFinite(p.lat) ? p.lat : coords[1];
  const lng = Number.isFinite(p.lon) ? p.lon : coords[0];
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (raw.access === 'private' || raw.access === 'no' || raw.access === 'customers') return null;

  let name = String(p.name || raw.name || raw.brand || raw.operator || '').trim();
  if (!name) {
    if (!cat.unnamed) return null; // unnamed shops and restaurants are usually bad data
    const street = p.street || '';
    name = street ? `${cat.unnamed} on ${street}` : cat.unnamed;
  }
  const cats = p.categories || [];
  const listed = parseOsmHours(p.opening_hours || raw.opening_hours);
  const hours = listed || (cat.hours ? { open: cat.hours[0], close: cat.hours[1], assumed: true } : { open: '00:00', close: '24:00', assumed: true });
  const label = kindLabel(key, cats, raw);
  const extras = [
    raw.takeaway === 'yes' && 'takeout', raw.outdoor_seating === 'yes' && 'outdoor seating',
    raw.wheelchair === 'yes' && 'wheelchair accessible', raw.fee === 'no' && 'free', raw.fee === 'yes' && 'fee',
  ].filter(Boolean);
  return {
    id: `geo-${p.place_id || `${lat.toFixed(5)}_${lng.toFixed(5)}`}`,
    name, lat, lng,
    address: p.address_line2 || p.formatted || '',
    city: p.city || '',
    type: key, category: key, kindLabel: label,
    environment: [], activities: [], amenities: {},
    hours, exposure: 'indoor', visitMinutes: {}, stayMin: stayFor(cat, cats),
    accessibility: raw.wheelchair === 'yes' ? 'Listed as wheelchair accessible.' : 'Accessibility not listed.',
    description: [`${label}${p.city ? ` in ${p.city}` : ''}.`, extras.length ? `Has ${listText(extras)}.` : '',
      hours.assumed ? (cat.hours ? 'Hours not listed, so typical hours are assumed.' : 'Hours not listed.') : ''].filter(Boolean).join(' '),
    website: p.website || raw.website || '',
    photo: '', source: 'live',
  };
}

const cache = new Map(); // search key -> features, for this session (saves Geoapify credits)

async function fetchKind(key, origin, radiusKm) {
  const cacheKey = `${key}:${origin.lat.toFixed(3)},${origin.lng.toFixed(3)},${radiusKm}`;
  if (!cache.has(cacheKey)) cache.set(cacheKey, fetchPlaces(CATEGORIES[key].geo, origin, radiusKm, 60, null));
  try {
    return await cache.get(cacheKey);
  } catch (err) {
    cache.delete(cacheKey);
    throw err;
  }
}

/** Search one kind of place for a plan (prefs as in app.js runSearch). Returns results like runSearch. */
async function search(prefs, key) {
  const cat = CATEGORIES[key];
  if (!GEO.key) throw new SearchError(`Finding ${cat.plural} needs the place search (GEOAPIFY_KEY in config.js).`);
  const origin = await getOrigin(prefs);
  const start = computeStart(prefs.when, prefs.laterTime);
  const end = addMin(start, prefs.freeMin);
  const bucket = GEO.radiusBucketsKm.find((b) => b >= searchRadiusKm(prefs)) || searchRadiusKm(prefs);

  let features;
  const [weather] = await Promise.all([
    getWeather(origin),
    fetchKind(key, origin, bucket).then((f) => { features = f; }).catch((err) => {
      console.warn('[Reach] Place search failed:', err.message);
      throw new SearchError(err.status === 401 || err.status === 403
        ? 'The Geoapify API key was rejected. Check config.js.'
        : `Couldn't search for ${cat.plural} right now (are you offline?).`);
    }),
  ]);
  const places = dedupePlaces(features.map((f) => toPlace(f, key)).filter(Boolean));
  indexPlaces(places);

  const sun = getSun(start, weather, origin);
  const wx = analyzeWeather(weather, start, end);
  // A visit counts as fitting if it gets its usual length, or most of a short window (a quick lunch in 20 min).
  // From the Plan page (honorStay), the stay you chose is what counts.
  const wantFor = (place) => (prefs.honorStay ? prefs.wantStayMin || 30
    : Math.max(3, Math.min(place.stayMin, Math.round(prefs.freeMin * 0.6))));
  const all = places.map((place) => {
    const ctx = { origin, mode: prefs.mode, freeMin: prefs.freeMin, wantStayMin: wantFor(place), start, sun };
    return walkSwap(checkFit(place, ctx), ctx);
  });
  // Soonest first: time to get there plus any wait for it to open. When time is short, quick places
  // (fast food rather than a sit-down meal) come first. The map card's "score" is how little of your time
  // goes to getting there and waiting for it to open.
  const cost = (r) => r.travel.thereMin + r.waitMin + (!prefs.honorStay && r.place.stayMin > prefs.freeMin * 0.6 ? 15 : 0);
  const byTravel = (a, b) => cost(a) - cost(b);
  const fitting = all.filter((r) => r.verdict !== 'no')
    .map((r) => ({ ...r, scoring: { score: Math.round(100 * clamp(1 - (r.travel.thereMin + r.waitMin) / prefs.freeMin)), parts: [], reasons: [], headsUp: '' } }))
    .sort((a, b) => (a.verdict === 'fits' ? 0 : 1) - (b.verdict === 'fits' ? 0 : 1) || byTravel(a, b));
  const notFitting = all.filter((r) => r.verdict === 'no').sort(byTravel);

  const results = {
    prefs: { ...prefs, kind: key, kindLabel: cat.label, kindPlural: cat.plural },
    formPrefs: prefs, origin, start, end, sun, wx, fitting, notFitting,
    live: { status: 'live', radiusKm: bucket, count: places.length },
  };
  state.results = results; // like runSearch: the map (and "Back to map") show these
  return results;
}

window.ReachPlaces = { CATEGORIES, detect, search, typicalStay };
})();
