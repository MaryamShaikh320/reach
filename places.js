/* =========================================================
   GreenEscape — places.js
   Real place discovery with the Geoapify Places + Geocoding APIs.

   Two modes share the one map (map.js):
   - Explore: any category, any area. No scores (we don't invent them).
   - Nature picks: the original form + scoring for verified parks.json
     parks, plus nearby parks found by Geoapify (shown as "not scored").

   API facts used here (from apidocs.geoapify.com):
   - Places:   GET https://api.geoapify.com/v2/places
               categories (required), filter=circle:lon,lat,meters,
               bias=proximity:lon,lat, limit, offset, apiKey.
               A parent category (e.g. "catering") includes all its children.
               At most 500 places can be requested in total.
   - Geocoding: GET https://api.geoapify.com/v1/geocode/search
               text, type, filter=countrycode:us, bias, limit, format=json.

   Sections:
   1. Settings and categories
   2. State
   3. API requests (shared, with errors, timeout, cache)
   4. Turning API results into map items
   5. Explore mode searches
   6. Nature picks: nearby parks from Geoapify
   7. Mode switching and setup
   ========================================================= */


/* ---------- 1. Settings and categories ---------- */

const PLACES_API_URL = "https://api.geoapify.com/v2/places";
const GEOCODE_API_URL = "https://api.geoapify.com/v1/geocode/search";
const ROUTE_MATRIX_API_URL = "https://api.geoapify.com/v1/routematrix";
const PLACES_PAGE_SIZE = 50;      // places per request
const PLACES_MAX_TOTAL = 500;     // Geoapify's documented maximum
const REQUEST_TIMEOUT_MS = 12000; // give up on slow requests
const CACHE_MAX_ENTRIES = 40;

// Places that are good for studying, best first. Used by "Study places (all)".
const STUDY_CATEGORIES = [
  "education.library", "office.coworking", "activity.community_center",
  "education.university", "education.college", "catering.cafe", "commercial.books"
];

// A short study tip per kind of place (most specific first), shown on its map card.
const STUDY_TIPS = [
  ["education.library", "Quiet seating, usually free Wi-Fi and outlets. Great for focused studying."],
  ["office.coworking", "Desks, Wi-Fi and outlets. Often needs a day pass."],
  ["activity.community_center", "Often has free tables or study rooms. Hours vary."],
  ["education.university", "Campus libraries and lounges are good for long sessions."],
  ["education.college", "Campus libraries and lounges are good for long sessions."],
  ["catering.cafe", "Good for light studying with a drink. Can get busy and loud at peak times."],
  ["commercial.books", "Some bookstores have a cafe or reading area."]
];

/*
  Category choices. Every "categories" value is an ID from Geoapify's
  documented category list. A parent ID includes all of its children.
*/
const CATEGORY_GROUPS = [
  {
    group: "Nature & outdoors",
    options: [
      { id: "nature", label: "Parks & nature (all)", categories: "leisure.park,national_park,natural,beach,camping" },
      { id: "parks", label: "Parks", categories: "leisure.park" },
      { id: "gardens", label: "Gardens", categories: "leisure.park.garden" },
      { id: "reserves", label: "Nature reserves & protected areas", categories: "leisure.park.nature_reserve,natural.protected_area" },
      { id: "national-parks", label: "National parks", categories: "national_park" },
      { id: "natural", label: "Natural features (water, peaks, forests)", categories: "natural" },
      { id: "beaches", label: "Beaches", categories: "beach" },
      { id: "camping", label: "Camping", categories: "camping" },
      { id: "picnic", label: "Picnic spots", categories: "leisure.picnic" },
      { id: "playgrounds", label: "Playgrounds", categories: "leisure.playground" },
      { id: "viewpoints", label: "Viewpoints", categories: "tourism.attraction.viewpoint" }
    ]
  },
  {
    group: "Study places",
    options: [
      { id: "study", label: "Study places (all)", categories: STUDY_CATEGORIES.join(",") },
      { id: "libraries", label: "Libraries", categories: "education.library" },
      { id: "study-cafes", label: "Cafes to study in", categories: "catering.cafe" },
      { id: "coworking", label: "Coworking spaces", categories: "office.coworking" },
      { id: "campus", label: "College & university campuses", categories: "education.university,education.college" },
      { id: "community-centers", label: "Community centers", categories: "activity.community_center" },
      { id: "bookstores", label: "Bookstores", categories: "commercial.books" }
    ]
  },
  {
    group: "Food & drink",
    options: [
      { id: "restaurants", label: "Restaurants", categories: "catering.restaurant" },
      { id: "cafes", label: "Cafes", categories: "catering.cafe" },
      { id: "fast-food", label: "Fast food", categories: "catering.fast_food" },
      { id: "ice-cream", label: "Ice cream", categories: "catering.ice_cream" },
      { id: "bars", label: "Bars & pubs", categories: "catering.bar,catering.pub" },
      { id: "all-food", label: "All food & drink", categories: "catering" }
    ]
  },
  {
    group: "Things to do",
    options: [
      { id: "attractions", label: "Tourist attractions", categories: "tourism" },
      { id: "entertainment", label: "Entertainment", categories: "entertainment" },
      { id: "museums", label: "Museums", categories: "entertainment.museum" },
      { id: "sport", label: "Sports & recreation", categories: "sport" },
      { id: "activity", label: "Community & events", categories: "activity" },
      { id: "heritage", label: "Heritage sites", categories: "heritage" }
    ]
  },
  {
    group: "Shopping & stays",
    options: [
      { id: "shops", label: "Shops", categories: "commercial" },
      { id: "supermarkets", label: "Supermarkets", categories: "commercial.supermarket" },
      { id: "accommodation", label: "Accommodation", categories: "accommodation" }
    ]
  },
  {
    group: "Public facilities & services",
    options: [
      { id: "toilets", label: "Public toilets", categories: "amenity.toilet" },
      { id: "water", label: "Drinking water", categories: "amenity.drinking_water" },
      { id: "education", label: "Education", categories: "education" },
      { id: "healthcare", label: "Healthcare", categories: "healthcare" },
      { id: "transport", label: "Public transport", categories: "public_transport" },
      { id: "parking", label: "Parking", categories: "parking" },
      { id: "rental", label: "Rentals (bikes, boats, cars)", categories: "rental" },
      { id: "pets", label: "Pets", categories: "pet" },
      { id: "worship", label: "Places of worship", categories: "religion" },
      { id: "services", label: "Services (banks, post, etc.)", categories: "service" }
    ]
  }
];

