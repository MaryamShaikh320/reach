/* =========================================================
   GreenEscape — script.js
   1. Settings
   2. Loading park data
   3. Recommendation algorithm (rule-based scoring)
   4. Rendering cards (safe DOM building, no innerHTML with data)
   5. Favorites (localStorage)
   6. Navigation between views
   7. Form handling and validation
   ========================================================= */

/* ---------- 1. Settings ---------- */

// Points for each scoring factor. They add up to 100.
const POINTS = {
  activity: 40,
  environment: 30,
  duration: 20,
  transport: 10
};

// A park needs at least this many points to count as a "match".
const MATCH_THRESHOLD = 50;

// Note: there is no "top 3" limit anymore. Every verified park that scores
// at least MATCH_THRESHOLD is shown, and places.js adds nearby parks from Geoapify.

// Distance rules for walkers (straight-line miles from their ZIP code).
const EASY_WALK_MILES = 2;   // full transport points
const LONG_WALK_MILES = 4;   // half transport points

// Same idea when we have real walking times (minutes, one way).
const EASY_WALK_MINUTES = 25;
const LONG_WALK_MINUTES = 45;

// Free ZIP code lookup service. No API key or signup needed.
// Example: https://api.zippopotam.us/us/95014
const ZIP_API_URL = "https://api.zippopotam.us/us/";

// localStorage key for saved favorites.
const FAVORITES_KEY = "greenescape-favorites";

// All parks, filled in after parks.json loads.
let allParks = [];


/* ---------- 2. Loading park data ---------- */

// Make sure a park object has every field we need.
// Bad entries are skipped instead of crashing the app.
function isValidPark(park) {
  return (
    park &&
    typeof park.id === "string" &&
    typeof park.name === "string" &&
    typeof park.address === "string" &&
    typeof park.latitude === "number" &&
    typeof park.longitude === "number" &&
    typeof park.description === "string" &&
    Array.isArray(park.activities) &&
    Array.isArray(park.environments) &&
    typeof park.minVisitMinutes === "number" &&
    typeof park.typicalVisitMinutes === "number" &&
    Array.isArray(park.amenities)
  );
}

async function loadParks() {
  const response = await fetch("parks.json");
  if (!response.ok) {
    throw new Error("Could not load parks.json (status " + response.status + ")");
  }
  const data = await response.json();
  if (!Array.isArray(data)) {
    throw new Error("parks.json should contain a list of parks");
  }
  const validParks = data.filter(isValidPark);
  if (validParks.length < data.length) {
    console.warn("Skipped " + (data.length - validParks.length) + " park(s) with missing fields.");
  }
  return validParks;
}


/* ---------- 2b. Starting ZIP code ---------- */

// A US ZIP code is exactly 5 digits.
function isValidZip(zip) {
  return /^\d{5}$/.test(zip);
}

// Remember ZIP codes we already looked up, so we don't ask twice.
const zipCache = {};

