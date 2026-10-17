/* =========================================================
   GreenEscape — map.js
   The interactive map: Leaflet.js + Geoapify map tiles.

   The map doesn't care WHERE places come from. Other files give it
   a list of "map items" (see the shape below) and it:
   - draws one marker per item,
   - fills ONE reusable info card with the selected item,
   - moves between items with the ‹ › arrows on the map edges,
   - centers the selected item in the part of the map the card doesn't cover.

   Map item shape (built in script.js and places.js):
   {
     id, name, latitude, longitude, icon,
     source: "local" | "geoapify",
     badge: "Verified match" | "Discovered · not scored" | ...,
     categoryLabel, address,
     score: number or null,        // only verified local parks have a score
     reasons: [{ text, matched }],  // only with a score
     sections: [{ label, text } | { label, tags: [] } | { label, linkText, href }],
     note, directionsUrl,
     favorite: { id, name, latitude, longitude, address, category, source }
   }

   Sections:
   1. Settings (put your Geoapify key here)
   2. Map state
   3. Small helpers
   4. Creating the map and tiles
   5. Markers
   6. Moving the map (centering in the visible area)
   7. The info card
   8. Selecting places (click, previous, next)
   9. Functions used by script.js and places.js
   ========================================================= */


/* ---------- 1. Settings ---------- */

// Paste your Geoapify API key between the quotes.
// Create one free at https://myprojects.geoapify.com
// This key is used by the map tiles AND by places.js for place search.
// It is NOT secret: anyone can see it in the browser. Restrict it to your
// website's address in the Geoapify dashboard (see README).
const GEOAPIFY_API_KEY = "b53d6df2730548579ead381336cc6e5d";

// Map style. Other options include "osm-carto", "positron", "klokantech-basic".
const GEOAPIFY_MAP_STYLE = "osm-bright";

// Starting view: between Cupertino and San Jose. This is NOT the user's location.
const DEFAULT_MAP_CENTER = [37.3229, -121.98];
const DEFAULT_MAP_ZOOM = 12;

// When a place is selected, keep the zoom between these levels.
const FOCUS_MIN_ZOOM = 14;
const FOCUS_MAX_ZOOM = 17;

// Screens narrower than this use the mobile "bottom sheet" card.
const MOBILE_BREAKPOINT = 640;

// How long the card "shrink" takes before new content appears (milliseconds).
const CARD_SWITCH_MS = 160;


/* ---------- 2. Map state ---------- */

const mapState = {
  map: null,              // the Leaflet map (created once, then reused)
  markerLayer: null,      // group holding all markers
  markers: [],            // markers[i] belongs to items[i]
  items: [],              // the places currently on the map
  selectedIndex: -1,      // which item is in the card (-1 = none)
  tilesLoaded: false,
  tileErrors: 0,
  tileProblem: false,     // true if the key is missing or tiles fail
  controlsReady: false,   // true once button listeners are attached
  programmaticMove: false,// true while OUR code is moving the map
  moveTimer: null,
  onUserMove: null,       // places.js sets this to show "Search this area"
  userLocation: null,     // { lat, lon } after "Use my location" (rounded, never saved)
  userMarker: null,       // the blue "you are here" dot
  recenterTimer: null
};


/* ---------- 3. Small helpers ---------- */

function isLeafletLoaded() {
  return typeof L !== "undefined";
}

function isApiKeyMissing() {
  return !GEOAPIFY_API_KEY || GEOAPIFY_API_KEY === "YOUR_GEOAPIFY_API_KEY";
}

function isMobileLayout() {
  return window.innerWidth < MOBILE_BREAKPOINT;
}

