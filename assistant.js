/* =====================================================================
   Reach: assistant.js (add-on)
   "Ask Reach": a chat where you say how you feel ("stressed", "need
   coffee", "I have 30 min") and get one place picked for you.

   Install: load it after app.js and agent.js in index.html
     <script src="assistant.js" defer></script>
   Its ids and classes start with "ask-" so it can sit next to Local Chat (chat.js).

   How it works (all on this device, no AI service, no API key):
     1. Opener: it reads your schedule, tests and usual spots and speaks
        first: "You have a midterm today at 3 PM. Study before, or relax
        after?" / "Your usual on Mondays is ..." / "How are you feeling?"
     2. Understanding: your message is matched against word lists (MOODS,
        ACTIVITY_WORDS, SETTING_WORDS_IN, ...) to get a mood, what you
        want to do, the setting, how you'll travel and how much time.
     3. Planning: anything you didn't say is filled from your schedule
        (free time until the next class), your tests, and what the pattern
        agent knows you like (agent.js).
     4. Search: it runs the app's own search (runSearch), so every pick
        fits your free time, opening hours, sunset and weather, then
        explains the pick in plain words.
   ===================================================================== */
(() => {
'use strict';

if (typeof runSearch !== 'function' || !window.ReachAgent) {
  console.warn('[Reach] assistant.js must load after app.js and agent.js. The chat is off.');
  return;
}
const A = window.ReachAgent;

/* ---------------------------------------------------------------------
   1. WHAT MESSAGES CAN MEAN
   Word lists are checked against your message in lower case.
   --------------------------------------------------------------------- */

// How you feel. The first match sets the tone of the reply; `plan` fills in what you didn't say.
const MOODS = [
  { key: 'after-test', re: /\b(finished|done with|just took|survived|got through)\b.*\b(test|exam|quiz|midterm|final)s?\b|\b(test|exam|quiz|midterm|final)s? (is|are|was|were) (over|done)\b/,
    say: 'Nice work getting through it! Time to recharge.', plan: { kind: 'parks', activity: 'relaxing', environment: 'quiet' } },
  { key: 'stressed', re: /\b(stress(ed|ful)?|anxious|anxiety|overwhelm(ed|ing)?|panick?(ing|ed)?|burn(ed|t) ?out|frazzled|tense|worried|nervous|freaking out)\b/,
    say: "That sounds like a lot. Let's find you somewhere calm.", plan: { kind: 'parks', activity: 'relaxing', environment: 'quiet' } },
  { key: 'tired', re: /\b(tired|sleepy|exhausted|drained|worn out|fatigued|no energy|low energy)\b/,
    say: "Running low? Let's keep it close and easy.", plan: { kind: 'parks', activity: 'relaxing', environment: 'quiet' }, close: true },
  { key: 'sad', re: /\b(sad|down|blue|lonely|upset|bad day|rough day|meh|unmotivated|bummed)\b/,
    say: "Sorry it's a rough one. Some fresh air and a nice view can help.", plan: { kind: 'parks', activity: 'walking', environment: 'scenic' } },
  { key: 'restless', re: /\b(restless|antsy|energetic|full of energy|hyper|pumped|(need|want) to move|stretch my legs|cooped up)\b/,
    say: "Sounds like you need to move. Let's burn some energy.", plan: { kind: 'parks', activity: 'exercise', environment: 'open field' } },
  { key: 'bored', re: /\b(bored|boring|same old|something new|somewhere new|something different|adventure|explore|surprise me)\b/,
    say: "Let's shake things up with somewhere you haven't been.", plan: { kind: 'parks', activity: 'walking', environment: 'scenic' }, explore: true },
  { key: 'happy', re: /\b(happy|amazing|excited|celebrat\w*|awesome|fantastic|great day|good day|feeling (good|great))\b/,
    say: "Love that. Let's make the most of it.", plan: { kind: 'parks', activity: 'picnic', environment: 'scenic' } },
  { key: 'hungry', re: /\b(hungry|starving|lunch|eat|food|snack)\b/,
    say: 'Grab something on the way and have a picnic.', plan: { kind: 'parks', activity: 'picnic', environment: 'open field' } },
];

const FOCUS_WORDS = /\b(study|studying|focus|homework|hw|assignment|essay|exam|test|quiz|midterm|finals?|cram(ming)?|review|project|lab report|work on)\b/;
const PLACE_TYPES_IN = [
  ['cafe', /\b(coffee|caffeine|latte|espresso|cafe|café|cafes|tea|boba|matcha)\b/],
  ['library', /\b(library|libraries)\b/],
];
const PARK_WORDS = /\b(park|parks|outside|outdoors|nature|fresh air|sunshine)\b/;

const ACTIVITY_WORDS = [
  ['hiking',   /\b(hike|hiking|trails?)\b/],
  ['exercise', /\b(run|running|jog|jogging|workout|work out|exercise|gym|bike|biking)\b/],
  ['picnic',   /\bpicnic\b/],
  ['walking',  /\b(walk|walking|stroll)\b(?! there| over)/],
  ['relaxing', /\b(relax|relaxing|chill|unwind|nap|rest|sit|decompress)\b/],
];

// Specific features first, so "quiet spot by the water" searches for water.
const SETTING_WORDS_IN = [
  ['water',      /\b(water|lake|pond|river|creek|fountain)\b/],
  ['garden',     /\b(gardens?|flowers|roses|plants)\b/],
  ['forest',     /\b(trees?|forest|woods|shade|shady)\b/],
  ['scenic',     /\b(views?|scenic|pretty|beautiful|sunset|vista)\b/],
  ['open field', /\b(open|field|lawn|grass|grassy)\b/],
  ['quiet',      /\b(quiet|peaceful|calm|silent|alone|not crowded)\b/],
];

const MODE_WORDS = [
  ['walking', /\b(on foot|walk there|walking distance|walkable)\b/],
  ['driving', /\b(drive|driving|car)\b/],
  ['transit', /\b(bus|transit|train|light rail|vta)\b/],
];

// "I know you like ___"
const LIKE_PHRASES = {
  'quiet': 'quiet places', 'scenic': 'places with a view', 'water': 'spots by the water',
  'forest': 'shady, wooded spots', 'garden': 'gardens', 'open field': 'open, grassy spaces',
};

// "It's quiet too, the way you like it."
const LIKE_SHORT = {
  'quiet': 'quiet', 'scenic': 'scenic', 'water': 'by the water',
  'forest': 'shady', 'garden': 'a garden', 'open field': 'open and grassy',
};

// How much (weighted) history before the chat says "I know you like..." or assumes how you travel.
// Lower than the agent's own bar: these are simple habits, not a full prediction.
const KNOWS = { setting: 1, mode: 0.5 };

const MOOD_CHIPS = ['Stressed', 'Tired', 'Bored', 'Need to study', 'Want to move', 'Surprise me'];

/** "an hour and a half" -> 90, "45 min" -> 45, "2 hrs" -> 120. null if no time is mentioned. */
function parseMinutes(t) {
  if (/\bhalf (an )?hour\b/.test(t)) return 30;
  let m = t.match(/\b(\d{1,3})\s*(m|min|mins|minutes)\b/);
  if (m) return Number(m[1]);
  m = t.match(/\b(\d+(?:\.\d+)?|an?|one|two|three|four)\s*(h|hr|hrs|hour|hours)\b/);
  if (!m) return null;
  const n = { a: 1, an: 1, one: 1, two: 2, three: 3, four: 4 }[m[1]] ?? Number(m[1]);
  return Math.round(n * 60) + (/\band a half\b/.test(t) ? 30 : 0);
}

const firstMatch = (list, t) => (list.find(([, re]) => re.test(t)) || [null])[0];

/** Everything a message says, as an intent object. */
function understand(text) {
  const t = ` ${text.toLowerCase().replace(/[’‘]/g, "'")} `
    .replace(/\bnot (so |very |feeling )?(good|great|happy|ok|okay|well)\b/g, ' down ');
  const mood = MOODS.find((m) => m.re.test(t)) || null;
  const type = firstMatch(PLACE_TYPES_IN, t);
  const focus = !mood || mood.key !== 'after-test' ? FOCUS_WORDS.test(t) : false;
  const minutes = parseMinutes(t);
  const zip = (t.match(/\b(\d{5})\b/) || [])[1] || null;
  const intent = {
    mood, focus, type, zip,
    freeMin: minutes ? clamp(minutes, 10, 720) : null,
    kind: type || focus ? 'study' : PARK_WORDS.test(t) ? 'parks' : null,
    activity: firstMatch(ACTIVITY_WORDS, t),
    environment: firstMatch(SETTING_WORDS_IN, t),
    mode: firstMatch(MODE_WORDS, t),
    close: Boolean((mood && mood.close) || /\b(close|nearby|near me|not far|quick)\b/.test(t)),
    explore: Boolean(mood && mood.explore),
    affirm: /^\s*(y|yes|yeah|yep|yup|sure|ok|okay|sounds good|let'?s go|let'?s do it|do it|please|why not|go)\b/.test(t),
    deny: /^\s*(no|nah|nope|not really|not now|not right now)\b/.test(t),
    next: /\b(something else|another|next one|other|else)\b/.test(t),
    greet: /^\s*(hi|hey|hello|yo|sup|good (morning|afternoon|evening))\b/.test(t),
    thanks: /\b(thanks|thank you|thx|ty)\b/.test(t),
    help: /\b(help|what can you do|how does this work)\b/.test(t),
    usual: /\b(my usual|usually|normally)\b/.test(t),
  };
  intent.planning = Boolean(intent.mood || intent.kind || intent.activity || intent.environment
    || intent.mode || intent.freeMin || intent.close);
  return intent;
}

/* ---------------------------------------------------------------------
   2. CONTEXT: tests, schedule and what you like
   --------------------------------------------------------------------- */
const typeWord = (test) => test.type.toLowerCase();
const article = (word) => (/^[aeiou]/.test(word) ? 'an' : 'a');

/** Minutes a test lasts: its class's length if we know the class, else an hour. */
function testLength(test) {
  const cls = getClasses().find((c) => c.id === test.classId);
  return cls ? hhmmToMin(cls.end) - hhmmToMin(cls.start) : 60;
}

/** Today's tests: the next one that hasn't started, and the last one that's over. */
function testsToday() {
  const n = nowMin();
  const today = getTests().filter((t) => t.date === isoDate()).sort((a, b) => (a.time || '99').localeCompare(b.time || '99'));
  return {
    upcoming: today.find((t) => !t.time || hhmmToMin(t.time) > n) || null,
    done: today.filter((t) => t.time && hhmmToMin(t.time) + testLength(t) <= n).pop() || null,
  };
}

/** The setting most of your picks had (e.g. 'quiet'), once the agent knows you. */
function likedSetting() {
  const prof = A.profile(A.context(), { kind: 'parks' });
  if (prof.evidence < KNOWS.setting || !prof.envWeight) return null;
  const order = Object.keys(LIKE_PHRASES);
  const best = Object.entries(prof.envTags)
    .filter(([k]) => LIKE_PHRASES[k])
    .sort((a, b) => b[1] - a[1] || order.indexOf(a[0]) - order.indexOf(b[0]))[0];
  return best && best[1] / prof.envWeight >= 0.5 ? best[0] : null;
}

/** How you usually get to this kind of place, once the agent knows. */
function usualMode(kind) {
  const prof = A.profile(A.context(), { kind });
  const top = prof.evidence >= KNOWS.mode ? A.topOf(prof.mode) : null;
  return top && top.share >= 0.5 && CONFIG.MODES[top.key] ? top.key : null;
}

const stayFor = (freeMin, study) => Math.max(10, Math.min(study ? 90 : 30, Math.floor((freeMin * (study ? 0.6 : 0.4)) / 5) * 5));

/** Turn an intent into search prefs, filling the gaps from your schedule and your usual. */
function makePlan(intent, extra = {}) {
  const s = scheduleStatus();
  const base = decideSpot(s); // the schedule's pick, adjusted to your usual for today (agent.js)
  const saved = { ...DEFAULT_PREFS, ...store.get(STORAGE_KEYS.prefs, {}) };
  const mood = intent.mood;
  // Asking for a mood, an activity or a setting means a park; otherwise follow the schedule (a test -> study).
  const parkish = mood || intent.activity || intent.environment || intent.explore;
  const study = intent.kind ? intent.kind === 'study' : parkish ? false : base.study;

  // Setting: what you asked for > what you usually like > the mood's default > your usual.
  const liked = study ? null : likedSetting();
  let environment = intent.environment;
  let envFrom = 'asked';
  if (!environment && liked) { environment = liked; envFrom = 'liked'; }
  if (!environment && mood) { environment = mood.plan.environment; envFrom = 'mood'; }
  if (!environment) { environment = base.environment || saved.environment; envFrom = 'usual'; }

  let freeMin = extra.freeMin || intent.freeMin || base.freeMin;
  if (extra.before) freeMin = Math.min(freeMin, extra.before - nowMin() - 10); // back 10 min before a test
  const sameAsBase = !intent.freeMin && !extra.freeMin && !extra.before && study === base.study;
  const stayMin = sameAsBase ? base.stayMin : stayFor(freeMin, study);
  const when = extra.when || (intent.freeMin ? 'now' : base.when);

  return {
    prefs: {
      ...saved,
      kind: study ? 'study' : 'parks',
      activity: study ? 'studying' : intent.activity || (mood && mood.plan.activity) || base.activity || 'relaxing',
      environment: study ? 'quiet' : environment,
      mode: intent.mode || usualMode(study ? 'study' : 'parks') || saved.mode,
      time: 'custom', customMinutes: String(freeMin), freeMin,
      stay: 'custom', stayCustom: String(stayMin), wantStayMin: stayMin,
      when, laterTime: extra.laterTime || (when === 'later' ? base.laterTime : ''),
    },
    intent, envFrom, freeMin,
    type: intent.type,
    explore: intent.explore || Boolean(extra.explore),
    close: intent.close,
    note: extra.note || '',
    tooShort: freeMin < 15,
  };
}

/* ---------------------------------------------------------------------
   3. CONVERSATION
   --------------------------------------------------------------------- */
const chat = {
  open: false,
  busy: false,
  pending: null,     // what "yes" does after the bot asks a question
  results: null,     // the search behind the current suggestions
  sets: [],          // every search the chat ran, so older place cards keep working
  options: [],       // places that fit, best first
  index: 0,          // which option is showing
  plan: null,
  lastActive: 0,
  afterZip: null,    // a plan waiting for your ZIP code
};

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/** The bot speaks first, from your schedule, tests and usual. */
function opener() {
  const s = scheduleStatus();
  const { upcoming, done } = testsToday();
  const liked = likedSetting();

  if (upcoming) {
    const w = typeWord(upcoming);
    const at = upcoming.time ? ` at ${fmtClock(upcoming.time)}` : '';
    const chips = [{ label: 'Study before', run: () => planAndSuggest(understand('study'), upcoming.time ? { before: hhmmToMin(upcoming.time) } : {}) }];
    if (upcoming.time) chips.push({ label: 'Relax after', run: () => relaxAfterTest(upcoming) });
    else chips.push({ label: 'Somewhere relaxing', run: () => planAndSuggest(understand('relax')) });
    return say(`I see you have ${article(w)} ${w} for ${className(upcoming.classId)} today${at}. Want to get some studying in before it, or go somewhere relaxing after?`, { chips });
  }
  if (done) {
    const w = typeWord(done);
    chat.pending = () => planAndSuggest(understand("I'm done with my test"));
    return say(`Your ${w} for ${className(done.classId)} is over. Nice work! How about somewhere relaxing to recharge?${liked ? ` I know you like ${LIKE_PHRASES[liked]}.` : ''}`,
      { chips: [{ label: "Yes, let's go", run: chat.pending }, ...moodChips().slice(0, 3)] });
  }
  const test = soonTest();
  if (test) {
    const w = typeWord(test);
    const days = daysUntil(test.date);
    chat.pending = () => planAndSuggest(understand('study'));
    return say(`You have ${article(w)} ${w} for ${className(test.classId)} ${days === 1 ? 'tomorrow' : `in ${days} days`}. Want to find a quiet spot to study?`,
      { chips: [{ label: "Yes, let's study", run: chat.pending }, { label: 'Not right now', run: () => howAreYou() }] });
  }
  const pick = decideSpot(s);
  if (pick.agent && pick.agent.status === 'ready' && pick.freeMin >= 15) {
    const days = `${DAY_NAMES[pick.agent.day]}s`;
    const usual = pick.agent.usual ? `Your usual on ${days} is ${pick.agent.usual.name}.` : `Your usual is going to ${pick.agent.plural} on ${days}.`;
    chat.pending = () => planAndSuggest(understand(''), { note: 'usual' });
    return say(`${usual} Want to go there today?`,
      { chips: [{ label: "Yes, let's go", run: chat.pending }, { label: 'Something different', run: () => planAndSuggest(understand('something different')) }] });
  }
  return howAreYou(s);
}

function howAreYou(s = scheduleStatus()) {
  chat.pending = null;
  let text = "Hi! How are you feeling? Tell me and I'll find a spot that fits your free time.";
  if (s.current) text = `You're in ${s.current.name} until ${fmtClock(s.current.end)}. How are you feeling? I can line something up for after.`;
  else if (s.next && s.freeMin >= 15) text = `You're free for ${fmtDuration(s.freeMin)}, until ${s.next.name} at ${fmtClock(s.next.start)}. How are you feeling?`;
  return say(text, { chips: moodChips() });
}

const moodChips = () => MOOD_CHIPS.map((label) => ({ label }));

/** "Relax after": the window starts when the test ends and runs to your next class. */
function relaxAfterTest(test) {
  const start = hhmmToMin(test.time) + testLength(test);
  const day = DAY_KEYS[new Date().getDay()];
  const next = getClasses().filter((c) => c.days.includes(day) && hhmmToMin(c.start) >= start)
    .sort((a, b) => hhmmToMin(a.start) - hhmmToMin(b.start))[0];
  const freeMin = next ? Math.min(720, hhmmToMin(next.start) - start - 5) : 90;
  const laterTime = `${pad2(Math.floor(start / 60) % 24)}:${pad2(start % 60)}`;
  if (freeMin < 15) return say(`Your next class starts right after the ${typeWord(test)}, so there's no time for a trip. Good luck!`);
  return planAndSuggest(understand('relax'), {
    when: 'later', laterTime, freeMin,
    note: `After your ${typeWord(test)} ends around ${fmtClock(laterTime)}, you'll have ${fmtDuration(freeMin)}${next ? ` before ${next.name}` : ''}.`,
  });
}

/** Read a message and reply. */
async function onMessage(text) {
  const intent = understand(text);
  const needZip = locationState.status !== 'ok';

  if (intent.zip && needZip) {
    store.set(STORAGE_KEYS.prefs, { ...store.get(STORAGE_KEYS.prefs, {}), zip: intent.zip });
    $('#zip').value = intent.zip;
    if (chat.afterZip) { const plan = chat.afterZip; chat.afterZip = null; plan.prefs.zip = intent.zip; return suggest(plan); }
    return say(`Got it, I'll start from ${intent.zip}. How are you feeling?`, { chips: moodChips() });
  }
  if (intent.affirm && chat.pending) { const run = chat.pending; chat.pending = null; return run(); }
  if (intent.deny && !intent.planning) return howAreYou();
  if (intent.next && chat.options.length && !intent.planning) return showOption(chat.index + 1);
  if (intent.help) {
    return say("Tell me how you're feeling or what you want to do, like \"stressed\", \"need coffee\", \"somewhere quiet by the water\" or \"I have 30 min\". I'll check your schedule, tests and the places you usually like, and pick somewhere that fits.", { chips: moodChips() });
  }
  if (intent.usual && !intent.planning) {
    const pick = decideSpot();
    if (pick.agent && pick.agent.status === 'ready') {
      chat.pending = () => planAndSuggest(understand(''), { note: 'usual' });
      const days = `${DAY_NAMES[pick.agent.day]}s`;
      return say(`${pick.agent.usual ? `Your usual on ${days} is ${pick.agent.usual.name}.` : `Your usual is going to ${pick.agent.plural} on ${days}.`} Want to go there?`,
        { chips: [{ label: "Yes, let's go", run: chat.pending }] });
    }
    return say("I don't know your usual for today yet. Pick a few spots on this day of the week and I'll learn it.", { chips: moodChips() });
  }
  // "I'll drive", "I have 2 hrs", "somewhere closer": change the last plan instead of starting over.
  const tweakOnly = !intent.mood && !intent.kind && !intent.focus && !intent.activity && !intent.environment;
  if (intent.planning && tweakOnly && chat.plan) {
    const prev = chat.plan.intent;
    return planAndSuggest({
      ...prev,
      freeMin: intent.freeMin || prev.freeMin,
      mode: intent.mode || prev.mode,
      close: intent.close || prev.close,
    });
  }
  if (intent.planning || intent.focus) return planAndSuggest(intent);
  if (intent.thanks) return say('Anytime! Enjoy your break.');
  if (intent.greet) return opener();
  return say("I didn't quite catch that. Tell me how you're feeling (stressed, tired, bored...) or what you want to do (study, walk, picnic).", { chips: moodChips() });
}

async function planAndSuggest(intent, extra) {
  return suggest(makePlan(intent, extra));
}

/** Run the search for a plan and suggest the best place. */
async function suggest(plan) {
  chat.pending = null;
  chat.plan = plan;
  const p = plan.prefs;
  if (plan.tooShort) {
    const s = scheduleStatus();
    return say(`You only have ${fmtDuration(Math.max(0, plan.freeMin))}${s.next ? ` before ${s.next.name}` : ''}, which isn't enough for a trip. How much time do you have?`,
      { chips: [{ label: 'I have 1 hr' }, { label: 'I have 2 hrs' }] });
  }

  // Starting point: your location, or a ZIP code.
  if (locationState.status === 'pending') await Promise.race([locationState.promise, wait(6000)]);
  if (locationState.status === 'ok') p.origin = 'location';
  else if (/^\d{5}$/.test(p.zip || '')) p.origin = 'zip';
  else {
    chat.afterZip = plan;
    return say("Where are you starting from? Location access is off, so type your 5-digit ZIP code.");
  }

  const typing = showTyping();
  let results;
  try {
    [results] = await Promise.all([runSearch(p), wait(500)]);
  } catch (err) {
    typing.remove();
    if (!(err instanceof SearchError)) console.error(err);
    return say(err instanceof SearchError ? err.message : "Something went wrong while searching. Try again in a moment.");
  }
  typing.remove();
  A.record('search', { prefs: results.prefs, start: results.start });
  store.set(STORAGE_KEYS.prefs, p);
  fillForm($('#plan-form'), p);

  chat.results = results;
  chat.sets.push(results);
  chat.options = rankOptions(results.fitting, plan);
  if (!chat.options.length) return nothingFits(plan, results);
  return showOption(0);
}

/** Order the places that fit for this plan: a type you asked for, somewhere new, or close by. */
function rankOptions(fitting, plan) {
  let list = fitting.slice();
  if (plan.type) {
    const ofType = list.filter((f) => f.place.type === plan.type);
    plan.typeMissing = !ofType.length;
    if (ofType.length) list = ofType;
  }
  const prof = A.profile(A.context());
  const reorder = (group) => {
    let g = group;
    if (plan.explore) g = [...g.filter((f) => !prof.places[f.place.id]), ...g.filter((f) => prof.places[f.place.id])];
    if (plan.close) g = [...g.slice(0, 5).sort((a, b) => a.travel.thereMin - b.travel.thereMin), ...g.slice(5)];
    return g;
  };
  // Places with enough time stay ahead of ones that are a bit short.
  return [...reorder(list.filter((f) => f.verdict === 'fits')), ...reorder(list.filter((f) => f.verdict !== 'fits'))];
}

/** "It's 14 min by car, and you'll have 46 min there." */
function tripText(fit) {
  const mode = CONFIG.MODES[fit.mode || chat.results.prefs.mode];
  const short = fit.verdict === 'short' ? `, a bit less than the ${fmtDuration(fit.wantStayMin)} you wanted` : '';
  return `It's ${fmtDuration(fit.travel.thereMin)} ${mode.by}, and you'll have ${fmtDuration(fit.onSiteMin)} there${short}.`;
}

/** Why this place: your history, your taste, or something new. */
function whyText(fit, plan) {
  const { place } = fit;
  const name = place.name;
  const prof = A.profile(A.context());
  const been = prof.places[place.id];
  const env = plan.prefs.environment;
  const likedHere = plan.envFrom === 'liked' && place.environment.includes(env);
  if (plan.note === 'usual' && been) return `${name} it is, your usual.`;
  if (plan.explore && !been) return `You haven't been to ${name} yet. I think you'd like it.`;
  if (been && been.count >= 2) {
    return likedHere
      ? `I know you like ${LIKE_PHRASES[env]}, and ${name} is one of your regulars.`
      : `${name} is one of your regulars, so it's a safe bet.`;
  }
  if (likedHere) return `I know you like ${LIKE_PHRASES[env]}, so I'd go to ${name}.`;
  if (plan.envFrom === 'asked' && ENVIRONMENTS[env] && place.environment.includes(env)) return `${name} has what you asked for: ${ENVIRONMENTS[env].match.toLowerCase().replace(/\.$/, '')}.`;
  return `I'd go to ${name}.`;
}

/** Show suggestion i, with the reasons and a place card. */
function showOption(i) {
  const { options, plan, results } = chat;
  if (i >= options.length) {
    return say("That's everything that fits right now. Want to change something? More time or a different way to get there opens up more places.",
      { chips: [{ label: 'I have 2 hrs' }, { label: "I'll drive" }] });
  }
  chat.index = i;
  const fit = options[i];
  const intro = []; // how you're doing and how much time you have
  const lines = []; // where to go
  if (i === 0) {
    if (plan.intent.mood) intro.push(plan.intent.mood.say);
    else if (plan.type === 'cafe' && !plan.typeMissing) intro.push('Coffee it is.');
    if (!plan.intent.mood && plan.prefs.kind === 'study') {
      const test = soonTest();
      intro.push(test ? `Let's get some review in for your ${typeWord(test)} in ${className(test.classId)}.` : "Let's get you somewhere you can focus.");
    }
    const s = scheduleStatus();
    if (plan.note && plan.note !== 'usual') intro.push(plan.note);
    else if (plan.prefs.when === 'later' && s.current) intro.push(`Once ${s.current.name} ends, you'll have ${fmtDuration(plan.freeMin)}.`);
    else if (s.next && !plan.intent.freeMin) intro.push(`You've got ${fmtDuration(plan.freeMin)} before ${s.next.name}, so this gets you back in time.`);
    if (plan.typeMissing) intro.push(`I couldn't find ${A.TYPE_PLURALS[plan.type]} that fit, so here's the best study spot instead.`);
    lines.push(whyText(fit, plan));
  } else {
    lines.push(`How about ${fit.place.name} instead?`);
    const env = plan.prefs.environment;
    if (plan.envFrom === 'liked' && fit.place.environment.includes(env)) lines.push(`It's ${LIKE_SHORT[env]} too, the way you like it.`);
  }
  lines.push(tripText(fit));
  fit.notes.forEach((n) => lines.push(`${n}.`));
  const wx = results.wx;
  if (wx.available && (wx.flags.rain || wx.flags.storm) && !isStudyPlace(fit.place)) lines.push('Heads up: rain is likely, so bring a jacket.');
  $$('#ask-log [data-ask-next]').forEach((b) => b.remove()); // only the newest card offers "Something else"
  return say([intro.join(' '), lines.join(' ')], { card: fit });
}

function nothingFits(plan, results) {
  // Study spots only come from the live place search; curated picks are all parks.
  if (plan.prefs.kind === 'study' && ['offline', 'nokey', 'badkey'].includes(results.live.status)) {
    return say("I can't look up libraries and cafes right now because the place search isn't reachable. Want a quiet park instead?",
      { chips: [{ label: 'Yes, a quiet park', run: () => planAndSuggest(understand('somewhere quiet outside')) }] });
  }
  const by = CONFIG.MODES[plan.prefs.mode].by;
  const chips = [{ label: 'I have 2 hrs' }];
  if (plan.prefs.mode === 'walking') chips.push({ label: "I'll drive" });
  return say(`Nothing fits in ${fmtDuration(plan.freeMin)} ${by} right now. ${results.start > addMin(results.sun.sunset, -30) ? 'Most parks close around sunset. ' : ''}More time or a faster way to get there would open up more places.`, { chips });
}

/* ---------------------------------------------------------------------
   4. RENDERING
   --------------------------------------------------------------------- */
const CHAT_ICON = '<svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-4.9A8 8 0 1 1 21 12z"/></svg>';
const SEND_ICON = '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12h13M13 6l6 6-6 6"/></svg>';
const LEAF_MARK = '<svg class="brand-mark ask-avatar" viewBox="0 0 64 64" aria-hidden="true"><circle cx="32" cy="32" r="30"/><path class="leaf" d="M20 44c0-14 10-24 26-26-2 16-12 26-26 26z"/><path class="vein" d="M20 44l14-14"/></svg>';

function buildChat() {
  document.body.insertAdjacentHTML('beforeend', `
    <button type="button" class="ask-fab" id="ask-fab" aria-haspopup="dialog" aria-controls="ask-panel" aria-expanded="false">
      ${CHAT_ICON}<span>Ask Reach</span>
    </button>
    <section class="ask-panel" id="ask-panel" role="dialog" aria-labelledby="ask-title" hidden>
      <header class="ask-head">
        ${LEAF_MARK}
        <div class="ask-head-text">
          <h2 id="ask-title">Ask Reach</h2>
          <p>Tell me how you're feeling</p>
        </div>
        <button type="button" class="ask-close" id="ask-close" aria-label="Close chat">
          <svg viewBox="0 0 24 24" width="22" height="22" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>
        </button>
      </header>
      <div class="ask-log" id="ask-log" aria-live="polite"></div>
      <div class="ask-chips" id="ask-chips"></div>
      <form class="ask-form" id="ask-form" autocomplete="off">
        <label class="sr-only" for="ask-input">Message</label>
        <input type="text" id="ask-input" maxlength="200" placeholder="How are you feeling?" enterkeyhint="send">
        <button type="submit" class="ask-send" aria-label="Send">${SEND_ICON}</button>
      </form>
    </section>`);

  $('#ask-fab').addEventListener('click', openChat);
  $('#ask-close').addEventListener('click', closeChat);
  $('#ask-panel').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeChat(); });
  $('#ask-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#ask-input');
    const text = input.value.trim();
    if (!text || chat.busy) return;
    input.value = '';
    send(text);
  });
  $('#ask-chips').addEventListener('click', (e) => {
    const chip = e.target.closest('[data-chip]');
    if (chip && !chat.busy) send(chip.textContent, chat.chipActions[Number(chip.dataset.chip)]);
  });
  $('#ask-log').addEventListener('click', onCardClick);
}