/*
  Turn a ZIP code into map coordinates using the free Zippopotam.us service.
  Returns { zip, latitude, longitude }, or null if the ZIP is not found
  or the internet request fails. The app still works without it.
*/
async function lookupZip(zip) {
  if (zipCache[zip] !== undefined) return zipCache[zip];

  // Give up after 5 seconds so the app never hangs.
  const controller = new AbortController();
  const timer = setTimeout(function () { controller.abort(); }, 5000);

  try {
    const response = await fetch(ZIP_API_URL + zip, { signal: controller.signal });
    if (!response.ok) {
      zipCache[zip] = null; // 404 means the ZIP code doesn't exist
      return null;
    }
    const data = await response.json();
    const place = data && Array.isArray(data.places) ? data.places[0] : null;
    const latitude = place ? parseFloat(place.latitude) : NaN;
    const longitude = place ? parseFloat(place.longitude) : NaN;

    if (isNaN(latitude) || isNaN(longitude)) {
      zipCache[zip] = null;
      return null;
    }
    zipCache[zip] = { zip: zip, latitude: latitude, longitude: longitude };
    return zipCache[zip];
  } catch (error) {
    // Network problem: don't cache, so the next try can succeed.
    console.warn("ZIP lookup failed:", error);
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/*
  Straight-line ("as the crow flies") distance in miles between two points,
  using the haversine formula. Real walking or driving routes are longer.
*/
function distanceInMiles(lat1, lon1, lat2, lon2) {
  const EARTH_RADIUS_MILES = 3958.8;
  const toRadians = function (degrees) { return degrees * Math.PI / 180; };
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRadians(lat1)) * Math.cos(toRadians(lat2)) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  return EARTH_RADIUS_MILES * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}


/* ---------- 3. Recommendation algorithm ---------- */

// Turn "open space" into "Open space" for display.
function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/*
  scorePark compares ONE park with the user's preferences.
  It returns the total score plus a list of reasons.
  Each reason is { text: "...", matched: true/false }.

  prefs looks like:
  { time: 30, activity: "relaxing", transport: "walking", environment: "quiet",
    origin: { latitude, longitude } or null,      // starting point (ZIP or location)
    originLabel: "95014" or "your location",
    travelMinutes: { "park-id": 12, ... } or null } // one-way trip from Geoapify routing
*/

// Real one-way travel minutes for this park, or null if we don't have them.
function getTravelMinutes(park, prefs) {
  if (!prefs.travelMinutes) return null;
  const minutes = prefs.travelMinutes[park.id];
  return Number.isFinite(minutes) ? minutes : null;
}

function travelVerb(prefs) {
  return prefs.transport === "walking" ? "walk" : "drive";
}
function scorePark(park, prefs) {
  let score = 0;
  const reasons = [];

  // Factor 1 — Activity (40 points)
  if (park.activities.includes(prefs.activity)) {
    score += POINTS.activity;
    reasons.push({ text: "Good for " + prefs.activity, matched: true });
  } else {
    reasons.push({ text: "Not known for " + prefs.activity, matched: false });
  }

  // Factor 2 — Environment (30 points)
  if (prefs.environment === "any") {
    score += POINTS.environment;
    reasons.push({ text: "Any setting works for you", matched: true });
  } else if (park.environments.includes(prefs.environment)) {
    score += POINTS.environment;
    reasons.push({ text: capitalize(prefs.environment) + " setting, like you asked", matched: true });
  } else {
    reasons.push({ text: "Setting is " + park.environments.join(", ") + " rather than " + prefs.environment, matched: false });
  }

  // Factor 3 — Visit duration (20 points full, 10 points partial)
  // prefs.time is the user's TOTAL free time. If we have real travel times,
  // the trip there and back is subtracted. If not, all of it counts as time there.
  const travelMinutes = getTravelMinutes(park, prefs);
  const minutesThere = travelMinutes === null ? prefs.time : prefs.time - 2 * travelMinutes;
  let tripText = travelMinutes === null ? "" :
    "~" + travelMinutes + " min " + travelVerb(prefs) + " each way, ";
  if (travelMinutes === null && prefs.travelMinutes) {
    tripText = "No route found, so travel isn't counted. "; // routing worked, but not for this park
  }

  if (minutesThere <= 0) {
    reasons.push({ text: tripText + "so no time left there", matched: false });
  } else if (park.minVisitMinutes <= minutesThere) {
    score += POINTS.duration;
    reasons.push({
      text: travelMinutes === null
        ? tripText + "Enjoyable in " + prefs.time + " minutes or less"
        : tripText + "leaving ~" + minutesThere + " min there (enough)",
      matched: true
    });
  } else if (park.minVisitMinutes <= minutesThere * 2) {
    score += POINTS.duration / 2;
    reasons.push({
      text: tripText + (travelMinutes === null ? "" : "leaving ~" + minutesThere + " min there. ") +
        "A bit short: best with " + park.minVisitMinutes + "+ min",
      matched: false
    });
  } else {
    reasons.push({
      text: tripText + (travelMinutes === null ? "" : "leaving ~" + minutesThere + " min there. ") +
        "Needs at least " + park.minVisitMinutes + " min",
      matched: false
    });
  }

  // Factor 4 — Transportation (10 points)
  // Walking with real travel times: up to 25 min each way is easy, up to 45 is long.
  // Walking with only a starting point: straight-line distance.
  // Otherwise: city parks are easier to reach on foot, parks with parking suit drivers.
  let distance = null;
  if (prefs.origin) {
    distance = distanceInMiles(
      prefs.origin.latitude, prefs.origin.longitude,
      park.latitude, park.longitude
    );
  }
  const milesText = distance === null ? "" : distance.toFixed(1) + " mi";

  if (prefs.transport === "walking" && travelMinutes !== null) {
    if (travelMinutes <= EASY_WALK_MINUTES) {
      score += POINTS.transport;
      reasons.push({ text: "Reasonable walk from " + prefs.originLabel, matched: true });
    } else if (travelMinutes <= LONG_WALK_MINUTES) {
      score += POINTS.transport / 2;
      reasons.push({ text: "A long walk from " + prefs.originLabel, matched: false });
    } else {
      reasons.push({ text: "Too far to walk from " + prefs.originLabel, matched: false });
    }
  } else if (prefs.transport === "walking" && distance !== null) {
    if (distance <= EASY_WALK_MILES) {
      score += POINTS.transport;
      reasons.push({ text: "About " + milesText + " away, a reasonable walk", matched: true });
    } else if (distance <= LONG_WALK_MILES) {
      score += POINTS.transport / 2;
      reasons.push({ text: "About " + milesText + " away, a long walk", matched: false });
    } else {
      reasons.push({ text: "About " + milesText + " away, too far to walk", matched: false });
    }
  } else if (prefs.transport === "walking") {
    if (park.setting === "city") {
      score += POINTS.transport;
      reasons.push({ text: "Neighborhood park, easier to reach on foot", matched: true });
    } else {
      reasons.push({ text: "In the foothills, usually reached by car", matched: false });
    }
  } else {
    const hasParking = park.amenities.some(function (item) {
      return item.toLowerCase().includes("parking");
    });
    if (hasParking) {
      score += POINTS.transport;
      reasons.push({ text: "Has parking", matched: true });
    } else {
      reasons.push({ text: "No parking listed", matched: false });
    }
  }

  return {
    park: park, score: score, reasons: reasons, distance: distance,
    travelMinutes: travelMinutes, minutesThere: minutesThere
  };
}

// Score every park, sort highest first, and keep every park that matches.
// Parks where the round trip uses up all the time are left out: you couldn't enjoy them.
function getRecommendations(parks, prefs) {
  const scored = parks.map(function (park) {
    return scorePark(park, prefs);
  });

  scored.sort(function (a, b) {
    // Higher score first. If tied: closer first (when we know the distance),
    // then shorter minimum visit first.
    if (b.score !== a.score) return b.score - a.score;
    if (a.distance !== null && b.distance !== null && a.distance !== b.distance) {
      return a.distance - b.distance;
    }
    return a.park.minVisitMinutes - b.park.minVisitMinutes;
  });

  return scored
    .filter(function (result) { return result.score >= MATCH_THRESHOLD && result.minutesThere > 0; });
}


/* ---------- 4. Rendering ---------- */

// Small helper: create an element with a class and text.
// Using textContent (not innerHTML) keeps park data from being treated as HTML.
function createElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

// Build the Google Maps directions link. No API key needed.
// prefs is optional: if it has a ZIP and transport, the link starts from that ZIP
// and uses walking or driving directions.
function getDirectionsUrl(park, prefs) {
  // If the address is not verified, use exact coordinates instead.
  const destination = park.address.startsWith("PLACEHOLDER")
    ? park.latitude + "," + park.longitude
    : park.name + ", " + park.address;

  let url = "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(destination);

  // Start from the typed ZIP. With "Use my location", Google Maps uses the
  // phone's current location by itself, so we don't put coordinates in the link.
  if (prefs && prefs.directionsOrigin) {
    url += "&origin=" + encodeURIComponent(prefs.directionsOrigin);
  }
  if (prefs && (prefs.transport === "walking" || prefs.transport === "driving")) {
    url += "&travelmode=" + prefs.transport;
  }
  return url;
}

/*
  The "Compare" list: one row per match, with the same columns lined up
  (score, trip, time there, visit length) so parks are easy to compare.
  Each row can be opened to see the description and "Why this matches".
*/
function createCompareTable(results, prefs) {
  const table = createElement("div", "compare");
  const hasTravel = results.some(function (r) { return r.travelMinutes !== null && r.travelMinutes !== undefined; });

  // Column headings (hidden on phones, where rows stack)
  const head = createElement("div", "compare-head");
  head.setAttribute("aria-hidden", "true");
  ["#", "Park", "Match", hasTravel ? "Trip each way" : "Distance", "Time there", "Visit", ""].forEach(function (label) {
    head.appendChild(createElement("span", "", label));
  });
  table.appendChild(head);

  const list = createElement("ol", "compare-list");
  results.forEach(function (result, index) {
    list.appendChild(createCompareRow(result, index, prefs));
  });
  table.appendChild(list);
  return table;
}

function createCompareRow(result, index, prefs) {
  const park = result.park;
  const row = createElement("li", "compare-row" + (index === 0 ? " is-best" : ""));
  row.style.animationDelay = Math.min(index * 50, 400) + "ms";

  const main = createElement("div", "compare-main");

  main.appendChild(createElement("span", "compare-rank", String(index + 1)));

  const nameCell = createElement("div", "compare-name");
  nameCell.appendChild(createElement("h4", "", park.name));
  if (index === 0) nameCell.appendChild(createElement("span", "compare-best", "Top pick"));
  nameCell.appendChild(createElement("span", "compare-activities", park.activities.map(capitalize).join(" · ")));
  main.appendChild(nameCell);

  // Score as a meter bar
  const scoreCell = createElement("div", "compare-score");
  scoreCell.setAttribute("aria-label", "Match score " + result.score + " out of 100");
  scoreCell.appendChild(createElement("strong", "", String(result.score)));
  const bar = createElement("span", "compare-bar");
  const fill = createElement("span", "compare-bar-fill");
  fill.style.width = Math.max(0, Math.min(result.score, 100)) + "%";
  bar.appendChild(fill);
  scoreCell.appendChild(bar);
  main.appendChild(scoreCell);

  // Trip / distance
  let tripText = "—";
  if (result.travelMinutes !== null && result.travelMinutes !== undefined) {
    tripText = "~" + result.travelMinutes + " min " + (prefs.transport === "walking" ? "walk" : "drive");
  } else if (result.distance !== null && prefs.originLabel) {
    tripText = "~" + result.distance.toFixed(1) + " mi";
  }
  const stats = createElement("div", "compare-stats");
  stats.appendChild(createCompareStat("Trip", tripText));
  stats.appendChild(createCompareStat("Time there", "~" + Math.max(result.minutesThere, 0) + " min"));
  stats.appendChild(createCompareStat("Visit", park.minVisitMinutes + "–" + park.typicalVisitMinutes + " min"));
  main.appendChild(stats);

  // Actions
  const actions = createElement("div", "compare-actions");
  const directionsLink = createElement("a", "btn btn-primary btn-small", "Directions");
  directionsLink.href = getDirectionsUrl(park, prefs);
  directionsLink.target = "_blank";
  directionsLink.rel = "noopener noreferrer";
  directionsLink.setAttribute("aria-label", "Get directions to " + park.name + " (opens Google Maps in a new tab)");
  actions.appendChild(directionsLink);

  const favoriteButton = createElement("button", "btn btn-secondary btn-small btn-icon");
  favoriteButton.type = "button";
  favoriteButton.dataset.parkId = park.id;
  favoriteButton.dataset.compact = "true";
  updateFavoriteButton(favoriteButton);
  favoriteButton.addEventListener("click", function () {
    toggleFavorite(park.id);
  });
  actions.appendChild(favoriteButton);
  main.appendChild(actions);

  row.appendChild(main);

  // Expandable details
  const details = createElement("details", "compare-details");
  details.appendChild(createElement("summary", "", "Details & why it matches"));
  const detailBody = createElement("div", "compare-details-body");
  const about = createElement("div", "");
  about.appendChild(createElement("p", "", park.description));
  about.appendChild(createElement("p", "address", park.address));
  if (park.verificationNotes) about.appendChild(createElement("p", "card-note", park.verificationNotes));
  if (typeof selectPlace === "function") {
    const mapButton = createElement("button", "btn btn-ghost btn-small", "Show on map");
    mapButton.type = "button";
    mapButton.addEventListener("click", function () {
      // Verified matches are the first items on the map, in the same order.
      const item = typeof mapState !== "undefined" ? mapState.items[index] : null;
      if (!item || item.id !== park.id) return;
      selectPlace(index, true);
      const mapSection = document.getElementById("map-section");
      if (mapSection) mapSection.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    about.appendChild(mapButton);
  }
  detailBody.appendChild(about);

  const why = createElement("div", "why");
  why.appendChild(createElement("h4", "", "Why this matches"));
  const reasons = createElement("ul");
  result.reasons.forEach(function (reason) {
    reasons.appendChild(createElement("li", reason.matched ? "is-match" : "miss", reason.text));
  });
  why.appendChild(reasons);
  detailBody.appendChild(why);

  details.appendChild(detailBody);
  row.appendChild(details);
  return row;
}

// One labeled number in a compare row. The label only shows on phones.
function createCompareStat(label, value) {
  const cell = createElement("div", "compare-stat");
  cell.appendChild(createElement("span", "compare-stat-label", label));
  cell.appendChild(createElement("span", "compare-stat-value", value));
  return cell;
}

// "~12 min walk each way → ~36 of your 60 min there"
function describeTimeBudget(prefs, travelMinutes) {
  const minutesThere = prefs.time - 2 * travelMinutes;
  const trip = "~" + travelMinutes + " min " + travelVerb(prefs) + " each way from " + prefs.originLabel;
  if (minutesThere <= 0) return trip + ". That's your whole " + prefs.time + " min, with no time left there.";
  return trip + " → ~" + minutesThere + " of your " + prefs.time + " min there.";
}

// Turn one scored verified park into a "map item" for map.js.
function buildLocalMapItem(result, prefs) {
  const park = result.park;
  const sections = [];

  if (result.travelMinutes !== null) {
    sections.push({ label: "Your time", text: describeTimeBudget(prefs, result.travelMinutes) });
  }
  if (result.distance !== null && prefs.originLabel) {
    sections.push({ label: "Distance", text: "~" + result.distance.toFixed(1) + " mi from " + prefs.originLabel + " (straight line)" });
  }
  sections.push({ label: "About", text: park.description });
  sections.push({ label: "Visit", text: park.minVisitMinutes + "–" + park.typicalVisitMinutes + " minutes" });
  sections.push({ label: "Activities", tags: park.activities.map(capitalize) });
  sections.push({ label: "Setting", tags: park.environments.map(capitalize) });
  if (park.amenities.length > 0) sections.push({ label: "Amenities", text: park.amenities.join(", ") });

  return {
    id: park.id,
    name: park.name,
    latitude: park.latitude,
    longitude: park.longitude,
    source: "local",
    badge: "Verified match",
    categoryLabel: "Park",
    address: park.address.startsWith("PLACEHOLDER") ? "" : park.address,
    score: result.score,
    reasons: result.reasons,
    sections: sections,
    note: park.verificationNotes || "",
    directionsUrl: getDirectionsUrl(park, prefs),
    favorite: null // toggleFavorite() builds it from parks.json
  };
}

// Show the verified matches (or a friendly empty state).
// The heading goes above the map, the cards go below it.
function renderResults(results, prefs) {
  const container = document.getElementById("results");
  const headerBox = document.getElementById("results-header");
  container.textContent = "";
  headerBox.textContent = "";

  // Update the shared map (places.js + map.js). Safe if those files are missing.
  if (typeof showNatureResults === "function") {
    showNatureResults(results.map(function (result) { return buildLocalMapItem(result, prefs); }), prefs);
  }

  if (results.length === 0) {
    const empty = createElement("div", "empty-state");
    empty.appendChild(createElement("h2", "", "No great matches this time"));
    empty.appendChild(createElement(
      "p", "",
      prefs.travelStatus === "ok"
        ? "Getting there and back takes too much of your " + prefs.time + " minutes, or nothing fits your choices. " +
          "Try more time, driving instead of walking, or \"No preference\" for the setting."
        : "Try choosing more time, a different activity, or \"No preference\" for the setting."
    ));
    empty.appendChild(createElement("p", "time-notice", describeTravelStatus(prefs)));
    container.appendChild(empty);
  } else {
    const header = createElement("div", "results-header");
    header.appendChild(createElement("h2", "", results.length + " verified match" + (results.length > 1 ? "es" : "")));
    header.appendChild(createElement(
      "p", "",
      prefs.time + " minutes of " + prefs.activity + ". Scores come from a rule-based checklist, not AI."
    ));
    header.appendChild(createElement("p", "time-notice", describeTravelStatus(prefs)));
    headerBox.appendChild(header);

    container.appendChild(createElement("h3", "list-heading", "Compare all " + results.length));
    container.appendChild(createCompareTable(results, prefs));
  }

  document.getElementById("results-area").scrollIntoView({ behavior: "smooth", block: "start" });
}

// One sentence explaining how the user's time was counted.
function describeTravelStatus(prefs) {
  const mode = prefs.transport === "walking" ? "walking" : "driving";
  if (prefs.travelStatus === "ok") {
    return "Your " + prefs.time + " minutes include the trip there and back, using real " + mode +
      " routes from " + prefs.originLabel + " (Geoapify). Traffic and stops can add time.";
  }
  if (prefs.zip && !prefs.origin) {
    return "We couldn't look up ZIP " + prefs.zip + ", so travel time isn't counted. Your " + prefs.time +
      " minutes are treated as time at the place.";
  }
  if (prefs.travelStatus === "failed") {
    return "We couldn't get travel times right now, so your " + prefs.time +
      " minutes are treated as time at the place. Distances are straight-line estimates.";
  }
  return "No starting point given, so your " + prefs.time + " minutes are treated as time at the place. " +
    "Add a ZIP code or use your location to subtract the trip there and back.";
}

// Clear the Nature results and their markers (used by reset and load errors).
function clearResultsArea() {
  document.getElementById("results").textContent = "";
  document.getElementById("results-header").textContent = "";
  if (typeof clearNatureResults === "function") clearNatureResults();
}

// Show a short message at the bottom of the screen.
let toastTimer = null;
function showToast(message) {
  const toast = document.getElementById("toast");
  toast.textContent = message;
  toast.classList.add("show");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(function () {
    toast.classList.remove("show");
  }, 2200);
}

// Show an error in place of the results (for example, if parks.json fails to load).
function showLoadError(message) {
  clearResultsArea();
  const container = document.getElementById("results");
  const box = createElement("div", "empty-state");
  box.appendChild(createElement("h2", "", "We couldn't load the park list"));
  box.appendChild(createElement("p", "", message));
  box.appendChild(createElement(
    "p", "",
    "Tip: open the site with VS Code Live Server. Opening index.html directly (file://) blocks loading parks.json."
  ));
  container.appendChild(box);
}


/* ---------- 5. Favorites (localStorage) ---------- */

/*
  Favorites are saved as a list of small objects, so places found on
  Geoapify can be shown again after a refresh:
  [{ id, name, latitude, longitude, address, category, source }]

  Older versions saved only parks.json IDs (["mcclellan-ranch", ...]).
  Those still work: we turn them into { id, source: "local" } when reading.
*/
function getFavorites() {
  try {
    const saved = localStorage.getItem(FAVORITES_KEY);
    const list = saved ? JSON.parse(saved) : [];
    if (!Array.isArray(list)) return [];

    const seen = new Set();
    const favorites = [];
    list.forEach(function (entry) {
      const favorite = typeof entry === "string" ? { id: entry, source: "local" } : entry;
      if (!favorite || typeof favorite.id !== "string" || seen.has(favorite.id)) return;
      seen.add(favorite.id); // no duplicates
      favorites.push(favorite);
    });
    return favorites;
  } catch (error) {
    console.warn("Could not read favorites:", error);
    return [];
  }
}

// Save the list. Returns true if it worked.
function saveFavorites(favorites) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(favorites));
    return true;
  } catch (error) {
    console.warn("Could not save favorites:", error);
    showToast("Sorry, favorites can't be saved in this browser.");
    return false;
  }
}