/*
  "All categories": Geoapify has no documented wildcard, so we send the
  visitor-relevant parent categories together. Infrastructure categories
  (highway, power, building, man_made, office, production, etc.) are left
  out on purpose because they'd flood the map with things like lamp posts.
*/
const ALL_CATEGORIES_OPTION = {
  id: "all",
  label: "All visitor categories",
  categories: [
    "leisure", "natural", "national_park", "beach", "camping", "tourism",
    "entertainment", "catering", "commercial", "sport", "activity", "heritage",
    "accommodation", "amenity", "education", "healthcare", "public_transport",
    "parking", "rental", "pet", "religion", "service"
  ].join(",")
};

/*
  Nature picks: which Geoapify categories to search for each ACTIVITY.
  This is what makes "Hiking" find mountains and preserves instead of city parks.
  All IDs are from Geoapify's documented category list.
*/
const NATURE_ACTIVITY_CATEGORIES = {
  relaxing: {
    words: "relaxing",
    categories: ["leisure.park", "leisure.picnic", "natural.water"]
  },
  walking: {
    words: "walking",
    categories: ["leisure.park", "leisure.park.nature_reserve", "natural.protected_area", "natural.water"]
  },
  hiking: {
    words: "hiking",
    categories: ["natural.mountain", "natural.protected_area", "national_park", "leisure.park.nature_reserve", "natural.forest"]
  },
  exercising: {
    words: "exercising",
    categories: ["leisure.park", "natural.protected_area", "sport.pitch"]
  },
  sightseeing: {
    words: "sightseeing",
    categories: ["tourism.attraction.viewpoint", "tourism.sights", "leisure.park.garden", "natural.water", "natural.mountain"]
  },
  studying: {
    words: "studying",
    // Libraries for focused study, gardens and picnic spots for studying outdoors
    categories: ["education.library", "leisure.park.garden", "leisure.picnic"]
  }
};

// Which categories count as each SETTING. Used to put matching places first.
const NATURE_ENVIRONMENT_CATEGORIES = {
  quiet: ["leisure.park.nature_reserve", "natural.protected_area", "leisure.park.garden", "natural.forest", "education.library"],
  scenic: ["tourism.attraction.viewpoint", "natural.mountain", "natural.water"],
  forest: ["natural.forest"],
  garden: ["leisure.park.garden"],
  "open space": ["leisure.park", "natural.protected_area"]
};

const RADIUS_CHOICES_KM = [1, 5, 10, 25];
const DEFAULT_RADIUS_KM = 5;
const DEFAULT_CATEGORY_ID = "nature";

// Categories we recognise, used to pick a place's main category (most specific first).
const KNOWN_CATEGORIES = [
  "leisure.park.garden", "leisure.park.nature_reserve", "leisure.park", "leisure.playground",
  "leisure.picnic", "national_park", "natural.water", "natural.mountain", "natural.forest",
  "natural", "beach", "camping", "tourism.attraction.viewpoint", "tourism", "catering.cafe",
  "catering.ice_cream", "catering.bar", "catering.pub", "catering", "commercial.supermarket",
  "commercial.books", "commercial", "entertainment.museum", "entertainment", "sport",
  "activity.community_center", "activity", "heritage", "accommodation", "amenity.toilet",
  "amenity.drinking_water", "education.library", "office.coworking", "education", "healthcare",
  "public_transport", "parking", "rental", "pet", "religion", "service", "leisure"
];

// Condition tags Geoapify may include in "categories". Only shown if present.
const FEATURE_LABELS = {
  "wheelchair.yes": "Wheelchair accessible",
  "wheelchair.limited": "Limited wheelchair access",
  "internet_access.free": "Free Wi-Fi",
  "internet_access": "Internet access",
  "dogs.yes": "Dogs allowed",
  "dogs.leashed": "Dogs on leash",
  "no_dogs": "No dogs",
  "no_fee": "Free entry",
  "fee": "Fee required",
  "vegetarian": "Vegetarian options",
  "vegan": "Vegan options",
  "gluten_free": "Gluten-free options",
  "halal": "Halal",
  "kosher": "Kosher"
};


/* ---------- 2. State ---------- */

