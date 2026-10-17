/* =====================================================================
   Reach: agent.js (add-on)
   Pattern agent: learns what you pick between classes and suggests
   "your usual", e.g. "Mondays after CS 46A: a quiet garden about
   10 min away by car".

   Install: load it right after app.js in index.html
     <script src="agent.js" defer></script>
   It doesn't change app.js. It wraps a few of app.js's functions
   (see "Hooks" at the bottom), so app.js can be updated separately.

   Signals: directions you open, places you save, wheel picks, plans you
   search, and "Less like this" taps. Each is stored with its moment:
   weekday, time of day, length of the gap, the class before and after,
   and whether a test is coming up.

   To predict, every past choice is weighted by how much its moment looks
   like now (context similarity) and by how recent it is (older choices
   fade), then tallied. Used in three places:
     - Plan page banner: "Your usual on Mondays is <place>. Would you like
       to go there today?" Its button searches with what you usually pick.
     - Results: matching places move up (up to AGENT.BOOST_MAX points) with
       a "For you" line. The Escape Score shown on the card is unchanged.
     - Schedule page: "Your usual spots", with pause and forget
   Nothing leaves the device.
   ===================================================================== */
(() => {
'use strict';

if (typeof runSearch !== 'function' || typeof STORAGE_KEYS !== 'object') {
  console.warn('[Reach] agent.js must load after app.js. The pattern agent is off.');
  return;
}

/* ---------------------------------------------------------------------
   1. CONFIG
   --------------------------------------------------------------------- */
const AGENT = {
  STORAGE_KEY: 'greenescape.agent',
  MAX_EVENTS: 300,
  HALF_LIFE_DAYS: 28,     // a choice from 4 weeks ago counts half as much
  MIN_EVIDENCE: 1.5,      // weighted choices needed before the agent speaks up (about 2 recent picks)
  FULL_EVIDENCE: 5,       // ...and before it's fully confident
  BOOST_MAX: 12,          // most ranking points a pattern match can add
  SIMILAR: 0.6,           // context similarity that counts as "a moment like this"
  // How much each action says about what you like (negative = less of this).
  SIGNALS: { go: 1, spin: 0.7, save: 0.5, search: 0.3, dismiss: -0.8 },
  // How much each matching detail counts when comparing two moments.
  CONTEXT_WEIGHTS: { after: 3, before: 2, test: 2, day: 1.5, slot: 1.5, gap: 1 },
  BASE_SIMILARITY: 0.15,  // choices from other moments still count a little (general taste)
};

const TYPE_PLURALS = { 'park': 'parks', 'garden': 'gardens', 'trail': 'trails', 'scenic area': 'scenic spots', 'library': 'libraries', 'cafe': 'cafes' };

// Describing a setting in front of a place type: "quiet gardens", "wooded trails".
// Ties go to the earlier word in this list.
const SETTING_WORDS = { 'quiet': 'quiet', 'scenic': 'scenic', 'water': 'waterside', 'forest': 'wooded', 'open field': 'open', 'garden': 'leafy' };

/** Best setting word for a tally of environment tags, skipping ones that repeat the type ("garden gardens"). */
function settingWord(envTable, typeKey, minShare = 0) {
  const order = Object.keys(SETTING_WORDS);
  const total = Object.values(envTable).reduce((sum, v) => sum + v, 0);
  const best = Object.entries(envTable)
    .filter(([k]) => SETTING_WORDS[k] && !(k === 'garden' && typeKey === 'garden'))
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))[0];
  return best && total && best[1] / total >= minShare ? SETTING_WORDS[best[0]] : '';
}

const TIME_SLOTS = [
  { key: 'morning',   label: 'mornings',     until: 11 * 60 },
  { key: 'midday',    label: 'around lunch', until: 14 * 60 },
  { key: 'afternoon', label: 'afternoons',   until: 17 * 60 },
  { key: 'evening',   label: 'evenings',     until: 24 * 60 },
];
const timeSlot = (min) => TIME_SLOTS.find((s) => min < s.until).key;
const slotLabel = (key) => (TIME_SLOTS.find((s) => s.key === key) || TIME_SLOTS[0]).label;
const gapBucket = (min) => (min == null ? 'open' : min < 45 ? 'short' : min < 100 ? 'medium' : 'long');
const findClass = (id) => (id ? getClasses().find((c) => c.id === id) : null);

