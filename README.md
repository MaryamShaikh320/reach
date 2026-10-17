# GreenEscape
**Less Searching. More Exploring.**

GreenEscape helps busy students find a place to go: parks, gardens, cafes, viewpoints, and more. It has two modes that share one interactive map:

- **Explore places:** search real places near any city, address, ZIP code, or your location, in many categories, using the Geoapify Places API.
- **Nature picks:** the original four-question form. It scores our verified Cupertino/San Jose parks with a rule-based checklist, and also shows nearby parks found on Geoapify (clearly marked "not scored").

Hackathon theme: **Modern Life and/or Nature Life**.

---

## Files

| File | Purpose |
|---|---|
| `index.html` | Page structure: navigation, homepage, mode tabs, Explore search bar, Nature form, map, favorites page. |
| `style.css` | All visual design. Colors are set once at the top in `:root`. |
| `script.js` | Nature picks scoring (unchanged rules), result cards, favorites, page navigation, form handling. |
| `map.js` | The Leaflet map: markers, the floating info card, the edge arrows, centering. **Your Geoapify key goes here.** |
| `places.js` | Geoapify Places + Geocoding requests, categories, Explore mode, Load more, Search this area, Use my location. |
| `background.svg` | The forest landscape behind the whole site. It's our own illustration, so no licensing issues. Swap in any image you have the rights to by changing `background.svg` in `body::before` in `style.css`. |
| `parks.json` | 9 verified parks used by Nature picks (and as an offline fallback). |
| `README.md` | This file. |

Script order in `index.html` matters: Leaflet → `script.js` → `map.js` → `places.js`.

---

## Setup

### 1. Get your own Geoapify API key
Keys that were pasted into chats or shared publicly should be treated as exposed. **Create a new one:**