const finderState = { mode: "explore" };

const exploreState = {
  items: [],
  search: null,        // { center, radiusMeters, category, originLabel, directionsOrigin, distanceLabel }
  nextOffset: 0,
  hasMore: false,
  seenIds: new Set(),  // prevents duplicate places
  controller: null,    // AbortController for the request in progress
  requestId: 0,        // newer searches win over older ones
  started: false,
  loading: false
};

const natureState = {
  items: [],
  controller: null,
  requestId: 0,
  options: null
};

const responseCache = new Map(); // url -> JSON (avoids repeating identical requests)


/* ---------- 3. API requests ---------- */

// An error with a friendly message we can show to users.
class GeoapifyError extends Error {}

function isAbortError(error) {
  return error && error.name === "AbortError";
}

// Fetch JSON from Geoapify with friendly errors, a timeout, and caching.
// postBody (optional): an object sent as JSON with POST (used by the Route Matrix API).
async function fetchGeoapifyJson(url, controller, postBody) {
  const cacheKey = postBody ? url + "|" + JSON.stringify(postBody) : url;
  if (responseCache.has(cacheKey)) return responseCache.get(cacheKey);

  let timedOut = false;
  const timer = setTimeout(function () {
    timedOut = true;
    controller.abort();
  }, REQUEST_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, postBody
      ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(postBody), signal: controller.signal }
      : { signal: controller.signal });
  } catch (error) {
    if (timedOut) throw new GeoapifyError("Geoapify is taking too long to answer. Please try again.");
    if (isAbortError(error)) throw error; // replaced by a newer search; not a real error
    throw new GeoapifyError("Couldn't reach Geoapify. Check your internet connection.");
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 401 || response.status === 403) {
    throw new GeoapifyError("Geoapify rejected the API key. Check the key in map.js and that this website's address is allowed for it.");
  }
  if (response.status === 429) {
    throw new GeoapifyError("Too many requests right now (Geoapify rate limit). Wait a minute and try again.");
  }
  if (!response.ok) {
    throw new GeoapifyError("Geoapify returned an error (" + response.status + "). Please try again.");
  }

  const data = await response.json();

  // Simple cache: forget the oldest entry when full.
  if (responseCache.size >= CACHE_MAX_ENTRIES) {
    responseCache.delete(responseCache.keys().next().value);
  }
  responseCache.set(cacheKey, data);
  return data;
}

// Turn a city, address, or ZIP into coordinates.
async function geocodeLocation(text, controller) {
  const params = new URLSearchParams({ text: text, format: "json", limit: "1", apiKey: GEOAPIFY_API_KEY });

  if (/^\d{5}$/.test(text)) {
    params.set("type", "postcode");          // US ZIP code
    params.set("filter", "countrycode:us");
  } else {
    // Prefer matches near the Cupertino / San Jose demo area.
    params.set("bias", "proximity:" + DEFAULT_MAP_CENTER[1] + "," + DEFAULT_MAP_CENTER[0]);
  }

  const data = await fetchGeoapifyJson(GEOCODE_API_URL + "?" + params.toString(), controller);
  const result = data && Array.isArray(data.results) ? data.results[0] : null;
  if (!result || !Number.isFinite(result.lat) || !Number.isFinite(result.lon)) {
    throw new GeoapifyError("We couldn't find \"" + text + "\". Try a city name, full address, or 5-digit ZIP code.");
  }
  return { lat: result.lat, lon: result.lon, label: result.formatted || text };
}

/*
  Real travel times from one starting point to many places, in ONE request
  (Geoapify Route Matrix API). Returns one-way minutes for each target, in
  the same order, or null where Geoapify found no route.
  origin: { latitude, longitude }    targets: [{ latitude, longitude }, ...]
  transport: "walking" or "driving"
*/
async function fetchTravelMinutes(origin, targets, transport, controller) {
  if (targets.length === 0) return [];
  const body = {
    mode: transport === "walking" ? "walk" : "drive",
    sources: [{ location: [origin.longitude, origin.latitude] }],
    targets: targets.map(function (target) { return { location: [target.longitude, target.latitude] }; })
  };
  const url = ROUTE_MATRIX_API_URL + "?apiKey=" + encodeURIComponent(GEOAPIFY_API_KEY);
  const data = await fetchGeoapifyJson(url, controller || new AbortController(), body);

  const row = data && Array.isArray(data.sources_to_targets) ? data.sources_to_targets[0] : null;
  if (!Array.isArray(row)) throw new GeoapifyError("Geoapify didn't return travel times.");

  const minutes = targets.map(function () { return null; });
  row.forEach(function (cell) {
    if (cell && Number.isInteger(cell.target_index) && Number.isFinite(cell.time)) {
      minutes[cell.target_index] = Math.max(1, Math.round(cell.time / 60)); // seconds -> minutes
    }
  });
  return minutes;
}

// Build a Places API URL for one page of results.
function buildPlacesUrl(center, radiusMeters, categories, limit, offset) {
  const params = new URLSearchParams({
    categories: categories,
    filter: "circle:" + center.lon + "," + center.lat + "," + Math.round(radiusMeters),
    bias: "proximity:" + center.lon + "," + center.lat, // nearest first
    limit: String(limit),
    offset: String(offset),
    lang: "en",
    apiKey: GEOAPIFY_API_KEY
  });
  return PLACES_API_URL + "?" + params.toString();
}