function prefersReducedMotion() {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function hasValidCoordinates(item) {
  return (
    Number.isFinite(item.latitude) && Number.isFinite(item.longitude) &&
    Math.abs(item.latitude) <= 90 && Math.abs(item.longitude) <= 180
  );
}

// Show a message on top of the map (errors, "no results", etc.).
function showMapMessage(text) {
  const box = document.getElementById("map-message");
  box.textContent = text;
  box.hidden = false;
}

function hideMapMessage() {
  document.getElementById("map-message").hidden = true;
}

function getSelectedItem() {
  return mapState.items[mapState.selectedIndex] || null;
}


/* ---------- 4. Creating the map and tiles ---------- */

// Create the Leaflet map once. Returns true if the map is ready.
function createMapIfNeeded() {
  if (mapState.map) return true;

  if (!isLeafletLoaded()) {
    mapState.tileProblem = true;
    showMapMessage("The map library couldn't load (check your internet). Place details still appear in the card.");
    return false;
  }

  mapState.map = L.map("park-map", {
    center: DEFAULT_MAP_CENTER,
    zoom: DEFAULT_MAP_ZOOM,
    zoomControl: false
  });
  L.control.zoom({ position: "topright" }).addTo(mapState.map);
  mapState.markerLayer = L.layerGroup().addTo(mapState.map);
  // The "you are here" dot gets its own layer ABOVE the place pins (markerPane
  // is 600), so crowded pins never hide it when zoomed out.
  mapState.map.createPane("userPane").style.zIndex = 650;
  drawUserLocation(); // location may have been shared before the map existed

  watchForUserMoves();
  addGeoapifyTiles();
  return true;
}

function addGeoapifyTiles() {
  if (isApiKeyMissing()) {
    mapState.tileProblem = true;
    showMapMessage("Add your Geoapify API key at the top of map.js to see the map and search places.");
    return;
  }

  const tileUrl =
    "https://maps.geoapify.com/v1/tile/" + GEOAPIFY_MAP_STYLE + "/{z}/{x}/{y}" +
    (L.Browser.retina ? "@2x" : "") + ".png?apiKey=" + encodeURIComponent(GEOAPIFY_API_KEY);

  const tiles = L.tileLayer(tileUrl, {
    maxZoom: 20,
    attribution:
      'Powered by <a href="https://www.geoapify.com/" target="_blank" rel="noopener">Geoapify</a> | ' +
      '© <a href="https://openmaptiles.org/" target="_blank" rel="noopener">OpenMapTiles</a> ' +
      '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> contributors'
  });

  tiles.on("tileload", function () {
    if (!mapState.tilesLoaded) {
      mapState.tilesLoaded = true;
      mapState.tileProblem = false;
      hideMapMessage();
    }
  });

  // A wrong key or no internet makes every tile fail.
  tiles.on("tileerror", function () {
    mapState.tileErrors += 1;
    if (!mapState.tilesLoaded && mapState.tileErrors >= 3) {
      mapState.tileProblem = true;
      showMapMessage("Map tiles couldn't load. Check the Geoapify API key in map.js or your internet.");
    }
  });

  tiles.addTo(mapState.map);
}

// Tell places.js when the USER (not our code) drags or zooms the map.
// That's when the "Search this area" button should appear.
function watchForUserMoves() {
  const map = mapState.map;

  map.on("dragstart", function () {
    if (mapState.onUserMove) mapState.onUserMove();
  });

  map.on("zoomstart", function () {
    if (!mapState.programmaticMove && mapState.onUserMove) mapState.onUserMove();
  });

  map.on("moveend", function () {
    mapState.programmaticMove = false;
  });
}

// Run a map movement and remember that it came from our code.
function moveMapProgrammatically(moveFunction) {
  mapState.programmaticMove = true;
  clearTimeout(mapState.moveTimer);
  // Safety net: if the map didn't actually move, "moveend" never fires.
  mapState.moveTimer = setTimeout(function () { mapState.programmaticMove = false; }, 1200);
  moveFunction();
}


/* ---------- 5. Markers ---------- */

// Pin with a rank number for verified matches, or a plain dot for other places.
function createMarkerIcon(item, index, isSelected) {
  const pin = document.createElement("div");
  pin.className = "park-marker";
  if (item.source === "local") pin.classList.add("is-verified");
  if (item.source === "local" && index === 0) pin.classList.add("is-best");
  if (isSelected) pin.classList.add("is-selected");

  if (item.source === "local") {
    pin.appendChild(createElement("span", "park-marker-label", index === 0 ? "★" : String(index + 1)));
  } else {
    pin.appendChild(createElement("span", "park-marker-dot"));
  }

  return L.divIcon({
    className: "park-marker-wrap",
    html: pin,
    iconSize: [40, 48],
    iconAnchor: [20, 46]
  });
}

function createMarker(item, index) {
  const marker = L.marker([item.latitude, item.longitude], {
    icon: createMarkerIcon(item, index, false),
    title: item.name,
    alt: item.name,
    keyboard: true,
    riseOnHover: true
  });
  marker.on("click", function () {
    selectPlace(index, true);
  });
  marker.addTo(mapState.markerLayer);
  return marker;
}

// Only redraw the two markers that changed (fast even with 500 places).
function updateMarkerHighlight(previousIndex, newIndex) {
  [previousIndex, newIndex].forEach(function (index) {
    const marker = mapState.markers[index];
    if (!marker) return;
    const isSelected = index === newIndex;
    marker.setIcon(createMarkerIcon(mapState.items[index], index, isSelected));
    marker.setZIndexOffset(isSelected ? 1000 : 0);
  });
}

function fitMapToMarkers() {
  if (!mapState.map) return;
  const points = mapState.markers.map(function (marker) { return marker.getLatLng(); });
  if (points.length === 0) return;
  if (mapState.userMarker) points.push(mapState.userMarker.getLatLng()); // keep "you" in view

  moveMapProgrammatically(function () {
    mapState.map.fitBounds(L.latLngBounds(points), getFitPadding());
  });
}

// Space around the edges so markers aren't hidden behind the card or arrows.
function getFitPadding() {
  const card = document.getElementById("map-card");
  if (card.hidden) return { padding: [60, 60], maxZoom: 15 };
  if (isMobileLayout()) {
    return { paddingTopLeft: [50, 40], paddingBottomRight: [50, card.offsetHeight + 30], maxZoom: 15 };
  }
  return { paddingTopLeft: [card.offsetLeft + card.offsetWidth + 30, 50], paddingBottomRight: [80, 50], maxZoom: 15 };
}


/* ---------- 6. Moving the map ---------- */

/*
  How far (in screen pixels) the visible center is from the map's real center.
  Desktop: the card covers the left side, so the visible area is to its right.
  Mobile: the bottom sheet covers the bottom, so the visible area is above it.
*/
function getVisibleCenterOffset() {
  const card = document.getElementById("map-card");
  const wrap = document.querySelector(".map-wrap");
  if (card.hidden) return L.point(0, 0);

  if (isMobileLayout()) {
    const coveredHeight = wrap.clientHeight - card.offsetTop;
    return L.point(0, -coveredHeight / 2);
  }
  const coveredWidth = card.offsetLeft + card.offsetWidth;
  return L.point(coveredWidth / 2, 0);
}

// Smoothly move the map so the selected place sits in the middle of the visible area.
function centerOnSelectedPlace(animate) {
  const item = getSelectedItem();
  if (!mapState.map || !item || !hasValidCoordinates(item)) return;

  const map = mapState.map;
  const zoom = Math.min(Math.max(map.getZoom(), FOCUS_MIN_ZOOM), FOCUS_MAX_ZOOM);

  // Convert the place to pixels, shift by the card offset, convert back.
  const placePoint = map.project([item.latitude, item.longitude], zoom);
  const centerPoint = placePoint.subtract(getVisibleCenterOffset());
  const newCenter = map.unproject(centerPoint, zoom);

  const shouldAnimate = animate && !prefersReducedMotion();
  moveMapProgrammatically(function () {
    map.setView(newCenter, zoom, { animate: shouldAnimate, pan: { duration: 0.6 } });
  });
}

// After a resize or the bottom sheet opening/closing, re-center (debounced).
function scheduleRecenter() {
  clearTimeout(mapState.recenterTimer);
  mapState.recenterTimer = setTimeout(function () {
    refreshMapSize();
    centerOnSelectedPlace(false);
  }, 200);
}


/* ---------- 7. The info card ---------- */

function fillTagRow(container, words) {
  const row = createElement("div", "tag-row");
  words.forEach(function (word) {
    row.appendChild(createElement("span", "tag", word));
  });
  container.appendChild(row);
}

// Build the card's middle section from item.sections (safe DOM only).
function fillCardBody(item) {
  const body = document.getElementById("map-card-body");
  body.textContent = "";

  (item.sections || []).forEach(function (section) {
    const block = createElement("div", "map-fact");
    block.appendChild(createElement("div", "map-fact-label", section.label));

    if (section.tags) {
      fillTagRow(block, section.tags);
    } else if (section.href) {
      const link = createElement("a", "map-fact-link", section.linkText || section.href);
      link.href = section.href;
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      block.appendChild(link);
    } else {
      block.appendChild(createElement("p", "map-fact-text", section.text));
    }
    body.appendChild(block);
  });

  if (item.reasons && item.reasons.length > 0) {
    const why = createElement("div", "why");
    why.appendChild(createElement("h4", "", "Why this matches"));
    const list = createElement("ul");
    item.reasons.forEach(function (reason) {
      list.appendChild(createElement("li", reason.matched ? "is-match" : "miss", reason.text));
    });
    why.appendChild(list);
    body.appendChild(why);
  }

  if (item.note) {
    body.appendChild(createElement("p", "card-note", item.note));
  }
}

function fillMapCard(item, index) {
  const total = mapState.items.length;

  document.getElementById("map-position").textContent = (index + 1) + " of " + total;
  document.getElementById("map-card-badge").textContent = item.badge || "";
  document.getElementById("map-card-label").hidden = !(item.source === "local" && index === 0);
  document.getElementById("map-card-name").textContent = item.name;

  const categoryLine = document.getElementById("map-card-category");
  categoryLine.textContent = [item.categoryLabel, item.address].filter(Boolean).join(" · ");
  categoryLine.hidden = !categoryLine.textContent;

  // Score only for verified local parks. Never for discovered places.
  const scoreBox = document.getElementById("map-card-score");
  scoreBox.textContent = "";
  if (typeof item.score === "number") {
    scoreBox.appendChild(document.createTextNode(item.score + "%"));
    scoreBox.appendChild(createElement("small", "", "match"));
    scoreBox.setAttribute("aria-label", "Match score " + item.score + " percent");
    scoreBox.hidden = false;
  } else {
    scoreBox.hidden = true;
  }

  fillCardBody(item);

  const directions = document.getElementById("map-card-directions");
  directions.href = item.directionsUrl;
  directions.setAttribute("aria-label", "Get directions to " + item.name + " (opens Google Maps in a new tab)");

  const favoriteButton = document.getElementById("map-card-favorite");
  favoriteButton.dataset.parkId = item.id;
  updateFavoriteButton(favoriteButton);
}

function updateArrowVisibility() {
  const hasSeveral = mapState.items.length > 1;
  document.getElementById("map-prev").hidden = !hasSeveral;
  document.getElementById("map-next").hidden = !hasSeveral;
}

// Shrink the card, swap its content, then expand it again.
function switchCardContent(updateContent) {
  const card = document.getElementById("map-card");
  if (prefersReducedMotion()) {
    updateContent();
    return;
  }
  card.classList.add("is-switching");
  setTimeout(function () {
    updateContent();
    card.classList.remove("is-switching");
  }, CARD_SWITCH_MS);
}

// Mobile only: collapse or expand the bottom sheet.
function setCardCollapsed(collapsed) {
  const card = document.getElementById("map-card");
  const toggle = document.getElementById("map-card-toggle");
  card.classList.toggle("is-collapsed", collapsed);
  toggle.setAttribute("aria-expanded", collapsed ? "false" : "true");
  toggle.textContent = collapsed ? "Show more" : "Show less";
  updateArrowPosition();
}

// On phones, keep the side arrows centered in the area ABOVE the bottom sheet.
function updateArrowPosition() {
  const card = document.getElementById("map-card");
  const wrap = document.querySelector(".map-wrap");
  const covered = (isMobileLayout() && !card.hidden) ? wrap.clientHeight - card.offsetTop : 0;
  wrap.style.setProperty("--covered-bottom", Math.max(covered, 0) + "px");
}

// Attach every listener exactly once.
function setupMapControls() {
  if (mapState.controlsReady) return;
  mapState.controlsReady = true;

  document.getElementById("map-prev").addEventListener("click", showPreviousPlace);
  document.getElementById("map-next").addEventListener("click", showNextPlace);

  document.getElementById("map-card-favorite").addEventListener("click", function () {
    const item = getSelectedItem();
    if (item) toggleFavorite(item.id, item.favorite);
  });

  document.getElementById("map-card-toggle").addEventListener("click", function () {
    const card = document.getElementById("map-card");
    setCardCollapsed(!card.classList.contains("is-collapsed"));
    scheduleRecenter();
  });

  // Left/right arrow keys switch places while focus is in the map area.
  document.querySelector(".map-wrap").addEventListener("keydown", function (event) {
    // Don't steal arrow keys from the map itself (it uses them to pan).
    if (event.target.closest && event.target.closest("#park-map")) return;
    if (event.key === "ArrowLeft") showPreviousPlace();
    if (event.key === "ArrowRight") showNextPlace();
  });

  window.addEventListener("resize", scheduleRecenter);

  // When the card's height changes (new content, expand/collapse), keep the
  // mobile arrows centered above it.
  if ("ResizeObserver" in window) {
    new ResizeObserver(updateArrowPosition).observe(document.getElementById("map-card"));
  }
}


/* ---------- 8. Selecting places ---------- */

// Select an item by position. Wraps around at both ends.
function selectPlace(index, animate) {
  const total = mapState.items.length;
  if (total === 0) return;

  const previousIndex = mapState.selectedIndex;
  const newIndex = ((index % total) + total) % total;
  mapState.selectedIndex = newIndex;
  const item = mapState.items[newIndex];

  if (animate) {
    switchCardContent(function () { fillMapCard(item, newIndex); });
  } else {
    fillMapCard(item, newIndex);
  }

  if (mapState.map) {
    updateMarkerHighlight(previousIndex, newIndex);
    centerOnSelectedPlace(animate);
  }
}

function showPreviousPlace() {
  selectPlace(mapState.selectedIndex - 1, true);
}

function showNextPlace() {
  selectPlace(mapState.selectedIndex + 1, true);
}


/* ---------- 9. Functions used by script.js and places.js ---------- */

// Show the map section and make sure the map exists and has the right size.
function ensureMapReady() {
  const section = document.getElementById("map-section");
  section.hidden = false;
  setupMapControls();
  const ready = createMapIfNeeded();
  if (ready) mapState.map.invalidateSize();
  return ready;
}

// Replace everything on the map with a new list of items.
// Items without valid coordinates are skipped. Selects the first item.
function setMapItems(items, options) {
  const settings = options || {};
  const ready = ensureMapReady();

  mapState.items = items.filter(hasValidCoordinates);
  mapState.selectedIndex = -1;
  mapState.markers = [];
  if (ready) mapState.markerLayer.clearLayers(); // no duplicate markers

  const card = document.getElementById("map-card");
  if (mapState.items.length === 0) {
    card.hidden = true;
    updateArrowVisibility();
    updateArrowPosition();
    if (settings.emptyMessage) showMapMessage(settings.emptyMessage);
    return;
  }

  card.hidden = false;
  if (!mapState.tileProblem) hideMapMessage(); // clear old "no results" notes
  setCardCollapsed(isMobileLayout());

  if (ready) {
    mapState.markers = mapState.items.map(createMarker);
  }
  updateArrowVisibility();

  // Wait a frame so the card has its real size, then frame all places and select #1.
  requestAnimationFrame(function () {
    if (ready) mapState.map.invalidateSize();
    updateArrowPosition();
    selectPlace(0, false);
    if (ready && settings.fit !== false) fitMapToMarkers();
  });
}

// Add more items (e.g. "Load more"). The current selection stays the same.
function appendMapItems(newItems) {
  const valid = newItems.filter(hasValidCoordinates);
  if (valid.length === 0) return 0;

  const wasEmpty = mapState.items.length === 0;
  if (wasEmpty) {
    setMapItems(valid, { fit: true });
    return valid.length;
  }

  valid.forEach(function (item) {
    const index = mapState.items.length;
    mapState.items.push(item);
    if (mapState.map) mapState.markers.push(createMarker(item, index));
  });

  // Update the counter ("3 of 70") without moving the map.
  const selected = getSelectedItem();
  if (selected) document.getElementById("map-position").textContent =
    (mapState.selectedIndex + 1) + " of " + mapState.items.length;
  updateArrowVisibility();
  return valid.length;
}

function getMapItemCount() {
  return mapState.items.length;
}

// Center of the map right now (for "Search this area").
function getMapCenter() {
  if (!mapState.map) return { lat: DEFAULT_MAP_CENTER[0], lon: DEFAULT_MAP_CENTER[1] };
  const center = mapState.map.getCenter();
  return { lat: center.lat, lon: center.lng };
}

// Move the map without it counting as a user move (e.g. after a location search).
function setMapView(lat, lon, zoom) {
  if (!ensureMapReady()) return;
  moveMapProgrammatically(function () {
    mapState.map.setView([lat, lon], zoom || DEFAULT_MAP_ZOOM, { animate: !prefersReducedMotion() });
  });
}

/*
  Blue "you are here" dot. Kept on its own (not in markerLayer), so new
  searches don't remove it. Called after "Use my location" succeeds.
*/
function setUserLocation(lat, lon) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  mapState.userLocation = { lat: lat, lon: lon };
  drawUserLocation();
}