1. Sign in at **https://myprojects.geoapify.com** and create a project (free plan is fine).
2. Copy the project's API key.
3. **Restrict it** (in the project's API key settings): allow only your site's addresses, for example `http://127.0.0.1:5500` (Live Server) and your final hosted URL. Delete or regenerate any old keys you shared.
4. Check the project's usage dashboard and limits so a demo can't use up your quota by surprise.

**Important:** a key used in a website is **not secret**. Anyone can see it in the browser (it's in every request URL). Restricting it to your website's address is what protects it.

### 2. Add the key
Open `map.js`. Near the top, replace `YOUR_GEOAPIFY_API_KEY`:
```js
const GEOAPIFY_API_KEY = "paste-your-new-key-here";
```
`places.js` uses the same key, so there's only one place to change.

### 3. Run it (macOS + VS Code)
1. Install the **Live Server** extension in VS Code.
2. Open the `GreenEscape` folder (**File → Open Folder**).
3. Right-click `index.html` → **Open with Live Server** (opens `http://127.0.0.1:5500`).

Don't double-click `index.html`. `file://` blocks loading `parks.json` and "Use my location".
No VS Code? Run `python3 -m http.server 8000` in the folder and open `http://localhost:8000`.
To see errors in Chrome: **Cmd + Option + J**.

---

## How it works

### Explore places (`places.js`)
- **Search:** type a city, address, or 5-digit ZIP. ZIPs are looked up with `type=postcode&filter=countrycode:us`. Other text is biased toward the demo area.
- **Use my location:** asks the browser for permission **only after you click**. Coordinates are rounded to about 100 m, used for that one search, and never stored or shown. Browsers only allow this on `https://` or `localhost`/`127.0.0.1`.
- **Search this area:** after you drag or zoom the map, a button appears. Nothing is requested until you click it. Moving the map with the arrows never triggers a search.
- **Category and radius:** changing either repeats the last search (after a short pause, so quick changes don't cause many requests).
- **Requests:** `GET https://api.geoapify.com/v2/places` with `categories`, `filter=circle:lon,lat,meters` (the real radius filter), `bias=proximity:lon,lat` (nearest first), `limit=50`, `offset`.
- **Load more places:** asks for the next 50 with `offset`. Duplicates (same `place_id`) are skipped. The selected place stays selected. It stops at Geoapify's documented maximum of 500 places per search, or when a page comes back with fewer than 50.
- **Errors:** wrong key (401/403), rate limit (429), no internet, slow requests (12 s timeout), place not found, and no results each show a clear message. A newer search cancels an older one (`AbortController` + a request number), so a slow old answer can never replace newer results. Identical requests are cached in memory.

### Categories
Every option maps to category IDs from Geoapify's documented list (for example `leisure.park.garden`, `catering.cafe`, `tourism`). A parent ID like `catering` includes all its children.

**"All visitor categories":** Geoapify has no documented "everything" wildcard, so this sends a list of parent categories people visit (leisure, natural, tourism, catering, commercial, sport, accommodation, amenity, healthcare, and more). Infrastructure categories like `highway`, `power`, `building`, and `office` are left out on purpose, because they'd fill the map with things like street lamps and offices. Because results are nearest-first, "all categories" in a busy area shows mostly nearby shops and food. Pick a category for more focused results.

### Place cards show only real data
- Name, category, and address come from Geoapify.
- Description, opening hours, and website appear **only** when OpenStreetMap has them. Hours are labeled "from OpenStreetMap". Website links must be `http`/`https`.
- Features like "Wheelchair accessible" or "Free Wi-Fi" appear only when Geoapify includes those tags.
- Distance is a straight-line estimate from your search point. No travel times.
- Places with no name are labeled "Unnamed park", etc. Places with missing or invalid coordinates are skipped.
- **No ratings, reviews, photos, or match scores** for discovered places.

### Nature picks (`script.js` + `places.js`)
- The scoring rules (activity 40, setting 30, visit time 20, transport 10) are **unchanged** and are used **only** for the 9 verified parks in `parks.json`, because only those have activity, setting, and visit-time data.
- There's no longer a "top 3" cap: every verified park scoring 50+ is shown.
- Places from Geoapify near your ZIP (or the demo area) are added to the map as **"Discovered nearby · not scored"**. **Your activity decides which categories are searched** (all documented Geoapify IDs):

  | Activity | Geoapify categories searched |
  |---|---|
  | Relaxing | `leisure.park`, `leisure.picnic`, `natural.water` |
  | Walking | `leisure.park`, `leisure.park.nature_reserve`, `natural.protected_area`, `natural.water` |
  | Hiking | `natural.mountain`, `natural.protected_area`, `national_park`, `leisure.park.nature_reserve`, `natural.forest` |
  | Exercising | `leisure.park`, `natural.protected_area`, `sport.pitch` |
  | Sightseeing | `tourism.attraction.viewpoint`, `tourism.sights`, `leisure.park.garden`, `natural.water`, `natural.mountain` |

  Your **setting** (quiet, scenic, forest, garden, open space) puts places whose category fits it first. Each card says which choices its category fits, for example "Found for hiking" or "Forest setting". Search radius: 3 km walking, 15 km driving, 25 km driving for hikes. Mountain results mark summits, so their cards remind people to check trail access. To change what an activity finds, edit `NATURE_ACTIVITY_CATEGORIES` at the top of `places.js`. Missing details are never counted against them. A discovered park within about 250 m of a verified park is treated as the same place and skipped, so there are no duplicates.
- Without a Geoapify key, Nature picks still works with the verified parks.

### Starting point and travel time (Nature picks)
- **Starting point (optional):** type a ZIP code **or** tap **Use my location**. Location is only requested after the tap. It's rounded to about 100 m, used for that search, shown on the map as a blue dot, and never saved. Typing a ZIP switches back from location, and "Clear" removes it. If permission is denied, a message suggests a ZIP instead.
- **Free time means total time.** With a starting point, one request to Geoapify's **Route Matrix API** (`POST https://api.geoapify.com/v1/routematrix`, `mode: "walk"` or `"drive"`) gets real one-way travel times to all 9 verified parks. A second request covers the discovered places.
- **Time there = total − 2 × one-way trip.** The visit-time score (20 points) uses the time left there:
  - 20 points if the park's `minVisitMinutes` fits the time left.
  - 10 points if it's up to double the time left.
  - 0 points otherwise.
- **Parks where the round trip uses up all your time are left out**, along with discovered places like that. If nothing is left, the message suggests more time or driving.
- **Walkers' transport points** use the real walking time: up to 25 min each way scores 10, up to 45 min scores 5.
- Cards show it plainly, for example "~6 min drive each way from 95014 → ~48 of your 60 min there."
- **Fallbacks, always stated in the results header:**
  - No starting point, ZIP not found, or routing fails → your time counts as time at the place, as before, and walking uses straight-line distance.
  - A park with no route → "No route found, so travel isn't counted."
- Travel times come from Geoapify's routes **without live traffic**, so real trips can take longer. Each search with a starting point uses 1–2 routing requests on top of the place search.

### The map (`map.js`)
- One Leaflet map, created once. Every new result set clears the old markers first (no duplicates).
- **‹ and › sit on the left and right edges of the map**, vertically centered (on phones, centered in the area above the bottom sheet). They wrap around: 50 of 50 → 1 of 50.
- **Centering:** whenever a place is selected (marker click, arrow, or ← → keys), the map converts the place to screen pixels, shifts it by half the space the card covers, and smoothly moves there. On desktop the place lands in the middle of the area **right of the card**. On phones it lands in the middle of the area **above the bottom sheet**. It re-centers after resizing or opening/closing the sheet. Zoom stays between 14 and 17. Reduced-motion users get no animation.
- Only the two markers that change are redrawn when switching, so it stays quick with hundreds of places.

### Favorites
- Saved in `localStorage` as small objects (`id, name, latitude, longitude, address, category, source`), so Geoapify places still show after a refresh.
- Old favorites saved as plain park IDs still work. IDs that no longer exist in `parks.json` are ignored.
- No duplicates, and every favorite button on the page stays in sync.

### Spin the wheel (Favorites page)
- "Can't decide where to go?" appears once there's at least 1 saved place. Spinning needs at least 2 ("Save at least 2 places to spin" otherwise).
- The winner is chosen **first**, fairly (`crypto.getRandomValues`). The wheel then turns 5 full spins and stops with that place's slice under the pointer. The announced place is always the one under the pointer.
- The result card shows the place with a **Get Directions** button.
- The wheel redraws when you save or remove favorites. If the picked place is removed, its result disappears.
- People who prefer reduced motion get the result right away, with no spinning.

### Directions
- Discovered places: Google Maps directions to their **exact coordinates**.
- Verified parks: name + verified address (or coordinates for the one placeholder address).
- If you searched by city/ZIP, that becomes the starting point. Otherwise Google uses your current location.

---

## Team plan

| Dev | Owns | Main file |
|---|---|---|
| 1 | Nature scoring and integration | `script.js` (sections 3, 7) |
| 2 | HTML structure and forms | `index.html` |
| 3 | CSS design and mobile | `style.css` |
| 4 | Places search, categories, and park data | `places.js`, `parks.json` |
| 5 | Map, favorites, testing, README, slides | `map.js`, `script.js` (section 5), `README.md` |

Avoid merge conflicts: one owner per file, small pull requests, pull `main` often, and **never rename an `id` without telling everyone** (CSS and three JS files depend on them). Freeze features 2 hours before judging.

---

## Testing checklist

**Explore**
- [ ] Opening Find shows Explore and searches parks & nature near the demo area once.
- [ ] Status shows the real count ("Showing 50 places…").
- [ ] Markers appear at the right spots (spot-check 3 by clicking **Get Directions**).
- [ ] Clicking a marker shows that place in the card, highlights only that marker, and centers it right of the card.
- [ ] › goes 1 → 2 → 3. ‹ from 1 goes to the last place. The counter matches.
- [ ] ‹ is on the far left edge and › on the far right, both vertically centered, not covered by the card.
- [ ] Each category option returns matching places. "All visitor categories" returns a mix.
- [ ] Each radius changes the results.
- [ ] Search "Cupertino", "95014", and a full address. A nonsense word shows "We couldn't find…".
- [ ] Drag the map → "Search this area" appears. Using the arrows does **not** make it appear. Clicking it searches there.
- [ ] Load more places adds 50 more, the counter grows ("5 of 100"), the selection doesn't jump, and there are no duplicate markers.
- [ ] Use my location: allow → nearby results. Block → friendly message.
- [ ] Change category several times quickly → only the last choice's results show.
- [ ] In Chrome DevTools → Network, moving between places makes no new Geoapify requests.

**Nature picks**
- [ ] 30 min / Relaxing / Walking / Quiet / ZIP 95014 → verified matches with scores and "Why this matches", plus "Discovered nearby · not scored" places with no score.
- [ ] McClellan Ranch appears once (not again as a discovered place).
- [ ] List cards below the map show only verified parks.
- [ ] Clear hides the map. Switching tabs keeps each mode's results.
- [ ] 60 min / Relaxing / **Driving** / Quiet / ZIP 95014 → header says the minutes include the trip. Cards say "~X min drive each way … ~Y of your 60 min there". The numbers add up (Y = 60 − 2X).
- [ ] Same with **Walking** → far parks drop out. If none are left, the message suggests more time or driving.
- [ ] Use my location: allow → "Using your approximate location". Results use it, and directions have no `origin=` (Google uses your location). Block → friendly message.
- [ ] Typing a ZIP after using location switches to the ZIP. "Clear" works.
- [ ] No starting point → header says the time is treated as time at the place.

**Favorites and directions**
- [ ] Save a discovered place and a verified park. Refresh → both are on the Favorites page.
- [ ] Remove works, the badge count matches, and the card's button updates when switching places.
- [ ] Directions always open the place shown in the card.

**Spin the wheel**
- [ ] 0 favorites: no wheel. 1 favorite: button disabled with a hint. 2 or more: spins.
- [ ] The place announced is the slice under the pointer, every time. The button is disabled while spinning.
- [ ] Get Directions in the result opens the right place. Removing that favorite hides the result.
- [ ] No label on the wheel is upside down.

**Errors and layout**
- [ ] Wrong key → "Geoapify rejected the API key…". No key → "Add your Geoapify API key…".
- [ ] No internet → clear message. Nature picks still works.
- [ ] Phone size: bottom sheet, Show more/less, arrows above the sheet, place centered above it, no sideways scrolling.
- [ ] No red errors in the console.

---

## Known limitations
- Place details come from OpenStreetMap via Geoapify. Many places have no hours, website, or description, and some data may be out of date.
- Distances are straight lines. There are no travel times.
- Each search is limited to 500 places (Geoapify's maximum), loaded 50 at a time.
- The free Geoapify plan has daily request limits. Every search, Load more, and Nature picks submission uses requests (moving between places doesn't).
- "All visitor categories" in a busy area is dominated by the nearest shops and restaurants.
- Opening hours are shown in OpenStreetMap's raw format (for example `Mo-Fr 08:00-18:00`).

## Deferred (time)
- Marker clustering (with 500 markers the map is still usable, but crowded at low zoom).
- A scrollable text list of Explore results.
- Weather.
- Place photos and reviews (Geoapify doesn't provide them, and we don't invent them).