function isFavorite(placeId) {
  return getFavorites().some(function (favorite) { return favorite.id === placeId; });
}

// Info to save for a verified parks.json park.
function buildLocalFavorite(parkId) {
  const park = allParks.find(function (p) { return p.id === parkId; });
  if (!park) return null;
  return {
    id: park.id, name: park.name, latitude: park.latitude, longitude: park.longitude,
    address: park.address, category: "Park", source: "local"
  };
}

// Save or remove a place. "details" is needed for Geoapify places;
// verified parks are looked up in parks.json.
function toggleFavorite(placeId, details) {
  const favorites = getFavorites();
  const existing = favorites.find(function (favorite) { return favorite.id === placeId; });

  if (existing) {
    const name = existing.name || (buildLocalFavorite(placeId) || {}).name || "Place";
    const updated = favorites.filter(function (favorite) { return favorite.id !== placeId; });
    if (saveFavorites(updated)) showToast("Removed " + name + " from favorites");
  } else {
    const favorite = details || buildLocalFavorite(placeId);
    if (!favorite) {
      showToast("Sorry, this place can't be saved.");
      return;
    }
    if (saveFavorites(favorites.concat(favorite))) showToast("Saved " + favorite.name);
  }

  refreshFavoriteUI();
}

// Set a favorite button's text and style based on whether it's saved.
function updateFavoriteButton(button) {
  const saved = isFavorite(button.dataset.parkId);
  if (button.dataset.compact) {
    button.textContent = saved ? "★" : "☆";
    button.title = saved ? "Saved — click to remove" : "Save to Favorites";
    button.setAttribute("aria-label", saved ? "Remove from favorites" : "Save to favorites");
  } else {
    button.textContent = saved ? "★ Saved" : "☆ Save to Favorites";
  }
  button.classList.toggle("btn-saved", saved);
  button.setAttribute("aria-pressed", saved ? "true" : "false");
}