/** Show your message, then run what it asks for (a chip's own action, or reading the text). */
async function send(text, run) {
  chat.lastActive = Date.now();
  addBubble('user', `<p>${esc(text)}</p>`);
  setChips([]);
  chat.busy = true;
  try {
    await (run ? run() : onMessage(text));
  } finally {
    chat.busy = false;
  }
}

/** A bot message (a string, or an array of paragraphs), with optional quick replies and a place card. */
function say(text, { chips = [], card = null } = {}) {
  const paras = [].concat(text).filter(Boolean).map((t) => `<p>${esc(t)}</p>`).join('');
  addBubble('bot', `${paras}${card ? cardHTML(card) : ''}`);
  setChips(chips);
}

function addBubble(who, html) {
  const log = $('#ask-log');
  log.insertAdjacentHTML('beforeend', `<div class="ask-msg ask-${who}">${html}</div>`);
  log.scrollTop = log.scrollHeight;
}

function showTyping() {
  const log = $('#ask-log');
  log.insertAdjacentHTML('beforeend', '<div class="ask-msg ask-bot ask-typing" aria-label="Reach is typing"><span></span><span></span><span></span></div>');
  log.scrollTop = log.scrollHeight;
  return log.lastElementChild;
}

function setChips(chips) {
  chat.chipActions = chips.map((c) => c.run || null);
  $('#ask-chips').innerHTML = chips.map((c, i) => `<button type="button" class="ask-chip" data-chip="${i}">${esc(c.label)}</button>`).join('');
}