function clearUserLocation() {
  mapState.userLocation = null;
  if (mapState.userMarker) mapState.userMarker.remove();
  mapState.userMarker = null;
}

function drawUserLocation() {
  if (!mapState.map || !mapState.userLocation) return;
  const latLng = [mapState.userLocation.lat, mapState.userLocation.lon];
  if (mapState.userMarker) {
    mapState.userMarker.setLatLng(latLng);
    return;
  }
  const dot = document.createElement("div");
  dot.className = "user-dot";
  mapState.userMarker = L.marker(latLng, {
    icon: L.divIcon({ className: "user-dot-wrap", html: dot, iconSize: [22, 22], iconAnchor: [11, 11] }),
    pane: "userPane",
    alt: "You are here (approximate)",
    keyboard: false,
    interactive: false // clicks go through to any pin underneath
  }).addTo(mapState.map);
}

// places.js calls this so it hears about user drags/zooms.
function setUserMoveHandler(handler) {
  mapState.onUserMove = handler;
}

// Hide the map and remove all markers.
function hideResultsMap() {
  document.getElementById("map-section").hidden = true;
  mapState.items = [];
  mapState.markers = [];
  mapState.selectedIndex = -1;
  if (mapState.markerLayer) mapState.markerLayer.clearLayers();
}

// Leaflet can't measure itself while hidden, so call this when it reappears.
function refreshMapSize() {
  const section = document.getElementById("map-section");
  if (!mapState.map || section.hidden) return;
  requestAnimationFrame(function () {
    mapState.map.invalidateSize();
    updateArrowPosition();
  });
}