// Update everything that depends on favorites: badge count, buttons, favorites page.
function refreshFavoriteUI() {
  document.getElementById("favorites-count").textContent = String(getFavorites().length);
  document.querySelectorAll("button[data-park-id]").forEach(updateFavoriteButton);
  renderFavorites();
}

// Saved places we can actually show: verified parks (looked up in parks.json)
// and Geoapify places saved with their name and coordinates.
function getShowableFavorites() {
  const list = [];
  getFavorites().forEach(function (favorite) {
    const park = allParks.find(function (p) { return p.id === favorite.id; });
    if (park) {
      list.push({ id: park.id, name: park.name, latitude: park.latitude, longitude: park.longitude,
        address: park.address, category: "Park", park: park });
    } else if (favorite.name && Number.isFinite(favorite.latitude) && Number.isFinite(favorite.longitude)) {
      list.push(Object.assign({ park: null }, favorite));
    }
  });
  return list;
}

function renderFavorites() {
  const container = document.getElementById("favorites-list");
  container.textContent = "";

  // One row per saved place (same style as the Compare list).
  // Old saved IDs that no longer exist in parks.json are skipped.
  const favorites = getShowableFavorites();

  // The badge counts only favorites we can actually show.
  document.getElementById("favorites-count").textContent = String(favorites.length);
  updateSpinPanel(favorites);

  if (favorites.length === 0) {
    const empty = createElement("div", "empty-state");
    empty.appendChild(createElement("h3", "", "No saved escapes yet"));
    empty.appendChild(createElement("p", "", "Find a place you like and tap ☆ to save it."));
    const link = createElement("a", "btn btn-primary", "Find My Escape");
    link.href = "#finder";
    empty.appendChild(link);
    container.appendChild(empty);
    return;
  }

  const table = createElement("div", "compare compare-favorites");
  const head = createElement("div", "compare-head");
  head.setAttribute("aria-hidden", "true");
  ["", "Place", ""].forEach(function (label) {
    head.appendChild(createElement("span", "", label));
  });
  table.appendChild(head);

  const list = createElement("ul", "compare-list");
  favorites.forEach(function (favorite, index) {
    list.appendChild(createFavoriteRow(favorite, index));
  });
  table.appendChild(list);
  container.appendChild(table);
}