function cardHTML(fit) {
  const { place } = fit;
  const modeKey = fit.mode || chat.results.prefs.mode;
  const mode = CONFIG.MODES[modeKey];
  const meta = [place.kindLabel || TYPE_LABELS[place.type] || place.type, `${fmtDuration(fit.travel.thereMin)} ${mode.by}`, `${fmtDuration(fit.onSiteMin)} there`];
  return `<div class="ask-place">
      <p class="ask-place-name">${esc(place.name)}</p>
      <p class="ask-place-meta">${esc(meta.join(' · '))}</p>
      <div class="ask-place-actions" data-set="${chat.sets.length - 1}">
        <a class="btn btn-small btn-primary" href="${esc(directionsUrl(place, modeKey, chat.results.origin))}" target="_blank" rel="noopener"
           data-ask-go="${esc(place.id)}" data-ask-mode="${esc(modeKey)}">Directions</a>
        <button type="button" class="btn btn-small" data-ask-map="${esc(place.id)}">Show on map</button>
        <button type="button" class="btn btn-small" data-ask-next>Something else</button>
      </div>
    </div>`;
}

function onCardClick(e) {
  const actions = e.target.closest('[data-set]');
  const set = actions ? chat.sets[Number(actions.dataset.set)] : null;
  const go = e.target.closest('[data-ask-go]');
  if (go && set) {
    // Opening directions is the strongest sign of what you like.
    const fit = set.fitting.find((f) => f.place.id === go.dataset.askGo);
    const current = state.results;
    state.results = set;
    A.recordChoice('go', go.dataset.askGo, go.dataset.askMode);
    state.results = current;
    if (fit) showToast(`Have fun at ${fit.place.name}!`);
    return;
  }
  const map = e.target.closest('[data-ask-map]');
  if (map && set) {
    // Put this place first, then open the results map on it.
    const r = set;
    const i = r.fitting.findIndex((f) => f.place.id === map.dataset.askMap);
    if (i > 0) r.fitting.unshift(...r.fitting.splice(i, 1));
    state.results = r;
    closeChat();
    if (location.hash === '#/results') route(); else location.hash = '#/results';
    return;
  }
  if (e.target.closest('[data-ask-next]') && !chat.busy) send('Something else', () => showOption(chat.index + 1));
}