async function fetchPlacesPage(center, radiusMeters, categories, limit, offset, controller) {
  const data = await fetchGeoapifyJson(buildPlacesUrl(center, radiusMeters, categories, limit, offset), controller);
  return data && Array.isArray(data.features) ? data.features : [];
}


/* ---------- 4. Turning API results into map items ---------- */

function humanize(text) {
  const words = String(text).replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

// The most specific real category, e.g. "leisure.park.garden".
function getMainCategory(categories) {
  const known = categories.filter(function (category) {
    return KNOWN_CATEGORIES.some(function (known) { return category === known || category.startsWith(known + "."); });
  });
  const list = known.length > 0 ? known : categories;
  return list.reduce(function (best, category) {
    return category.split(".").length > best.split(".").length ? category : best;
  }, list[0] || "");
}

// "leisure.park.garden" -> "Park · Garden"
function getCategoryLabel(category) {
  if (!category) return "Place";
  const parts = category.split(".");
  const useful = parts.length > 1 ? parts.slice(1) : parts;
  return useful.map(humanize).join(" · ");
}

function getStudyTip(categories) {
  const match = STUDY_TIPS.find(function (pair) {
    return categories.some(function (category) { return category === pair[0] || category.startsWith(pair[0] + "."); });
  });
  return match ? match[1] : null;
}

function getFeatureTags(categories) {
  const tags = [];
  categories.forEach(function (category) {
    if (FEATURE_LABELS[category] && !tags.includes(FEATURE_LABELS[category])) {
      tags.push(FEATURE_LABELS[category]);
    }
  });
  return tags;
}

// Only allow normal web links (no "javascript:" etc.).
function getSafeWebsite(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value.startsWith("http") ? value : "https://" + value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch (error) {
    return null;
  }
}

function formatDistance(miles) {
  const km = miles * 1.609344;
  return (miles < 0.1 ? "<0.1" : miles.toFixed(1)) + " mi (" + km.toFixed(1) + " km)";
}

// Google Maps directions to exact coordinates (no API key needed).
function getCoordinateDirectionsUrl(lat, lon, origin, travelMode) {
  let url = "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(lat + "," + lon);
  if (origin) url += "&origin=" + encodeURIComponent(origin);
  if (travelMode) url += "&travelmode=" + travelMode;
  return url;
}

/*
  Convert one Geoapify GeoJSON feature into a map item.
  Returns null if it has no usable coordinates.
  Only fields that Geoapify actually returned are shown.
*/
function featureToMapItem(feature, search, badge) {
  const props = feature && feature.properties ? feature.properties : {};
  const coords = feature && feature.geometry && Array.isArray(feature.geometry.coordinates) ? feature.geometry.coordinates : [];
  const lat = Number.isFinite(props.lat) ? props.lat : coords[1];
  const lon = Number.isFinite(props.lon) ? props.lon : coords[0];
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;

  const categories = Array.isArray(props.categories) ? props.categories : [];
  const mainCategory = getMainCategory(categories);
  const categoryLabel = getCategoryLabel(mainCategory);
  const hasName = typeof props.name === "string" && props.name.trim() !== "";
  const name = hasName ? props.name.trim() : "Unnamed " + categoryLabel.toLowerCase();
  const address = props.formatted || [props.address_line1, props.address_line2].filter(Boolean).join(", ");
  const id = "geo:" + (props.place_id || lat.toFixed(6) + "," + lon.toFixed(6));

  // Extra details from OpenStreetMap, only when present.
  const raw = props.datasource && props.datasource.raw ? props.datasource.raw : {};
  const sections = [];

  if (search && search.center) {
    const miles = distanceInMiles(search.center.lat, search.center.lon, lat, lon);
    sections.push({ label: "Distance", text: formatDistance(miles) + " from " + search.distanceLabel + " (straight line)" });
  }
  if (typeof raw.description === "string" && raw.description.trim()) {
    sections.push({ label: "Description", text: raw.description.trim() });
  }
  const studyTip = getStudyTip(categories);
  if (studyTip) sections.unshift({ label: "Study tip", text: studyTip });
  const features = getFeatureTags(categories);
  if (features.length > 0) sections.push({ label: "Features", tags: features });
  if (typeof raw.opening_hours === "string" && raw.opening_hours.trim()) {
    sections.push({ label: "Opening hours (from OpenStreetMap)", text: raw.opening_hours.trim() });
  }
  const website = getSafeWebsite(props.website || raw.website);
  if (website) sections.push({ label: "Website", linkText: new URL(website).hostname, href: website });

  return {
    id: id,
    name: name,
    latitude: lat,
    longitude: lon,
    source: "geoapify",
    badge: badge,
    categoryLabel: categoryLabel,
    categories: categories,
    address: address,
    score: null,
    reasons: null,
    sections: sections,
    note: "",
    directionsUrl: getCoordinateDirectionsUrl(lat, lon, search ? search.directionsOrigin : null, search ? search.travelMode : null),
    favorite: { id: id, name: name, latitude: lat, longitude: lon, address: address, category: categoryLabel, source: "geoapify" }
  };
}

// Convert features, skipping bad coordinates and places already shown.
function featuresToNewItems(features, search, seenIds, badge) {
  const items = [];
  features.forEach(function (feature) {
    const item = featureToMapItem(feature, search, badge);
    if (!item || seenIds.has(item.id)) return;
    seenIds.add(item.id);
    items.push(item);
  });
  return items;
}


/* ---------- 5. Explore mode searches ---------- */

function getAllCategoryOptions() {
  return [ALL_CATEGORIES_OPTION].concat(
    CATEGORY_GROUPS.reduce(function (all, group) { return all.concat(group.options); }, [])
  );
}

function getSelectedCategory() {
  const id = document.getElementById("explore-category").value;
  return getAllCategoryOptions().find(function (option) { return option.id === id; }) || ALL_CATEGORIES_OPTION;
}

function getSelectedRadiusMeters() {
  return Number(document.getElementById("explore-radius").value) * 1000;
}

function setExploreStatus(text, isError) {
  const status = document.getElementById("explore-status");
  status.textContent = text;
  status.classList.toggle("is-error", Boolean(isError));
}

function setExploreLoading(isLoading, label) {
  exploreState.loading = isLoading;
  document.getElementById("explore-panel").classList.toggle("is-loading", isLoading);
  document.getElementById("explore-search-button").disabled = isLoading;
  const loadMore = document.getElementById("load-more-places");
  loadMore.disabled = isLoading;
  loadMore.textContent = isLoading && label === "more" ? "Loading…" : "Load more places";
  if (isLoading) setExploreStatus(label === "more" ? "Loading more places…" : "Searching…", false);
}

function updateExploreSummary() {
  const search = exploreState.search;
  const count = exploreState.items.length;
  const radiusKm = search.radiusMeters / 1000;
  let text;
  if (count === 0) {
    text = "No " + search.category.label.toLowerCase() + " found within " + radiusKm + " km of " + search.originLabel + ". Try a bigger radius or another category.";
  } else {
    text = "Showing " + count + " place" + (count === 1 ? "" : "s") + " · " + search.category.label + " · within " + radiusKm + " km of " + search.originLabel;
    if (!exploreState.hasMore && count >= PLACES_PAGE_SIZE) text += " · all results loaded";
  }
  setExploreStatus(text, false);
  document.getElementById("load-more-places").hidden = !exploreState.hasMore;
}

// "Study places (all)": libraries first, then coworking, community centers,
// campuses, cafes and bookstores (the order of STUDY_CATEGORIES).
function getStudyRank(item) {
  const rank = STUDY_CATEGORIES.findIndex(function (study) {
    return item.categories.some(function (category) { return category === study || category.startsWith(study + "."); });
  });
  return rank === -1 ? STUDY_CATEGORIES.length : rank;
}

function sortForSearch(items, search) {
  if (search.category.id !== "study") return items;
  return items.slice().sort(function (a, b) { return getStudyRank(a) - getStudyRank(b); });
}

// Cancel whatever Explore request is running (a newer one replaces it).
function startNewExploreRequest() {
  if (exploreState.controller) exploreState.controller.abort();
  exploreState.controller = new AbortController();
  exploreState.requestId += 1;
  return { controller: exploreState.controller, requestId: exploreState.requestId };
}

/*
  Run a fresh search around a center point.
  where = { center: {lat, lon}, originLabel, directionsOrigin, distanceLabel }
*/
async function runExploreSearch(where) {
  if (isApiKeyMissing()) {
    setExploreStatus("Add your Geoapify API key at the top of map.js to search places. Nature picks still work without it.", true);
    ensureMapReady();
    return;
  }

  const request = startNewExploreRequest();
  hideSearchAreaButton();
  setExploreLoading(true, "new");

  const search = {
    center: where.center,
    radiusMeters: getSelectedRadiusMeters(),
    category: getSelectedCategory(),
    originLabel: where.originLabel,
    directionsOrigin: where.directionsOrigin,
    distanceLabel: where.distanceLabel || where.originLabel,
    travelMode: null
  };

  try {
    const features = await fetchPlacesPage(search.center, search.radiusMeters, search.category.categories, PLACES_PAGE_SIZE, 0, request.controller);
    if (request.requestId !== exploreState.requestId) return; // an older answer arrived late

    exploreState.search = search;
    exploreState.seenIds = new Set();
    exploreState.items = sortForSearch(featuresToNewItems(features, search, exploreState.seenIds, "Discovered"), search);
    exploreState.nextOffset = PLACES_PAGE_SIZE;
    exploreState.hasMore = features.length >= PLACES_PAGE_SIZE && exploreState.nextOffset < PLACES_MAX_TOTAL;

    setMapItems(exploreState.items, {
      emptyMessage: "No places found here. Try a bigger radius, another category, or move the map and tap “Search this area”."
    });
    if (exploreState.items.length === 0) setMapView(search.center.lat, search.center.lon, 13);
    setExploreLoading(false);
    updateExploreSummary();
  } catch (error) {
    if (isAbortError(error)) return;
    if (request.requestId !== exploreState.requestId) return;
    setExploreLoading(false);
    showExploreError(error);
  }
}

function showExploreError(error) {
  const message = error instanceof GeoapifyError ? error.message : "Something went wrong while searching. Please try again.";
  console.error(error);
  setExploreStatus(message + " You can still use Nature picks, which works with our verified park list.", true);
}

// "Load more places": ask for the next page (offset) of the same search.
async function loadMorePlaces() {
  const search = exploreState.search;
  if (!search || !exploreState.hasMore || exploreState.loading) return;

  const request = startNewExploreRequest();
  setExploreLoading(true, "more");

  try {
    const offset = exploreState.nextOffset;
    const features = await fetchPlacesPage(search.center, search.radiusMeters, search.category.categories, PLACES_PAGE_SIZE, offset, request.controller);
    if (request.requestId !== exploreState.requestId) return;

    const newItems = sortForSearch(featuresToNewItems(features, search, exploreState.seenIds, "Discovered"), search);
    exploreState.items = exploreState.items.concat(newItems);
    exploreState.nextOffset = offset + PLACES_PAGE_SIZE;
    exploreState.hasMore = features.length >= PLACES_PAGE_SIZE && exploreState.nextOffset < PLACES_MAX_TOTAL;

    if (finderState.mode === "explore") appendMapItems(newItems);
    setExploreLoading(false);
    updateExploreSummary();
  } catch (error) {
    if (isAbortError(error)) return;
    if (request.requestId !== exploreState.requestId) return;
    setExploreLoading(false);
    showExploreError(error);
  }
}

// Search near a typed city, address, or ZIP code.
async function handleLocationSearch(event) {
  event.preventDefault();
  const text = document.getElementById("explore-location").value.trim();

  if (text === "") {
    // Nothing typed: search wherever the map is looking.
    handleSearchThisArea();
    return;
  }
  if (isApiKeyMissing()) {
    runExploreSearch({});
    return;
  }

  const request = startNewExploreRequest();
  setExploreLoading(true, "new");
  try {
    const place = await geocodeLocation(text, request.controller);
    if (request.requestId !== exploreState.requestId) return;
    setExploreLoading(false);
    runExploreSearch({
      center: { lat: place.lat, lon: place.lon },
      originLabel: place.label,
      directionsOrigin: text,
      distanceLabel: text
    });
  } catch (error) {
    if (isAbortError(error)) return;
    if (request.requestId !== exploreState.requestId) return;
    setExploreLoading(false);
    showExploreError(error);
  }
}

// Search around the map's current center.
function handleSearchThisArea() {
  runExploreSearch({
    center: getMapCenter(),
    originLabel: "this map area",
    directionsOrigin: null,
    distanceLabel: "the map center"
  });
}

/*
  "Use my location": only asks the browser for permission AFTER the click.
  We round to 3 decimals (about 100 m) and never store or display the
  coordinates. Browsers only allow this on https:// or localhost.
*/
function handleUseMyLocation() {
  if (!("geolocation" in navigator) || !window.isSecureContext) {
    setExploreStatus("Your browser can't share location here. Location needs https:// or localhost (Live Server's 127.0.0.1 works).", true);
    return;
  }

  setExploreStatus("Asking your browser for your location…", false);
  navigator.geolocation.getCurrentPosition(
    function (position) {
      const center = {
        lat: Math.round(position.coords.latitude * 1000) / 1000,
        lon: Math.round(position.coords.longitude * 1000) / 1000
      };
      setUserLocation(center.lat, center.lon);
      runExploreSearch({
        center: center,
        originLabel: "your location",
        directionsOrigin: null, // Google Maps uses your current location by default
        distanceLabel: "you"
      });
    },
    function (error) {
      const messages = {
        1: "Location permission was denied. You can type a city or ZIP code instead.",
        2: "Your location isn't available right now. Try typing a city or ZIP code.",
        3: "Getting your location took too long. Try again or type a city or ZIP code."
      };
      setExploreStatus(messages[error.code] || messages[2], true);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

// When the category or radius changes, repeat the last search with the new filter.
let filterChangeTimer = null;
function handleFilterChange() {
  clearTimeout(filterChangeTimer);
  filterChangeTimer = setTimeout(function () {
    const last = exploreState.search;
    if (!last) return;
    runExploreSearch({
      center: last.center,
      originLabel: last.originLabel,
      directionsOrigin: last.directionsOrigin,
      distanceLabel: last.distanceLabel
    });
  }, 300); // wait for quick, repeated changes to settle
}

function showSearchAreaButton() {
  if (finderState.mode !== "explore") return;
  document.getElementById("search-area-button").hidden = false;
}

function hideSearchAreaButton() {
  document.getElementById("search-area-button").hidden = true;
}

// First visit to Explore: one search for nature near the demo area.
function startExploreIfNeeded() {
  if (exploreState.started) return;
  exploreState.started = true;
  runExploreSearch({
    center: { lat: DEFAULT_MAP_CENTER[0], lon: DEFAULT_MAP_CENTER[1] },
    originLabel: "Cupertino & San Jose (demo area)",
    directionsOrigin: null,
    distanceLabel: "the demo area center"
  });
}


/* ---------- 6. Nature picks: nearby parks from Geoapify ---------- */

/*
  Called by script.js after scoring the verified parks.
  localItems already have scores. We add Geoapify parks nearby WITHOUT
  scores, skipping any that are really one of our verified parks.
*/
async function showNatureResults(localItems, prefs) {
  natureState.items = localItems.slice();
  natureState.options = { prefs: prefs };

  if (natureState.controller) natureState.controller.abort();
  natureState.requestId += 1;
  const requestId = natureState.requestId;

  if (finderState.mode === "nature") {
    setMapItems(natureState.items, {
      emptyMessage: isApiKeyMissing() ? "No verified matches to show." : "Looking for parks nearby…"
    });
  }

  if (isApiKeyMissing()) return;

  natureState.controller = new AbortController();
  const center = prefs.origin
    ? { lat: prefs.origin.latitude, lon: prefs.origin.longitude }
    : { lat: DEFAULT_MAP_CENTER[0], lon: DEFAULT_MAP_CENTER[1] };
  // Hikes are farther away, so drivers looking for hikes search wider.
  let radiusMeters = prefs.transport === "walking" ? 3000 : 15000;
  if (prefs.activity === "hiking" && prefs.transport === "driving") radiusMeters = 25000;
  const activity = NATURE_ACTIVITY_CATEGORIES[prefs.activity] || NATURE_ACTIVITY_CATEGORIES.walking;
  const search = {
    center: center,
    distanceLabel: prefs.origin ? prefs.originLabel : "the demo area center",
    directionsOrigin: prefs.directionsOrigin || null,
    travelMode: prefs.transport
  };

  try {
    const features = await fetchPlacesPage(center, radiusMeters, activity.categories.join(","), 30, 0, natureState.controller);
    if (requestId !== natureState.requestId) return;

    const seen = new Set(localItems.map(function (item) { return item.id; }));
    let discovered = sortBySettingMatch(
      featuresToNewItems(features, search, seen, "Discovered nearby · not scored")
        .filter(function (item) { return !isNearVerifiedPark(item); })
        .map(function (item) { return addNatureMatchInfo(item, prefs); })
    );

    // Real travel times for the discovered places too (one more request).
    if (prefs.origin && discovered.length > 0) {
      try {
        const minutes = await fetchTravelMinutes(prefs.origin, discovered, prefs.transport, natureState.controller);
        if (requestId !== natureState.requestId) return;
        discovered.forEach(function (item, index) {
          item.travelMinutes = minutes[index];
          if (minutes[index] !== null) {
            item.sections.unshift({ label: "Your time", text: describeTimeBudget(prefs, minutes[index]) });
          }
        });
        // Drop places where the round trip would use up all the time.
        discovered = discovered.filter(function (item) {
          return item.travelMinutes === null || prefs.time - 2 * item.travelMinutes > 0;
        });
      } catch (error) {
        if (isAbortError(error) || requestId !== natureState.requestId) return;
        console.warn("Travel times for discovered places unavailable:", error);
      }
    }

    natureState.items = natureState.items.concat(discovered);
    if (finderState.mode === "nature") {
      appendMapItems(discovered);
      if (natureState.items.length === 0) {
        setMapItems([], { emptyMessage: "No parks found nearby." });
      }
    }
    updateNatureDiscoveredNote(discovered.length, "", activity.words, radiusMeters);
  } catch (error) {
    if (isAbortError(error) || requestId !== natureState.requestId) return;
    console.error(error);
    updateNatureDiscoveredNote(-1, error instanceof GeoapifyError ? error.message : "");
  }
}

// True if any of the place's categories is (or is inside) one of the given categories.
function hasCategoryIn(item, wanted) {
  return (item.categories || []).some(function (category) {
    return wanted.some(function (w) { return category === w || category.startsWith(w + "."); });
  });
}

/*
  Explain, using only the place's real Geoapify categories, why it was found.
  We don't score these places, but we do say which of the user's choices fit.
*/
function addNatureMatchInfo(item, prefs) {
  const activity = NATURE_ACTIVITY_CATEGORIES[prefs.activity];
  const settingCategories = NATURE_ENVIRONMENT_CATEGORIES[prefs.environment];
  const fits = [];

  if (activity && hasCategoryIn(item, activity.categories)) {
    fits.push("Found for " + activity.words);
  }
  item.matchesSetting = Boolean(settingCategories && hasCategoryIn(item, settingCategories));
  if (item.matchesSetting) fits.push(capitalize(prefs.environment) + " setting");

  if (fits.length > 0) {
    item.sections.unshift({ label: "Fits your choices (based on its category: " + item.categoryLabel + ")", tags: fits });
  }
  if (hasCategoryIn(item, ["natural.mountain"])) {
    item.note = "Mountain points mark summits. Check trail access and conditions before you go.";
  }
  return item;
}

// Places that also match the chosen setting come first; otherwise keep nearest-first.
function sortBySettingMatch(items) {
  return items
    .map(function (item, index) { return { item: item, index: index }; })
    .sort(function (a, b) {
      if (a.item.matchesSetting !== b.item.matchesSetting) return a.item.matchesSetting ? -1 : 1;
      return a.index - b.index;
    })
    .map(function (entry) { return entry.item; });
}

// Skip a Geoapify park if it's within ~250 m of one of our verified parks (same place).
// Libraries are never the same place as a park, so they are always kept.
function isNearVerifiedPark(item) {
  if (hasCategoryIn(item, ["education.library"])) return false;
  return allParks.some(function (park) {
    return distanceInMiles(park.latitude, park.longitude, item.latitude, item.longitude) < 0.15;
  });
}

function updateNatureDiscoveredNote(count, errorMessage, activityWords, radiusMeters) {
  const header = document.getElementById("results-header");
  let note = header.querySelector(".discovered-note");
  if (!note) {
    note = createElement("p", "discovered-note");
    header.appendChild(note);
  }
  if (count < 0) {
    note.textContent = "Couldn't load extra parks from Geoapify. " + (errorMessage || "") + " Your verified matches are still shown.";
  } else if (count === 0) {
    note.textContent = "No extra places for " + activityWords + " found on Geoapify within " + radiusMeters / 1000 + " km.";
  } else {
    note.textContent = "The map also shows " + count + " place" + (count === 1 ? "" : "s") + " for " + activityWords +
      " found on Geoapify within " + radiusMeters / 1000 + " km. They aren't scored, because we don't have their visit-time details. Each card says which of your choices its category fits.";
  }
}

// Clear Nature results (form reset or data error).
function clearNatureResults() {
  if (natureState.controller) natureState.controller.abort();
  natureState.requestId += 1;
  natureState.items = [];
  if (finderState.mode === "nature") hideResultsMap();
}


/* ---------- 7. Mode switching and setup ---------- */

function setFinderMode(mode) {
  finderState.mode = mode === "nature" ? "nature" : "explore";
  const isExplore = finderState.mode === "explore";

  document.getElementById("mode-explore").setAttribute("aria-selected", String(isExplore));
  document.getElementById("mode-nature").setAttribute("aria-selected", String(!isExplore));
  document.getElementById("mode-explore").classList.toggle("active", isExplore);
  document.getElementById("mode-nature").classList.toggle("active", !isExplore);
  document.getElementById("explore-panel").hidden = !isExplore;
  document.getElementById("nature-panel").hidden = isExplore;
  document.getElementById("results-header").hidden = isExplore;
  document.getElementById("results").hidden = isExplore;
  hideSearchAreaButton();

  if (isExplore) {
    ensureMapReady();
    if (exploreState.search) {
      setMapItems(exploreState.items, { emptyMessage: "No places found here." });
    } else {
      startExploreIfNeeded();
    }
  } else if (natureState.items.length > 0) {
    setMapItems(natureState.items, {});
  } else {
    hideResultsMap();
  }
}

// Called by script.js whenever the Find page is shown.
function onFinderShown() {
  setFinderMode(finderState.mode);
  refreshMapSize();
}

function buildCategorySelect() {
  const select = document.getElementById("explore-category");
  select.textContent = "";
  select.appendChild(new Option(ALL_CATEGORIES_OPTION.label, ALL_CATEGORIES_OPTION.id));
  CATEGORY_GROUPS.forEach(function (group) {
    const optgroup = document.createElement("optgroup");
    optgroup.label = group.group;
    group.options.forEach(function (option) {
      optgroup.appendChild(new Option(option.label, option.id));
    });
    select.appendChild(optgroup);
  });
  select.value = DEFAULT_CATEGORY_ID;
}

// Choose a category (from a quick pick or a homepage link) and search with it.
function pickCategory(id) {
  const select = document.getElementById("explore-category");
  if (!getAllCategoryOptions().some(function (option) { return option.id === id; })) return;
  select.value = id;
  updateQuickPicks();
  if (exploreState.search) {
    handleFilterChange(); // repeat the last search with the new category
  } else if (exploreState.started) {
    exploreState.started = false; // first search still loading: restart it
    startExploreIfNeeded();
  } else if (finderState.mode === "explore" && !document.getElementById("view-finder").hidden) {
    startExploreIfNeeded();
  } // otherwise the first search (when Find opens) uses the chosen category
}

// Highlight the quick pick that matches the selected category.
function updateQuickPicks() {
  const current = document.getElementById("explore-category").value;
  document.querySelectorAll(".chip-button[data-category]").forEach(function (button) {
    const active = button.dataset.category === current;
    button.classList.toggle("active", active);
    button.setAttribute("aria-pressed", String(active));
  });
}

function buildRadiusSelect() {
  const select = document.getElementById("explore-radius");
  select.textContent = "";
  RADIUS_CHOICES_KM.forEach(function (km) {
    select.appendChild(new Option(km + " km (" + (km * 0.621371).toFixed(1) + " mi)", String(km)));
  });
  select.value = String(DEFAULT_RADIUS_KM);
}

// Set up Explore controls once. Called from script.js init().
function initPlaces() {
  buildCategorySelect();
  buildRadiusSelect();

  document.getElementById("explore-form").addEventListener("submit", handleLocationSearch);
  document.getElementById("use-my-location").addEventListener("click", handleUseMyLocation);
  document.getElementById("explore-category").addEventListener("change", handleFilterChange);
  document.getElementById("explore-radius").addEventListener("change", handleFilterChange);
  document.getElementById("search-area-button").addEventListener("click", handleSearchThisArea);
  document.getElementById("load-more-places").addEventListener("click", loadMorePlaces);

  document.getElementById("mode-explore").addEventListener("click", function () { setFinderMode("explore"); });
  document.getElementById("mode-nature").addEventListener("click", function () { setFinderMode("nature"); });

  // Quick picks choose a category.
  document.querySelectorAll("[data-category]").forEach(function (button) {
    button.addEventListener("click", function () { pickCategory(button.dataset.category); });
  });
  updateQuickPicks();
  document.getElementById("explore-category").addEventListener("change", updateQuickPicks);

  // Links like "Get nature picks" on the homepage choose a mode before opening Find.
  document.querySelectorAll("[data-mode]").forEach(function (link) {
    link.addEventListener("click", function () { finderState.mode = link.dataset.mode; });
  });

  setUserMoveHandler(showSearchAreaButton);
}