/* ---------------------------------------------------------------------
   2. MEMORY (LocalStorage, this device only)
   --------------------------------------------------------------------- */
function getAgentData() {
  const d = store.get(AGENT.STORAGE_KEY, null);
  const events = d && Array.isArray(d.events)
    ? d.events.filter((e) => e && AGENT.SIGNALS[e.type] != null && e.ctx && typeof e.t === 'number')
    : [];
  return { events, paused: Boolean(d && d.paused), since: (d && d.since) || null };
}

const saveAgentData = (data) => store.set(AGENT.STORAGE_KEY, { ...data, events: data.events.slice(-AGENT.MAX_EVENTS) });

/** The moment a trip starts: weekday, time of day, gap length, and the classes around it. */
function agentContext(date = new Date(), freeMin = null) {
  const day = DAY_KEYS[date.getDay()];
  const m = nowMin(date);
  const todays = getClasses().filter((c) => c.days.includes(day));
  // The class you just came out of (ended in the last 2 hours) and the next one today.
  const after = todays.filter((c) => hhmmToMin(c.end) <= m && m - hhmmToMin(c.end) <= 120)
    .sort((a, b) => hhmmToMin(b.end) - hhmmToMin(a.end))[0];
  const before = todays.filter((c) => hhmmToMin(c.start) >= m)
    .sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start))[0];
  const gap = freeMin ?? (before ? hhmmToMin(before.start) - m : null);
  return {
    day, slot: timeSlot(m), gap: gapBucket(gap),
    after: after ? after.id : null, before: before ? before.id : null, test: Boolean(soonTest()),
  };
}

/** 0-1: how alike two moments are. */
function contextSimilarity(a, b) {
  const W = AGENT.CONTEXT_WEIGHTS;
  let total = 0;
  let same = 0;
  Object.keys(W).forEach((k) => {
    if ((k === 'after' || k === 'before') && !a[k] && !b[k]) return; // no class on either side: nothing to compare
    total += W[k];
    if (a[k] === b[k]) same += W[k];
  });
  return AGENT.BASE_SIMILARITY + (1 - AGENT.BASE_SIMILARITY) * (total ? same / total : 0);
}

const placeSnapshot = (p) => p && {
  id: p.id, name: p.name, type: p.type, kindLabel: p.kindLabel || '',
  environment: p.environment || [], lat: p.lat, lng: p.lng, address: p.address || '',
};

/** Remember one choice with its moment. */
function agentRecord(type, { place = null, prefs = null, start = new Date(), travelMin = null } = {}) {
  const data = getAgentData();
  if (data.paused || (!place && !prefs)) return;
  const p = prefs || {};
  data.events.push({
    type, t: Date.now(),
    ctx: agentContext(start, p.freeMin ?? null),
    prefs: prefs ? {
      kind: p.kind || (place && isStudyPlace(place) ? 'study' : 'parks'),
      activity: p.activity, environment: p.environment, mode: p.mode, freeMin: p.freeMin, stayMin: p.wantStayMin,
    } : null,
    place: placeSnapshot(place),
    travelMin,
  });
  if (!data.since) data.since = Date.now();
  saveAgentData(data);
}

/** A choice about a place: uses the current results (trip time, mode, travel) when the place is in them. */
function agentRecordChoice(type, placeId, mode) {
  const r = type === 'spin' ? null : state.results;
  const fit = r && r.fitting.find((f) => f.place.id === placeId);
  if (!fit) { agentRecord(type, { place: findPlace(placeId) }); return; }
  const m = mode || fit.mode || r.prefs.mode;
  const travelMin = fit.alt && fit.alt.mode === m ? fit.alt.thereMin : fit.travel.thereMin;
  agentRecord(type, { place: fit.place, prefs: { ...r.prefs, mode: m }, start: r.start, travelMin });
}