// One saved place. Verified parks (parks.json) can be opened for details;
// Geoapify places only have a name, category and address.
function createFavoriteRow(favorite, index) {
  const park = favorite.park;
  const row = createElement("li", "compare-row");
  row.style.animationDelay = Math.min(index * 50, 400) + "ms";

  const main = createElement("div", "compare-main");
  main.appendChild(createElement("span", "compare-rank", String(index + 1)));

  const nameCell = createElement("div", "compare-name");
  nameCell.appendChild(createElement("h4", "", favorite.name));
  const subline = park ? park.activities.map(capitalize).join(" · ") : (favorite.category || "Place");
  nameCell.appendChild(createElement("span", "compare-activities", subline));
  if (favorite.address && !favorite.address.startsWith("PLACEHOLDER")) {
    nameCell.appendChild(createElement("span", "compare-activities", favorite.address));
  }
  main.appendChild(nameCell);

  const actions = createElement("div", "compare-actions");
  const directionsLink = createElement("a", "btn btn-primary btn-small", "Directions");
  directionsLink.href = park
    ? getDirectionsUrl(park, null)
    : "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(favorite.latitude + "," + favorite.longitude);
  directionsLink.target = "_blank";
  directionsLink.rel = "noopener noreferrer";
  directionsLink.setAttribute("aria-label", "Get directions to " + favorite.name + " (opens Google Maps in a new tab)");
  actions.appendChild(directionsLink);

  const favoriteButton = createElement("button", "btn btn-secondary btn-small btn-icon");
  favoriteButton.type = "button";
  favoriteButton.dataset.parkId = favorite.id;
  favoriteButton.dataset.compact = "true";
  updateFavoriteButton(favoriteButton);
  favoriteButton.addEventListener("click", function () { toggleFavorite(favorite.id); });
  actions.appendChild(favoriteButton);
  main.appendChild(actions);
  row.appendChild(main);

  // Only verified parks have extra details to show.
  if (park) {
    const details = createElement("details", "compare-details");
    details.appendChild(createElement("summary", "", "Details"));
    const body = createElement("div", "compare-details-body compare-details-single");
    body.appendChild(createElement("p", "", park.description));
    if (park.amenities.length > 0) body.appendChild(createElement("p", "address", "Amenities: " + park.amenities.join(", ")));
    if (park.verificationNotes) body.appendChild(createElement("p", "card-note", park.verificationNotes));
    details.appendChild(body);
    row.appendChild(details);
  }
  return row;
}


