# Reach

**Less Searching. More Exploring.**

Reach answers one question: *"Where can I go in the free time I have right now?"*
Enter your free time, activity, how you're getting there and the kind of place you like. Reach uses **your current location** (or, if you don't allow location, **any US ZIP code** you type).
Reach checks every nearby park or study spot, works out **how long you could stay** there (your free time minus the time to get there and a 5-minute buffer), and shows the reachable ones on a map: **green** if you get the stay you asked for, **yellow** if you'd get less. Each one gets a score from 0 to 100.

Places come from two sources:
- **Live search (any US ZIP):** [Geoapify](https://www.geoapify.com/) looks up the ZIP and finds places nearby (OpenStreetMap data). What it searches depends on the **Looking for** choice:
  - **Parks:** parks, gardens, nature preserves and national parks
  - **Study spots:** libraries and cafes
- **Curated San Jose picks:** 10 hand-picked places in `destinations.json` with detailed hours, amenities and visit lengths, mixed into results for San Jose-area searches. Cards say *"Reach pick"*.

> ⚠️ **`destinations.json` is SAMPLE DATA.** Coordinates, hours, fees, amenities and ZIP centroids are best-effort estimates and have not been verified on site. Every destination has a `verify` list of fields to check first.

## API key (Geoapify)

The key lives in **`config.js`**:

```js
window.GREENESCAPE_CONFIG = { GEOAPIFY_KEY: 'your-key-here' };
```

- The free plan allows 3,000 credits a day. One search uses about 3 credits: a ZIP lookup (cached forever) plus two place searches (cached 7 days per area).
- **The key is visible to anyone who opens the site.** Before you share it publicly, restrict the key to your site's address in the [Geoapify dashboard](https://myprojects.geoapify.com).
- With an empty key, the app still works for San Jose ZIPs using only the curated places.

Open-Meteo (weather) and Google Maps links need no key.

---

## Run it

No build step and no dependencies. You only need a local web server, because browsers block `fetch('destinations.json')` from `file://`.

```bash
cd greenescape
python3 -m http.server 8000
# open http://localhost:8000
```

(`npx serve` or the VS Code "Live Server" extension work too.) To test on your phone, use your laptop's LAN IP, e.g. `http://192.168.1.20:8000`.

**Offline:** after the first load, a small service worker (`sw.js`) caches the app. ZIP lookups, the last 6 place searches and the last weather forecast are saved in LocalStorage, so repeat searches work offline. San Jose ZIPs always work offline with the curated places. Without any forecast, scoring treats the weather as neutral, and sunset is calculated on the device.

## Files

| File | What it is |
|---|---|
| `index.html` | Page shell with three views: Plan, Results (full-screen map), Favorites (hash routing: `#/plan`, `#/results`, `#/favorites`) |
| `styles.css` | Mobile-first styles. Color tokens on `:root`, dark mode via system setting or the ◐ toggle |
| `config.js` | Your Geoapify API key |
| `app.js` | All logic, in numbered sections. **Section 1 (`CONFIG`) holds every tunable number**; section 3b is the Geoapify live search |
| `destinations.json` | Curated San Jose places + San Jose ZIP centroids (used offline) |
| `sw.js` | Offline cache (network-first, so you always get fresh code while developing) |
| `vendor/leaflet/` | [Leaflet](https://leafletjs.com) 1.9.4 map library, bundled locally (BSD-2 license, see its `LICENSE`). No build step, no CDN |

## Parks or study spots

The first question, **Looking for**, picks what to search:
- **Parks** (default): everything below about activities, environments, weather and sunset applies. Campus grounds are excluded (see below).
- **Study spots:** libraries and cafes. The *activity* and *environment* questions hide, because the activity is always "studying" and quiet is always preferred. Libraries score higher than cafes because they're quiet. **Wi-Fi** and **restrooms** count as amenities when the map data lists them, and parking counts when driving. Weather doesn't affect the score, since you're indoors. If opening hours aren't listed, the app assumes **9 AM to 6 PM** and says so. The curated San Jose list holds parks only, so study searches are always live.

**Campus grounds are never recommended as parks.** Map data often tags college quads and gardens as "parks"; De Anza's Sunken Garden is an example. Reach drops a live "park" if any of these is true:
1. it's inside an area listed in `CONFIG.EXCLUDED_AREAS` (De Anza College is listed; add more campuses there);
2. its name mentions college/university/campus (unless it's a named "... Park"), or its operator or address does;
3. it isn't named "... Park" and sits within `CONFIG.CAMPUS_BUFFER_KM` (300 m) of a college or university. The app fetches college and university points in the same request, only for this check.

Real city parks next to a campus, like Cupertino's Memorial Park beside De Anza, still show up.

## Spin the wheel

On the **Favorites** page, **Spin the wheel** gives each saved place an equal slice. Tap **Spin** and it turns for about 4 seconds, then stops on a random favorite and shows it with today's hours and **Get directions**. The pick is made first (with the browser's secure random generator), then the wheel animates to land on it, so the result always matches the slice under the pointer. You need at least 2 favorites. Up to 16 (the most recent) go on the wheel. With "reduce motion" turned on in your device settings, it skips the animation. Settings are in `WHEEL` in `app.js`.

## How live search works

1. **ZIP → location:** Geoapify Geocoding API (`type=postcode`, US only).
2. **Search radius:** how far a place could possibly be and still fit, given your free time and travel mode (1.5–40 km, rounded up so searches cache well). Example: driving with 2 hours searches about 20 km.
3. **Place searches** in that circle:
   - Parks: everyday parks nearest you (`leisure.park`, plus `education.college` and `education.university` points for the campus filter), and bigger preserves (`leisure.park.nature_reserve`, `national_park`) so small parks don't crowd out big ones
   - Study spots: `education.library`, `catering.cafe`

   If Geoapify rejects a category name, the app retries with a safe list.
4. **Cleanup:** drops unnamed places, private ones, dog runs, playgrounds and skate parks, and duplicates. Live places within 400 m of a curated one (or with the same name) are dropped in favor of the curated version.
5. **Estimating the missing details** (OpenStreetMap doesn't know these):
   - **Type, environment, activities and weather exposure** come from the category and from name hints. "Lake/Creek/River" adds *water*, "Woods/Grove/Redwood" adds *forest*, "Garden/Arboretum" adds *garden*, and "Trail/Preserve/Open Space/Ridge" adds *hiking* and *scenic*.
   - **Opening hours** are read from OpenStreetMap when they're in a simple format (`Mo-Fr 08:00-18:00; Sa off`, `sunrise-sunset`, `24/7`, overnight hours). Otherwise the app assumes **sunrise to 30 min after sunset** and says so on the card.
   - **Amenities** (restrooms, drinking water, benches, parking) come from OpenStreetMap tags when present. Unlisted ones show as "?" and get **half credit** in the score.

## How the fit check works (the main feature)

For each destination:

```
time you can stay = your free time - time to get there - 5 min safety buffer
```

There's no minimum visit and no trip back: your free time is the time until you leave the place. The stay is also cut short if the place closes first, or, for unlit trails and scenic areas, when it gets dark. If it opens after you'd arrive, the wait is taken out too.

**Travel time** = straight-line (Haversine) distance × **1.3** detour factor ÷ speed, rounded up:

| Mode | Speed | Fixed overhead |
|---|---|---|
| Walking | 5 km/h | none |
| Driving | 30 km/h | +5 min to park |
| Transit | 18 km/h average | +10 min (walk to the stop + wait). **Rough estimate, no live schedules** |

**"How long do you want to stay?"** (15 min, 30 min, 1 hr, 2 hrs, or custom 5–600 min) sets the color:
- **Green:** the time you can stay is at least what you want.
- **Yellow:** you can get there, but you'd stay less than you want. The card says *"Less than the 30 min you wanted"*.
- **Not shown:** closed that day, you'd arrive after it closes (or after dark at an unlit trail), or there's no time left once you arrive. Example reason: *"It's 26 min away on foot, so with the 5 min buffer there's no time left to stay."*

Example: Memorial Park is 7 min away on foot and you have 30 min free: 30 - 7 - 5 = **18 min there**. That's green if you want 15 min, yellow if you want 30.

Green places are listed first, then yellow; within each color, highest score first. Settings: `CONFIG.BUFFER_MIN` (5) and `STAY_OPTIONS`.

Opening hours can use clock times or sunset-relative times (`"08:00"`, `"sunset"`, `"sunset+30"`). Sunset comes from Open-Meteo, with an on-device calculation as the fallback. The full list of places that aren't shown, with reasons, is in `Reach.state.results.notFitting` in the browser console.

## The results map

Results open as a full-screen map:
- **Numbered pins** mark only the reachable recommendations: **green** = you get the stay you asked for, **yellow** = less than you wanted. Green comes first, then yellow, best score first. A big pulsing blue **You** dot marks where you are (labeled **Start** for a ZIP), and the locate button flies back to it.
- **The card on top** shows one recommendation at a time: the score, the name, type and distance, the two time numbers, a short description, the top reasons, and **Get directions** / **Save**. The "you can spend there" box is green or yellow to match the pin. Reasons are short and friendly, for example *"Great for a walk. An easy loop here clears your head."* (tips live in `ACTIVITY_TIPS`).
- **Driving starts at your parking lot:** in driving mode, Google Maps moves "Your location" to the nearest road a car can use, which on a campus can be a freeway. So when you drive from your current location, **Get directions** starts the route at the **nearest car parking lot within 500 m** (private lots and bike parking are skipped). The card says *"Driving directions start at Flint Center Parking Structure, 3 min walk from you."* This uses one extra Geoapify request per driving search (saved for 24 h). It sends your position rounded to about 10 m, while place search uses about 100 m. If no lot is found, the link falls back to Google's own location. ZIP searches still start at the ZIP. Settings are in `PARKING` in `app.js`.
- **Close enough to walk:** if you chose driving or transit and a place is within **1 mile** (straight line, `CONFIG.WALKABLE_MI`), Reach plans that place **as a walk**. The card's "to get there" time, the time you can stay, the green/yellow color, the ranking and **Get directions** all use walking. The mode you picked moves into a blue box: *"Close enough to walk. Driving would take about 6 min, including parking."*, with a **Driving directions** (or **Transit directions**) link. If walking would leave no time there at all, the place stays on your chosen mode. See `walkSwap()` in `app.js`.
- **No emojis anywhere in the UI:** plain text labels, with simple line icons only for the arrows, the theme toggle and the locate button.
- **‹ and ›** (left and right middle of the screen) step to the previous/next recommendation. The selected pin grows to **1.5×**, and the map flies (to street level) so it lands **beside the card**:
  - wide screens: just right of the card, on the line toward the › button (about a quarter of the way across), level with the ‹ › buttons
  - phones (no room beside the card): just under the card, level with the ‹ › buttons

  You can also tap a pin, swipe the card left/right, or use the ← → keys.
- **Bottom chips:** *Change plan*, and a weather chip that opens the full weather, sunset and search details.
- **Change plan** slides up a panel with all the plan options (time, how long to stay, leaving, activity, getting there, environment, and your ZIP if you're not using location). **Recalculate plan** re-runs the search right there on the map. **Cancel**, Escape, or tapping outside closes it without changes.
- **Map tiles:** [Geoapify map tiles](https://www.geoapify.com/map-tiles), using the same `GEOAPIFY_KEY`. The map always uses the bright *OSM Bright* style, a colorful street map with green parks, so roads stay readable even when the app is in dark mode. To use the darker *Dark Matter* style in dark mode instead, set `CONFIG.MAP_DARK_TILES = true`. Each tile costs only a small fraction of a credit. If Geoapify tiles fail, or there's no key, the map steps down to the light style and then to plain OpenStreetMap tiles (no key). Tiles need internet; offline, the card and ‹ › still work. Change styles in `CONFIG.MAP_TILES`.

Cards keep it simple and show just two numbers: **time to get there** and **how long you can spend there** (your free time minus the time to get there and the 5 min buffer, cut short if the place closes or it gets dark first). A short note like *"Closes at 6:30 PM"* appears only when closing time or sunset is what limits your stay. The full math is still in `Reach.state.results` in the browser console.

## How the Escape Score works (0–100)

Only places that fit (✅ or ⚠️) get a score. Each factor is a value from 0 to 1, multiplied by its weight:

| Factor | Weight | How it's measured |
|---|---|---|
| Activity match | **35** | 1 if the place lists your activity; partial credit for related ones (walking↔hiking 0.6, relaxing↔picnic 0.6, …); else 0 |
| Environment match | **25** | 1 if the place has your environment tag; partial for related (quiet↔forest 0.5, scenic↔water 0.5, …) |
| Amenities | **15** | Share of the amenities that matter for your activity (e.g. picnic: benches, shade, restrooms, water fountain). Parking is added when driving. Unknown counts as half |
| Distance | **15** | Based on how much of your free time goes to getting there: `1 − (travel there ÷ free time) ÷ 0.5`. Spending half your time or more getting there scores 0 |
| Weather | **10** | Starts at 1. Penalties for rain, storms, heat, cold, wind and high UV, scaled by the place's `exposure` (exposed 1.0, partial 0.6, sheltered 0.3). Shade softens heat and UV |

`score = round(Σ weight × value)`. Cards show the top 3 positive factors as reasons, plus one "heads-up" for the factor that cost the most points (if it cost 5 or more). Ties are broken by spare time.
Relatedness tables and weights live in `app.js` section 1.

## Weather

Open-Meteo hourly forecast (free, no API key) for the ZIP's center, in °F / mph / inches. Thresholds, all in `CONFIG.WEATHER`:
- rain: ≥ 50% chance or ≥ 0.01 in in an hour
- heat: feels like ≥ 90 °F
- cold: feels like ≤ 45 °F
- wind: ≥ 20 mph or gusts ≥ 30
- UV: index ≥ 8

It checks your window, plus 3 hours after it, so you get messages like *"Rain is likely around 5 PM. Your window ends at 4:00 PM, so you're fine."*

## Decisions we made (change in `CONFIG` if you disagree)

- **Starting point: location first, ZIP only as a fallback.** When the page opens, the browser asks to share your location. If you allow it, there's no ZIP field. If you block it, location fails, or the prompt goes unanswered when you search, a ZIP field appears instead.
  - Coordinates are rounded to about 100 m before they're sent to Geoapify and Open-Meteo.
  - "Get directions" then lets Google Maps start from where you actually are.
  - **Location only works on `https://` or `http://localhost`.** If teammates open the app on a phone via your laptop's IP (e.g. `http://192.168.1.20:8000`), the browser blocks location and they'll get the ZIP field. Deploy to an https host (GitHub Pages, Netlify) for location on phones.
  - A ZIP search uses the ZIP's center from Geoapify. The San Jose ZIP table in `destinations.json` is only an offline fallback.
- **Time zones:** times are shown in your device's time zone. Searching a ZIP in another time zone (e.g. a New York ZIP from California) shows opening hours and the trip window in your local time, so treat those results with care.
- **No reviews or photos for live places.** Geoapify/OpenStreetMap doesn't provide them. Google Places would, but it needs a billing account.
- **"3+ hrs" counts as 180 minutes.** Custom accepts 10–720 minutes.
- **"Leaving: Later today"** lets you plan ahead. A time earlier than now means tomorrow. Handy for demos after sunset, when most parks are closed.
- **Google Maps link** uses the place's name + address as the destination, so Google finds the real place even if our sample coordinates are slightly off. Your ZIP is the origin, and travel mode matches your choice.
- Photos: `photo` is empty for every sample place, so cards show a built-in illustration. Add a URL you have rights to use (your own photo, Wikimedia Commons with credit) and it is used automatically. A broken URL falls back to the illustration.

## Before launch: verification checklist

0. Restrict the Geoapify key to your site's address (see above).
1. For each destination, check every field in its `verify` array (hours, fees, restrooms, entrances).
2. Replace the ZIP centroids with real Census ZCTA centroids (the current ones are approximate).
3. Sanity-check `visitMinutes` with a few real visits.
4. Add photos.
5. Set `meta.sampleData` to `false` and `meta.lastReviewed` to a date, then remove the "Sample data" footer line in `index.html`.

## Adding a destination

Copy an entry in `destinations.json` and fill in every field. Allowed values:
- `type`: `park`, `garden`, `trail`, `scenic area` (trails and scenic areas count as "closed" after sunset)
- `environment`: `quiet`, `scenic`, `water`, `forest`, `garden`, `open field`
- `activities`: `relaxing`, `walking`, `hiking`, `exercise`, `picnic`
- `exposure`: `exposed`, `partial`, `sheltered`

## Debugging

Pure functions are exposed in the browser console:

```js
Reach.haversineKm({lat:37.335,lng:-121.881},{lat:37.3318,lng:-121.9282})
Reach.state.results   // the last search, with every number behind every verdict
```

## Out of scope (for now)

Live route calculation, user accounts, community reviews, and AI-generated recommendations. Everything is rule-based and deterministic.