/* ---------------------------------------------------------------------
   3. LEARNING: tally past choices, weighted by similarity and recency
   --------------------------------------------------------------------- */

/** Biggest entry in a tally: { key, share } (share of the total), or null. */
function topOf(table) {
  const entries = Object.entries(table);
  const total = entries.reduce((sum, [, v]) => sum + v, 0);
  if (!total) return null;
  const [key, v] = entries.sort((a, b) => b[1] - a[1])[0];
  return { key, share: v / total };
}

/** What you tend to pick at moments like `ctx`: weighted tallies of past choices.
    `kind` ('parks' | 'study') limits it to choices of that kind. */
function agentProfile(ctx, { kind = null, data = getAgentData() } = {}) {
  const now = Date.now();
  const add = (table, key, w) => { if (key) table[key] = (table[key] || 0) + w; };
  const prof = {
    kind: {}, activity: {}, mode: {}, envTags: {}, types: {}, places: {}, dismissed: {},
    envWeight: 0, placeWeight: 0, evidence: 0, similar: 0, stay: [0, 0], travel: [0, 0],
  };
  data.events.forEach((e) => {
    const eKind = e.prefs ? e.prefs.kind : e.place ? (isStudyPlace(e.place) ? 'study' : 'parks') : null;
    if (kind && eKind && eKind !== kind) return;
    const sim = contextSimilarity(ctx, e.ctx);
    const fade = 0.5 ** ((now - e.t) / (AGENT.HALF_LIFE_DAYS * 86400000));
    const w = AGENT.SIGNALS[e.type] * sim * fade;
    if (w < 0) { if (e.place) add(prof.dismissed, e.place.id, -w); return; }

    prof.evidence += w;
    add(prof.kind, eKind, w);
    if (e.prefs) {
      add(prof.mode, e.prefs.mode, w);
      if (e.prefs.kind === 'parks') add(prof.activity, e.prefs.activity, w);
      if (e.prefs.freeMin && e.prefs.stayMin) { prof.stay[0] += w * (e.prefs.stayMin / e.prefs.freeMin); prof.stay[1] += w; }
    }
    // Setting: the tags of the place you picked, or what you asked for in a search.
    const tags = e.place ? e.place.environment : e.prefs && e.prefs.kind === 'parks' ? [e.prefs.environment] : [];
    if (tags.length) { tags.forEach((t) => add(prof.envTags, t, w)); prof.envWeight += w; }
    if (e.place) {
      add(prof.types, e.place.type, w);
      prof.placeWeight += w;
      const v = prof.places[e.place.id] || (prof.places[e.place.id] = { w: 0, n: 0, count: 0, place: e.place });
      v.w += w;
      v.count += 1;
      if (sim >= AGENT.SIMILAR) { v.n += 1; prof.similar += 1; } // only count picks made at moments like this one
    }
    if (e.travelMin != null) { prof.travel[0] += w * e.travelMin; prof.travel[1] += w; }
  });
  prof.confidence = prof.evidence < AGENT.MIN_EVIDENCE ? 0 : clamp(prof.evidence / AGENT.FULL_EVIDENCE);
  prof.stayRatio = prof.stay[1] ? prof.stay[0] / prof.stay[1] : null;
  prof.travelMin = prof.travel[1] ? prof.travel[0] / prof.travel[1] : null;
  return prof;
}