/* ---------- 5b. Spin the wheel ---------- */

const WHEEL_COLORS = ["#214E34", "#A8C9A0", "#5E8F5A", "#E3EEDF", "#2A5A3C", "#F2C66D"];
const WHEEL_LIGHT_COLORS = ["#A8C9A0", "#E3EEDF", "#F2C66D"]; // these get dark text
const WHEEL_SPIN_MS = 4200;
const WHEEL_RADIUS = 100;

const wheelState = {
  entries: [],     // the saved places on the wheel
  rotation: 0,     // total degrees turned so far (keeps growing)
  spinning: false,
  needsRedraw: false
};

// A point on the circle. 0 degrees is the top, going clockwise.
function wheelPoint(degrees, radius) {
  const radians = degrees * Math.PI / 180;
  return (radius * Math.sin(radians)).toFixed(2) + "," + (-radius * Math.cos(radians)).toFixed(2);
}

function svgElement(tag, attributes) {
  const element = document.createElementNS("http://www.w3.org/2000/svg", tag);
  Object.keys(attributes).forEach(function (name) { element.setAttribute(name, attributes[name]); });
  return element;
}

function shortenLabel(text, maxLength) {
  return text.length > maxLength ? text.slice(0, maxLength - 1) + "…" : text;
}

// Draw one slice per saved place. Names are added with textContent (safe).
function drawWheel(entries) {
  const wheel = document.getElementById("spin-wheel");
  wheel.textContent = "";
  const count = entries.length;
  if (count === 0) return;

  const sliceAngle = 360 / count;
  const fontSize = count <= 4 ? 10 : count <= 8 ? 8.5 : count <= 14 ? 7 : 6;
  const maxChars = count <= 8 ? 16 : 13;

  entries.forEach(function (entry, index) {
    const color = WHEEL_COLORS[index % WHEEL_COLORS.length];
    // Avoid two neighbors with the same color when the count isn't a multiple of 6.
    const fill = (index === count - 1 && count > 1 && color === WHEEL_COLORS[0]) ? WHEEL_COLORS[2] : color;
    const start = index * sliceAngle;
    const end = start + sliceAngle;

    if (count === 1) {
      wheel.appendChild(svgElement("circle", { cx: 0, cy: 0, r: WHEEL_RADIUS, fill: fill }));
    } else {
      wheel.appendChild(svgElement("path", {
        d: "M0,0 L" + wheelPoint(start, WHEEL_RADIUS) +
           " A" + WHEEL_RADIUS + "," + WHEEL_RADIUS + " 0 " + (sliceAngle > 180 ? 1 : 0) + " 1 " +
           wheelPoint(end, WHEEL_RADIUS) + " Z",
        fill: fill,
        stroke: "#FFFFFF",
        "stroke-width": 1.5
      }));
    }

    // Label runs along the middle of the slice. On the left half we flip it
    // so it never reads upside down.
    const middle = start + sliceAngle / 2;
    const flip = count > 1 && middle > 180;
    const label = svgElement("text", {
      transform: "rotate(" + middle + ") translate(0,-58) rotate(" + (flip ? 90 : -90) + ")",
      "text-anchor": "middle",
      "dominant-baseline": "middle",
      "font-size": fontSize,
      "font-weight": 700,
      fill: WHEEL_LIGHT_COLORS.includes(fill) ? "#26352D" : "#FFFFFF"
    });
    label.textContent = shortenLabel(entry.name, maxChars);
    wheel.appendChild(label);
  });

  wheel.setAttribute("aria-label", "Wheel with " + count + " saved place" + (count === 1 ? "" : "s"));
}

// Show/hide the panel and redraw the wheel whenever favorites change.
function updateSpinPanel(favorites) {
  const panel = document.getElementById("spin-panel");
  panel.hidden = favorites.length === 0;
  if (wheelState.spinning) {
    wheelState.needsRedraw = true; // wait until the current spin ends
    return;
  }
  wheelState.entries = favorites;
  drawWheel(favorites);

  const button = document.getElementById("spin-button");
  const hint = document.getElementById("spin-hint");
  button.disabled = favorites.length < 2;
  hint.textContent = favorites.length < 2 ? "Save at least 2 places to spin." : "";

  // If the last pick was removed from favorites, hide it.
  const result = document.getElementById("spin-result");
  if (!result.hidden && !favorites.some(function (f) { return f.id === result.dataset.placeId; })) {
    result.hidden = true;
  }
}

