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

// How many recommendations to show.
const TOP_COUNT = 3;

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
  { time: 30, activity: "relaxing", transport: "walking", environment: "quiet" }
*/
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
  // "time" means time AT the destination, not including travel.
  if (park.minVisitMinutes <= prefs.time) {
    score += POINTS.duration;
    reasons.push({ text: "Enjoyable in " + prefs.time + " minutes or less", matched: true });
  } else if (park.minVisitMinutes <= prefs.time * 2) {
    score += POINTS.duration / 2;
    reasons.push({ text: "A bit short on time: best with " + park.minVisitMinutes + "+ minutes", matched: false });
  } else {
    reasons.push({ text: "Needs at least " + park.minVisitMinutes + " minutes", matched: false });
  }

  // Factor 4 — Transportation (10 points)
  // We do NOT calculate travel time. This is a simple rule:
  // city parks are easier to reach on foot, and parks with parking suit drivers.
  if (prefs.transport === "walking") {
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

  return { park: park, score: score, reasons: reasons };
}

// Score every park, sort highest first, and keep the top matches.
function getRecommendations(parks, prefs) {
  const scored = parks.map(function (park) {
    return scorePark(park, prefs);
  });

  scored.sort(function (a, b) {
    // Higher score first. If tied, shorter minimum visit first.
    if (b.score !== a.score) return b.score - a.score;
    return a.park.minVisitMinutes - b.park.minVisitMinutes;
  });

  return scored
    .filter(function (result) { return result.score >= MATCH_THRESHOLD; })
    .slice(0, TOP_COUNT);
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
function getDirectionsUrl(park) {
  // If the address is not verified, use exact coordinates instead.
  const destination = park.address.startsWith("PLACEHOLDER")
    ? park.latitude + "," + park.longitude
    : park.name + ", " + park.address;
  return "https://www.google.com/maps/dir/?api=1&destination=" + encodeURIComponent(destination);
}

// Builds one park card. "result" has a score and reasons (from scorePark).
// For the favorites page, result is null and no score is shown.
function createParkCard(park, result, rankNumber) {
  const card = createElement("article", "park-card");

  // Top colored section: rank, name, score
  const top = createElement("div", "card-top");
  if (rankNumber) {
    top.appendChild(createElement("span", "rank", "Match #" + rankNumber));
  } else {
    top.appendChild(createElement("span", "rank", "Saved"));
  }
  top.appendChild(createElement("h3", "", park.name));

  if (result) {
    const scoreBadge = createElement("div", "score");
    scoreBadge.setAttribute("aria-label", "Match score " + result.score + " out of 100");
    scoreBadge.appendChild(document.createTextNode(String(result.score)));
    scoreBadge.appendChild(createElement("small", "", "/ 100"));
    top.appendChild(scoreBadge);
  }
  card.appendChild(top);

  // Body: description, tags, reasons
  const body = createElement("div", "card-body");
  body.appendChild(createElement("p", "", park.description));
  body.appendChild(createElement("p", "address", "📍 " + park.address));

  const meta = createElement("div", "meta");
  meta.appendChild(createElement(
    "span", "tag tag-time",
    "⏱️ " + park.minVisitMinutes + "–" + park.typicalVisitMinutes + " min visit"
  ));
  park.activities.forEach(function (activity) {
    meta.appendChild(createElement("span", "tag", capitalize(activity)));
  });
  body.appendChild(meta);

  if (result) {
    const why = createElement("div", "why");
    why.appendChild(createElement("h4", "", "Why this matches"));
    const list = createElement("ul");
    result.reasons.forEach(function (reason) {
      const icon = reason.matched ? "✅ " : "➖ ";
      list.appendChild(createElement("li", reason.matched ? "" : "miss", icon + reason.text));
    });
    why.appendChild(list);
    body.appendChild(why);
  }

  if (park.verificationNotes) {
    body.appendChild(createElement("p", "card-note", "ℹ️ " + park.verificationNotes));
  }
  card.appendChild(body);

  // Buttons
  const actions = createElement("div", "card-actions");

  const directionsLink = createElement("a", "btn btn-primary", "Get Directions");
  directionsLink.href = getDirectionsUrl(park);
  directionsLink.target = "_blank";
  directionsLink.rel = "noopener noreferrer";
  directionsLink.setAttribute("aria-label", "Get directions to " + park.name + " (opens Google Maps in a new tab)");
  actions.appendChild(directionsLink);

  const favoriteButton = createElement("button", "btn btn-secondary");
  favoriteButton.type = "button";
  favoriteButton.dataset.parkId = park.id;
  updateFavoriteButton(favoriteButton);
  favoriteButton.addEventListener("click", function () {
    toggleFavorite(park.id);
  });
  actions.appendChild(favoriteButton);

  card.appendChild(actions);
  return card;
}

// Show the top 3 results (or a friendly empty state).
function renderResults(results, prefs) {
  const container = document.getElementById("results");
  container.textContent = "";

  if (results.length === 0) {
    const empty = createElement("div", "empty-state");
    empty.appendChild(createElement("span", "emoji", "🍂"));
    empty.appendChild(createElement("h2", "", "No great matches this time"));
    empty.appendChild(createElement(
      "p", "",
      "Try choosing more time, a different activity, or \"No preference\" for the setting."
    ));
    container.appendChild(empty);
  } else {
    const header = createElement("div", "results-header");
    header.appendChild(createElement("h2", "", "Your top " + results.length + " escape" + (results.length > 1 ? "s" : "")));
    header.appendChild(createElement(
      "p", "",
      "For " + prefs.time + " minutes of " + prefs.activity + ". Scores come from a rule-based checklist, not AI."
    ));
    container.appendChild(header);

    const grid = createElement("div", "card-grid");
    results.forEach(function (result, index) {
      grid.appendChild(createParkCard(result.park, result, index + 1));
    });
    container.appendChild(grid);
  }

  container.scrollIntoView({ behavior: "smooth", block: "start" });
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
  const container = document.getElementById("results");
  container.textContent = "";
  const box = createElement("div", "empty-state");
  box.appendChild(createElement("span", "emoji", "⚠️"));
  box.appendChild(createElement("h2", "", "We couldn't load the park list"));
  box.appendChild(createElement("p", "", message));
  box.appendChild(createElement(
    "p", "",
    "Tip: open the site with VS Code Live Server. Opening index.html directly (file://) blocks loading parks.json."
  ));
  container.appendChild(box);
}


/* ---------- 5. Favorites (localStorage) ---------- */

// Read the saved list of park IDs. Returns [] if anything goes wrong.
function getFavorites() {
  try {
    const saved = localStorage.getItem(FAVORITES_KEY);
    const ids = saved ? JSON.parse(saved) : [];
    return Array.isArray(ids) ? ids.filter(function (id) { return typeof id === "string"; }) : [];
  } catch (error) {
    console.warn("Could not read favorites:", error);
    return [];
  }
}

// Save the list. Returns true if it worked.
function saveFavorites(ids) {
  try {
    localStorage.setItem(FAVORITES_KEY, JSON.stringify(ids));
    return true;
  } catch (error) {
    console.warn("Could not save favorites:", error);
    showToast("Sorry, favorites can't be saved in this browser.");
    return false;
  }
}

function isFavorite(parkId) {
  return getFavorites().includes(parkId);
}

function toggleFavorite(parkId) {
  const favorites = getFavorites();
  const park = allParks.find(function (p) { return p.id === parkId; });
  const name = park ? park.name : "Park";
  let updated;

  if (favorites.includes(parkId)) {
    updated = favorites.filter(function (id) { return id !== parkId; });
    if (saveFavorites(updated)) showToast("Removed " + name + " from favorites");
  } else {
    updated = favorites.concat(parkId);
    if (saveFavorites(updated)) showToast("Saved " + name + " ⭐");
  }

  refreshFavoriteUI();
}

// Set a favorite button's text and style based on whether it's saved.
function updateFavoriteButton(button) {
  const saved = isFavorite(button.dataset.parkId);
  button.textContent = saved ? "★ Saved" : "☆ Save to Favorites";
  button.classList.toggle("btn-saved", saved);
  button.setAttribute("aria-pressed", saved ? "true" : "false");
}

// Update everything that depends on favorites: badge count, buttons, favorites page.
function refreshFavoriteUI() {
  document.getElementById("favorites-count").textContent = String(getFavorites().length);
  document.querySelectorAll("button[data-park-id]").forEach(updateFavoriteButton);
  renderFavorites();
}

function renderFavorites() {
  const container = document.getElementById("favorites-list");
  container.textContent = "";

  // Only show favorites that still exist in parks.json
  const favoriteParks = getFavorites()
    .map(function (id) { return allParks.find(function (p) { return p.id === id; }); })
    .filter(Boolean);

  if (favoriteParks.length === 0) {
    const empty = createElement("div", "empty-state");
    empty.appendChild(createElement("span", "emoji", "🌱"));
    empty.appendChild(createElement("h3", "", "No saved escapes yet"));
    empty.appendChild(createElement("p", "", "Find a place you like and tap \"Save to Favorites\"."));
    const link = createElement("a", "btn btn-primary", "Find My Escape");
    link.href = "#finder";
    empty.appendChild(link);
    container.appendChild(empty);
    return;
  }

  favoriteParks.forEach(function (park) {
    container.appendChild(createParkCard(park, null, null));
  });
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
  return { prefs: prefs, missing: missing };
}

function clearErrors() {
  QUESTIONS.forEach(function (question) {
    document.getElementById("error-" + question.name).textContent = "";
    document.getElementById("question-" + question.name).classList.remove("has-error");
  });
  document.getElementById("form-summary-error").textContent = "";
}

function handleFormSubmit(event) {
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
      "Almost there! " + missing.length + " question" + (missing.length > 1 ? "s need" : " needs") + " an answer.";
    // Move keyboard focus to the first unanswered question
    const firstMissing = form.querySelector('input[name="' + missing[0].name + '"]');
    if (firstMissing) firstMissing.focus();
    return;
  }

  if (allParks.length === 0) {
    showLoadError("The park list is empty or still loading. Please refresh the page.");
    return;
  }

  const results = getRecommendations(allParks, prefs);
  renderResults(results, prefs);
}

// When a user picks an answer, remove that question's error message.
function handleFormChange(event) {
  const name = event.target.name;
  if (!name) return;
  const errorBox = document.getElementById("error-" + name);
  if (errorBox) errorBox.textContent = "";
  const fieldset = document.getElementById("question-" + name);
  if (fieldset) fieldset.classList.remove("has-error");
}

function handleFormReset() {
  clearErrors();
  document.getElementById("results").textContent = "";
}


/* ---------- Start the app ---------- */

async function init() {
  const form = document.getElementById("preference-form");
  form.addEventListener("submit", handleFormSubmit);
  form.addEventListener("change", handleFormChange);
  form.addEventListener("reset", handleFormReset);

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
  module.exports = { scorePark, getRecommendations, isValidPark, getDirectionsUrl };
}