/** How well a place fits your pattern: ranking boost (0..BOOST_MAX) and the "For you" line. */
function agentMatch(place, prof) {
  if (!prof.confidence) return { boost: 0, text: '' };
  const visit = prof.places[place.id];
  const been = visit && prof.placeWeight ? Math.min(1, (2 * visit.w) / prof.placeWeight) : 0;
  const bestEnv = (place.environment || [])
    .map((e) => ({ e, share: prof.envWeight ? (prof.envTags[e] || 0) / prof.envWeight : 0 }))
    .sort((a, b) => b.share - a.share)[0] || { e: null, share: 0 };
  const typeShare = prof.placeWeight ? (prof.types[place.type] || 0) / prof.placeWeight : 0;
  const value = clamp(0.5 * been + 0.3 * bestEnv.share + 0.2 * typeShare - (prof.dismissed[place.id] || 0));
  const boost = Math.round(AGENT.BOOST_MAX * prof.confidence * value);
  let text = '';
  if (boost >= 3) {
    if (visit && visit.n >= 2) text = `You've picked this ${visit.n === 2 ? 'twice' : `${visit.n} times`} in breaks like this one.`;
    else if (visit) text = "You've picked this before.";
    else {
      // Describe it by the settings you pick and this place has.
      const shared = Object.fromEntries((place.environment || []).map((e) => [e, prof.envTags[e] || 0]));
      const word = bestEnv.share >= 0.3 ? settingWord(shared, place.type) : '';
      text = `New to you, and like the ${word ? `${word} ` : ''}${TYPE_PLURALS[place.type] || 'places'} you usually pick.`;
    }
  }
  return { boost, text };
}

/** The schedule's pick (app.js decideSpot), adjusted to your usual for this day of the week. */
function agentAdjust(pick) {
  const data = getAgentData();
  const start = pick.when === 'later' ? computeStart('later', pick.laterTime) : new Date();
  const ctx = agentContext(start, pick.freeMin);
  // "Your usual" is per weekday: only choices made on this day of the week count.
  const sameDay = { ...data, events: data.events.filter((e) => e.ctx.day === ctx.day) };
  const overall = agentProfile(ctx, { data: sameDay });
  if (!overall.confidence) return { ...pick, agent: { status: 'none' } };

  // Study or park? A test coming up wins, unless you clearly do something else before tests.
  const kindTop = topOf(overall.kind);
  const study = kindTop && kindTop.share >= (pick.study ? 0.75 : 0.6) ? kindTop.key === 'study' : pick.study;
  const prof = agentProfile(ctx, { kind: study ? 'study' : 'parks', data: sameDay });
  if (!prof.confidence) return { ...pick, agent: { status: 'none' } };

  const act = topOf(prof.activity);
  const env = topOf(prof.envTags);
  const mode = topOf(prof.mode);
  const type = topOf(prof.types);
  const stayMin = prof.stayRatio
    ? Math.max(10, Math.min(pick.freeMin - 5, Math.round((pick.freeMin * prof.stayRatio) / 5) * 5))
    : pick.stayMin;
  // A single place is "your usual" when you've gone there at least twice on this day and it's most of your picks.
  const top = Object.values(prof.places).sort((a, b) => b.w - a.w)[0];
  const usual = top && top.count >= 2 && top.w / prof.placeWeight >= 0.5 && !(prof.dismissed[top.place.id] >= 0.5) ? top.place : null;
  return {
    ...pick, study, stayMin,
    activity: !study && act && act.share >= 0.4 ? act.key : null,
    environment: !study && env && ENVIRONMENTS[env.key] ? env.key : null,
    mode: mode && mode.share >= 0.5 && CONFIG.MODES[mode.key] ? mode.key : null,
    label: "Let's go",
    agent: {
      status: 'ready', day: ctx.day, usual,
      plural: (type && TYPE_PLURALS[type.key]) || (study ? 'study spots' : 'parks'),
    },
  };
}

/** Re-rank results: Escape Score plus the pattern boost (green places still come before yellow). */
function rankByPattern(results) {
  const learned = agentProfile(agentContext(results.start, results.prefs.freeMin), { kind: results.prefs.kind });
  results.fitting.forEach((r) => { r.forYou = agentMatch(r.place, learned); });
  const rank = (r) => r.scoring.score + r.forYou.boost;
  results.fitting.sort((a, b) => (a.verdict === 'fits' ? 0 : 1) - (b.verdict === 'fits' ? 0 : 1)
    || rank(b) - rank(a) || b.onSiteMin - a.onSiteMin);
}

/* ---------------------------------------------------------------------
   4. RENDERING
   --------------------------------------------------------------------- */