function openChat() {
  document.dispatchEvent(new CustomEvent('reach:assistant-open')); // closes Local Chat if it's open
  const panel = $('#ask-panel');
  panel.hidden = false;
  requestAnimationFrame(() => panel.classList.add('open'));
  $('#ask-fab').setAttribute('aria-expanded', 'true');
  document.body.classList.add('ask-open');
  // Start (or restart after a while away) with what's going on today.
  if (!chat.lastActive || Date.now() - chat.lastActive > 20 * 60000) {
    if (chat.lastActive) addBubble('divider', `<p>${esc(fmtTime(new Date()))}</p>`);
    opener();
  }
  chat.lastActive = Date.now();
  // Phones: don't pop the keyboard over the opener and its quick replies.
  if (window.matchMedia && window.matchMedia('(pointer: fine)').matches) $('#ask-input').focus({ preventScroll: true });
  else $('#ask-close').focus({ preventScroll: true });
}

function closeChat({ focus = true } = {}) {
  const panel = $('#ask-panel');
  panel.classList.remove('open');
  $('#ask-fab').setAttribute('aria-expanded', 'false');
  document.body.classList.remove('ask-open');
  const done = () => { panel.hidden = true; };
  if (prefersReducedMotion()) done(); else setTimeout(done, 200);
  if (focus) $('#ask-fab').focus({ preventScroll: true });
}

// Only one chat open at a time: Local Chat says when it opens.
document.addEventListener('reach:localchat-open', () => { if (!$('#ask-panel').hidden) closeChat({ focus: false }); });

document.addEventListener('DOMContentLoaded', buildChat);

// For quick checks in the browser console: ReachChat.understand("stressed and need coffee")
window.ReachChat = { understand, makePlan, open: openChat, close: closeChat };
})();