// A fair random whole number from 0 to max - 1.
function randomIndex(max) {
  if (window.crypto && window.crypto.getRandomValues) {
    const value = new Uint32Array(1);
    window.crypto.getRandomValues(value);
    return value[0] % max;
  }
  return Math.floor(Math.random() * max);
}

function spinWheel() {
  const entries = wheelState.entries;
  if (wheelState.spinning || entries.length < 2) return;

  // 1. Pick the winner first, fairly.
  const winnerIndex = randomIndex(entries.length);

  // 2. Work out how far to turn so the winner's slice stops under the pointer (top).
  const sliceAngle = 360 / entries.length;
  const sliceCenter = (winnerIndex + 0.5) * sliceAngle;
  const wobble = (Math.random() - 0.5) * sliceAngle * 0.6; // don't always stop dead center
  const current = ((wheelState.rotation % 360) + 360) % 360;
  const extra = ((360 - sliceCenter + wobble - current) % 360 + 360) % 360;
  wheelState.rotation += 5 * 360 + extra; // 5 full turns, then land

  // 3. Animate (or jump, for people who prefer reduced motion).
  const wheel = document.getElementById("spin-wheel");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  wheelState.spinning = true;
  document.getElementById("spin-button").disabled = true;
  document.getElementById("spin-result").hidden = true;
  wheel.style.transition = reduceMotion ? "none" : "transform " + WHEEL_SPIN_MS + "ms cubic-bezier(0.17, 0.67, 0.15, 1)";
  wheel.style.transform = "rotate(" + wheelState.rotation + "deg)";

  setTimeout(function () {
    finishSpin(entries[winnerIndex]);
  }, reduceMotion ? 0 : WHEEL_SPIN_MS + 100);
}

function finishSpin(winner) {
  wheelState.spinning = false;
  showSpinResult(winner);
  if (wheelState.needsRedraw) {
    wheelState.needsRedraw = false;
    updateSpinPanel(getShowableFavorites());
  } else {
    document.getElementById("spin-button").disabled = wheelState.entries.length < 2;
  }
}

function showSpinResult(place) {
  const result = document.getElementById("spin-result");
  result.textContent = "";
  result.dataset.placeId = place.id;

  result.appendChild(createElement("p", "spin-result-label", "Your escape:"));
  result.appendChild(createElement("h3", "", place.name));
  const details = [place.category, place.address].filter(Boolean).join(" · ");
  if (details) result.appendChild(createElement("p", "address", details));

  const directions = createElement("a", "btn btn-primary", "Get Directions");
  directions.href = place.park
    ? getDirectionsUrl(place.park, null)
    : "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(place.latitude + "," + place.longitude);
  directions.target = "_blank";
  directions.rel = "noopener noreferrer";
  directions.setAttribute("aria-label", "Get directions to " + place.name + " (opens Google Maps in a new tab)");
  result.appendChild(directions);

  result.hidden = false;
}


/* ---------- 6. Navigation ---------- */

const VIEWS = ["home", "finder", "favorites"];

// Show one view and hide the others, based on the URL hash (#home, #finder, #favorites).
function showView(viewName) {
  if (!VIEWS.includes(viewName)) viewName = "home";

  VIEWS.forEach(function (name) {
    document.getElementById("view-" + name).hidden = name !== viewName;
  });

  document.querySelectorAll(".nav-link").forEach(function (link) {
    const isActive = link.dataset.view === viewName;
    link.classList.toggle("active", isActive);
    if (isActive) {
      link.setAttribute("aria-current", "page");
    } else {
      link.removeAttribute("aria-current");
    }
  });

  if (viewName === "favorites") renderFavorites();
  // The map can't measure itself while hidden, so resize it when the Find page reappears.
  if (viewName === "finder" && typeof onFinderShown === "function") onFinderShown();
  window.scrollTo(0, 0);
}

function handleHashChange() {
  showView(window.location.hash.replace("#", ""));
}


/* ---------- 7. Form handling ---------- */

const QUESTIONS = [
  { name: "time", message: "Please choose how much time you have." },
  { name: "activity", message: "Please choose an activity." },
  { name: "transport", message: "Please choose walking or driving." },
  { name: "environment", message: "Please choose a setting (or \"No preference\")." }
];

// Read the form. Returns { prefs, missing } where missing is a list of unanswered questions.
function readPreferences(form) {
  const prefs = {};
  const missing = [];

  QUESTIONS.forEach(function (question) {
    const selected = form.querySelector('input[name="' + question.name + '"]:checked');
    if (selected) {
      prefs[question.name] = selected.value;
    } else {
      missing.push(question);
    }
  });

  if (prefs.time) prefs.time = Number(prefs.time);

  // Starting point is optional: "Use my location" OR a 5-digit ZIP code.
  prefs.useLocation = natureLocation !== null;
  const zip = form.querySelector("#zip-input").value.trim();
  if (prefs.useLocation || zip === "") {
    prefs.zip = null;
  } else if (isValidZip(zip)) {
    prefs.zip = zip;
  } else {
    missing.push({ name: "zip", message: "ZIP codes have exactly 5 digits, like 95014. Or leave it blank." });
  }

  return { prefs: prefs, missing: missing };
}

function clearErrors() {
  QUESTIONS.concat({ name: "zip" }).forEach(function (question) {
    document.getElementById("error-" + question.name).textContent = "";
    document.getElementById("question-" + question.name).classList.remove("has-error");
  });
  document.getElementById("form-summary-error").textContent = "";
}