/** "For you" line on a map card: why your pattern moved this place up, and a way to say it's wrong. */
function forYouHTML(fit) {
  if (!fit.forYou || !fit.forYou.text) return '';
  return `<p class="for-you"><span class="for-you-tag">For you</span> ${esc(fit.forYou.text)}
      <button type="button" class="link-btn" data-less="${esc(fit.place.id)}">Less like this</button></p>`;
}

/** Plan page banner: "Your usual on Mondays is <place>." + "Would you like to go there today?" */
function decorateScheduleHint(pick) {
  const box = $('#schedule-hint');
  const action = box.querySelector('.hint-action');
  const { agent } = pick;
  if (!action || agent.status !== 'ready' || pick.freeMin < 15) return; // no usual yet, or no time for a trip
  const days = `${DAY_NAMES[agent.day]}s`;
  const line = agent.usual
    ? `Your usual on ${esc(days)} is <strong>${esc(agent.usual.name)}</strong>.`
    : `Your usual is going to ${esc(agent.plural)} on ${esc(days)}.`;
  action.insertAdjacentHTML('beforebegin', `<div class="hint-row"><p class="agent-line">${line}</p></div>`);
  box.querySelector('.hint-why').textContent = 'Would you like to go there today?';
}

/** Schedule page: "Your usual spots", grouped by the moments you take breaks. */
function renderAgentPanel() {
  let box = $('#agent-panel');
  if (!box) {
    box = document.createElement('section');
    box.className = 'agent-panel';
    box.id = 'agent-panel';
    box.setAttribute('aria-labelledby', 'agent-title');
    $('#view-schedule').append(box);
    box.addEventListener('click', onAgentPanelClick);
  }
  const data = getAgentData();
  const picks = data.events.filter((e) => e.place && e.type !== 'dismiss');
  const toggle = `<button type="button" class="btn btn-small" data-agent="pause">${data.paused ? 'Resume learning' : 'Pause learning'}</button>`;
  const head = `<div class="section-head"><h2 id="agent-title">Your usual spots</h2></div>`;

  if (!data.events.length) {
    box.innerHTML = `${head}
      <p class="muted-note">Nothing yet. Each time you open directions, save a place or spin the wheel, Reach notes the moment
        (the day, the time, and which classes it falls between). After a few picks it suggests your usual and moves places you like up the list.
        It's all stored on this device.</p>
      ${data.paused ? `<div class="agent-actions">${toggle}</div>` : ''}`;
    return;
  }

  // Group picks by moment: "Mon after CS 46A", or "Tue afternoons" when no class came just before.
  const groups = new Map();
  picks.forEach((e) => {
    const cls = findClass(e.ctx.after);
    const label = `${DAY_LABELS[e.ctx.day] || e.ctx.day} ${cls ? `after ${cls.name}` : slotLabel(e.ctx.slot)}`;
    if (!groups.has(label)) groups.set(label, { label, n: 0, places: {}, env: {}, types: {}, modes: {}, order: SCHEDULE_DAYS.indexOf(e.ctx.day) });
    const g = groups.get(label);
    g.n += 1;
    g.places[e.place.id] = g.places[e.place.id] || { n: 0, name: e.place.name };
    g.places[e.place.id].n += 1;
    e.place.environment.forEach((t) => { g.env[t] = (g.env[t] || 0) + 1; });
    g.types[e.place.type] = (g.types[e.place.type] || 0) + 1;
    if (e.prefs && e.prefs.mode) g.modes[e.prefs.mode] = (g.modes[e.prefs.mode] || 0) + 1;
  });
  const patterns = [...groups.values()].filter((g) => g.n >= 2)
    .sort((a, b) => b.n - a.n || a.order - b.order).slice(0, 6)
    .sort((a, b) => a.order - b.order)
    .map((g) => {
      const place = Object.values(g.places).sort((a, b) => b.n - a.n)[0];
      const type = topOf(g.types);
      const mode = topOf(g.modes);
      const word = settingWord(g.env, type && type.key);
      const what = place.n >= 2
        ? `${esc(place.name)} <span class="agent-count">(${place.n}×)</span>`
        : esc(capitalize(`${word ? `${word} ` : ''}${type ? TYPE_PLURALS[type.key] : 'places'}`));
      const by = mode && CONFIG.MODES[mode.key] ? `, ${esc(CONFIG.MODES[mode.key].by)}` : '';
      return `<li><strong>${esc(g.label)}</strong><span class="agent-arrow" aria-hidden="true">→</span><span class="sr-only">: </span>${what}${by}</li>`;
    });

  // Overall taste, across every moment.
  const kinds = {};
  const modes = {};
  const env = {};
  data.events.filter((e) => e.type !== 'dismiss').forEach((e) => {
    const k = e.prefs ? e.prefs.kind : isStudyPlace(e.place) ? 'study' : 'parks';
    kinds[k] = (kinds[k] || 0) + 1;
    if (e.prefs && e.prefs.mode) modes[e.prefs.mode] = (modes[e.prefs.mode] || 0) + 1;
    (e.place ? e.place.environment : e.prefs && e.prefs.kind === 'parks' ? [e.prefs.environment] : [])
      .forEach((t) => { if (ENVIRONMENTS[t]) env[t] = (env[t] || 0) + 1; });
  });
  const taste = [];
  const kindTop = topOf(kinds);
  if (kindTop) taste.push(`${kindTop.key === 'study' ? 'Study spots' : 'Parks'} ${Math.round(kindTop.share * 100)}% of the time`);
  const modeTop = topOf(modes);
  if (modeTop && CONFIG.MODES[modeTop.key]) taste.push(`usually ${CONFIG.MODES[modeTop.key].by}`);
  const likes = Object.entries(env).sort((a, b) => b[1] - a[1]).slice(0, 2).map(([k]) => ENVIRONMENTS[k].label.toLowerCase());
  if (likes.length) taste.push(`likes ${listText(likes)}`);

  const since = data.since ? ` since ${new Date(data.since).toLocaleDateString([], { month: 'short', day: 'numeric' })}` : '';
  box.innerHTML = `${head}
    ${taste.length ? `<p>${esc(capitalize(taste.join(' · ')))}.</p>` : ''}
    ${patterns.length
      ? `<ul class="agent-patterns">${patterns.join('')}</ul>`
      : '<p class="muted-note">No clear patterns yet. Pick a couple more spots at the same kind of moment and they\'ll show up here.</p>'}
    <p class="agent-meta">Based on ${data.events.length} ${data.events.length === 1 ? 'choice' : 'choices'}${esc(since)}. Stored only on this device.
      ${data.paused ? '<strong>Learning is paused</strong>: Reach still uses what it knows, but won\'t add anything new.' : ''}</p>
    <div class="agent-actions">
      ${toggle}
      <button type="button" class="btn btn-small btn-danger" data-agent="forget">Forget everything</button>
    </div>`;
}

function onAgentPanelClick(e) {
  const btn = e.target.closest('[data-agent]');
  if (!btn) return;
  const data = getAgentData();
  if (btn.dataset.agent === 'pause') {
    saveAgentData({ ...data, paused: !data.paused });
    showToast(data.paused ? 'Reach is learning again' : 'Learning paused');
  } else if (btn.dataset.agent === 'forget') {
    if (!window.confirm('Forget your usual spots and everything Reach has picked up about your breaks? This can\'t be undone.')) return;
    saveAgentData({ events: [], paused: data.paused, since: null });
    showToast('Reach forgot your patterns');
  }
  renderAgentPanel();
}

/* ---------------------------------------------------------------------
   5. HOOKS into app.js
   app.js's top-level functions are globals, and app.js calls them by
   name, so replacing window.<name> with a wrapper changes what app.js
   runs. Each wrapper calls the original.
   --------------------------------------------------------------------- */
const original = { runSearch, mapCardHTML, toggleFavorite, decideSpot, renderScheduleHint, goToBestSpot, renderSchedule, showSpinResult };

let userSearchAt = 0;   // when you last submitted the plan form or the change-plan sheet
let pendingPick = null; // your usual, while the banner's "Let's go" runs its search
let lastPick = null;    // the pick shown in the Plan page banner
let lastSpin = null;    // the wheel's last pick