async function handleFormSubmit(event) {
  event.preventDefault(); // stay on the page, no refresh
  clearErrors();

  const form = event.target;
  const { prefs, missing } = readPreferences(form);

  if (missing.length > 0) {
    missing.forEach(function (question) {
      document.getElementById("error-" + question.name).textContent = question.message;
      document.getElementById("question-" + question.name).classList.add("has-error");
    });
    document.getElementById("form-summary-error").textContent =
      "Almost there! Please check " + missing.length + " question" + (missing.length > 1 ? "s" : "") + " above.";
    // Move keyboard focus to the first unanswered question
    const firstMissing = form.querySelector('input[name="' + missing[0].name + '"]');
    if (firstMissing) firstMissing.focus();
    return;
  }

  if (allParks.length === 0) {
    showLoadError("The park list is empty or still loading. Please refresh the page.");
    return;
  }

  const submitButton = form.querySelector('button[type="submit"]');
  submitButton.disabled = true;
  submitButton.textContent = "Finding…";

  // 1. Where is the user starting from?
  prefs.origin = null;
  prefs.originLabel = null;
  prefs.directionsOrigin = null;
  if (prefs.useLocation) {
    prefs.origin = natureLocation;
    prefs.originLabel = "your location";
  } else if (prefs.zip) {
    prefs.origin = await lookupZip(prefs.zip);
    prefs.originLabel = prefs.zip;
    prefs.directionsOrigin = prefs.zip;
  }

  // 2. Real travel times to the verified parks (one Geoapify request).
  prefs.travelMinutes = null;
  prefs.travelStatus = "none";
  if (prefs.origin && typeof fetchTravelMinutes === "function" && !isApiKeyMissing()) {
    submitButton.textContent = "Checking travel times…";
    try {
      const minutes = await fetchTravelMinutes(prefs.origin, allParks, prefs.transport);
      prefs.travelMinutes = {};
      allParks.forEach(function (park, index) { prefs.travelMinutes[park.id] = minutes[index]; });
      prefs.travelStatus = "ok";
    } catch (error) {
      console.warn("Travel times unavailable:", error);
      prefs.travelStatus = "failed";
    }
  }

  submitButton.disabled = false;
  submitButton.textContent = "Find My Escape";

  // 3. Score and show.
  const results = getRecommendations(allParks, prefs);
  renderResults(results, prefs);
}


/* ---------- 7b. "Use my location" for Nature picks ---------- */

// Approximate location from the browser (rounded), or null. Never saved.
let natureLocation = null;

function setNatureLocationStatus(text, isError, showClear) {
  const status = document.getElementById("nature-location-status");
  status.textContent = "";
  status.classList.toggle("is-error", Boolean(isError));
  if (!text) return;
  status.appendChild(document.createTextNode(text + " "));
  if (showClear) {
    const clear = createElement("button", "link-button", "Clear");
    clear.type = "button";
    clear.addEventListener("click", clearNatureLocation);
    status.appendChild(clear);
  }
}

function clearNatureLocation() {
  natureLocation = null;
  document.getElementById("nature-use-location").classList.remove("btn-saved");
  setNatureLocationStatus("");
  if (typeof clearUserLocation === "function") clearUserLocation();
}

// Only asks for permission after the click. Rounded to ~100 m.
function handleNatureUseLocation() {
  if (!("geolocation" in navigator) || !window.isSecureContext) {
    setNatureLocationStatus("Your browser can't share location here (it needs https:// or localhost). Type a ZIP code instead.", true);
    return;
  }
  setNatureLocationStatus("Asking your browser for your location…");
  navigator.geolocation.getCurrentPosition(
    function (position) {
      natureLocation = {
        latitude: Math.round(position.coords.latitude * 1000) / 1000,
        longitude: Math.round(position.coords.longitude * 1000) / 1000
      };
      document.getElementById("zip-input").value = ""; // location replaces the ZIP
      document.getElementById("error-zip").textContent = "";
      document.getElementById("question-zip").classList.remove("has-error");
      document.getElementById("nature-use-location").classList.add("btn-saved");
      if (typeof setUserLocation === "function") setUserLocation(natureLocation.latitude, natureLocation.longitude);
      setNatureLocationStatus("Using your approximate location.", false, true);
    },
    function (error) {
      natureLocation = null;
      const messages = {
        1: "Location permission was denied. You can type a ZIP code instead.",
        2: "Your location isn't available right now. Try a ZIP code.",
        3: "Getting your location took too long. Try again or type a ZIP code."
      };
      setNatureLocationStatus(messages[error.code] || messages[2], true);
    },
    { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 }
  );
}

// When a user picks an answer, remove that question's error message.
function handleFormChange(event) {
  const name = event.target.name;
  if (!name) return;
  // Typing a ZIP switches back from "Use my location".
  if (name === "zip" && event.target.value.trim() !== "" && natureLocation) clearNatureLocation();
  const errorBox = document.getElementById("error-" + name);
  if (errorBox) errorBox.textContent = "";
  const fieldset = document.getElementById("question-" + name);
  if (fieldset) fieldset.classList.remove("has-error");
}

function handleFormReset() {
  clearErrors();
  clearResultsArea();
  clearNatureLocation();
}


/* ---------- Start the app ---------- */

async function init() {
  const form = document.getElementById("preference-form");
  form.addEventListener("submit", handleFormSubmit);
  form.addEventListener("change", handleFormChange);
  form.addEventListener("input", handleFormChange); // clears the ZIP error while typing
  form.addEventListener("reset", handleFormReset);
  document.getElementById("nature-use-location").addEventListener("click", handleNatureUseLocation);
  document.getElementById("spin-button").addEventListener("click", spinWheel);

  if (typeof initPlaces === "function") initPlaces(); // Explore controls (places.js)

  window.addEventListener("hashchange", handleHashChange);
  handleHashChange();

  document.getElementById("favorites-count").textContent = String(getFavorites().length);

  try {
    allParks = await loadParks();
    renderFavorites();
  } catch (error) {
    console.error(error);
    showLoadError(error.message);
  }
}

// Run in the browser. (The check lets the scoring functions be tested in Node too.)
if (typeof document !== "undefined") {
  document.addEventListener("DOMContentLoaded", init);
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = { scorePark, getRecommendations, isValidPark, getDirectionsUrl, isValidZip, distanceInMiles };
}