// Search: apply your usual (the banner's "Let's go"), re-rank by pattern, and remember plans you chose.
window.runSearch = async (formPrefs) => {
  let prefs = formPrefs;
  const pick = pendingPick;
  pendingPick = null;
  if (pick && pick.agent && pick.agent.status === 'ready') {
    prefs = { ...prefs, mode: pick.mode || prefs.mode };
    if (!pick.study) prefs = { ...prefs, activity: pick.activity || prefs.activity, environment: pick.environment || prefs.environment };
    store.set(STORAGE_KEYS.prefs, prefs);
    fillForm($('#plan-form'), prefs);
  }
  const fromForm = Date.now() - userSearchAt < 15000;
  userSearchAt = 0;
  const results = await original.runSearch(prefs);
  rankByPattern(results);
  if (fromForm) agentRecord('search', { prefs: results.prefs, start: results.start });
  return results;
};

document.addEventListener('submit', (e) => {
  if (e.target.id === 'plan-form' || e.target.id === 'sheet-form') userSearchAt = Date.now();
}, true);

// Map card: add the "For you" line under the place's subtitle.
window.mapCardHTML = (fit, i, results) => original.mapCardHTML(fit, i, results)
  .replace(/<p class="mc-sub">[\s\S]*?<\/p>/, (sub) => sub + forYouHTML(fit));

// Saving a place is a (weaker) sign you like it.
window.toggleFavorite = (id) => {
  const added = original.toggleFavorite(id);
  if (added && isFavorite(id)) agentRecordChoice('save', id);
  return added;
};

window.showSpinResult = (place) => {
  lastSpin = place;
  original.showSpinResult(place);
};

// Plan page: adjust the schedule's pick to your usual for today, and show it.
window.decideSpot = (s) => { lastPick = agentAdjust(original.decideSpot(s)); return lastPick; };

window.renderScheduleHint = () => {
  lastPick = null;
  original.renderScheduleHint(); // calls decideSpot -> lastPick
  if (lastPick) decorateScheduleHint(lastPick);
};

window.goToBestSpot = async (pick, btn) => {
  pendingPick = pick;
  userSearchAt = 0; // a suggested plan, not one you typed in
  try {
    return await original.goToBestSpot(pick, btn);
  } finally {
    pendingPick = null;
  }
};

window.renderSchedule = () => {
  original.renderSchedule();
  renderAgentPanel();
};

// Opening directions is the strongest sign of what you like (the link still opens as usual).
document.addEventListener('click', (e) => {
  const less = e.target.closest('[data-less]');
  if (less) {
    agentRecordChoice('dismiss', less.dataset.less);
    less.closest('.for-you').remove();
    showToast('Got it. Reach will suggest that less at times like this.');
    return;
  }
  const link = e.target.closest('a[href^="https://www.google.com/maps/dir/"]');
  if (!link) return;
  if (link.closest('#map-card') && state.results && state.results.fitting[MAP.index]) {
    const fit = state.results.fitting[MAP.index];
    agentRecordChoice('go', fit.place.id, link.closest('.walk-note') && fit.alt ? fit.alt.mode : fit.mode);
  } else if (link.closest('#spin-result') && lastSpin) {
    agentRecordChoice('spin', lastSpin.id);
  } else if (link.closest('.fav-card')) {
    const remove = link.closest('.fav-card').querySelector('[data-remove]');
    if (remove) agentRecord('go', { place: findPlace(remove.dataset.remove) });
  }
});

// Shared with chat.js, and handy in the browser console: ReachAgent.profile(ReachAgent.context())
window.ReachAgent = {
  AGENT, TYPE_PLURALS, data: getAgentData, context: agentContext, profile: agentProfile, match: agentMatch,
  adjust: agentAdjust, record: agentRecord, recordChoice: agentRecordChoice, topOf,
};
})();
