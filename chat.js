/* =====================================================================
   Reach Local Chat: chat.js (loaded after app.js)

   A public group chat for each place on the results map. Tap a pin, then
   "Chat" on its card, to join that place's room; everyone who opens the same
   place lands in the same room. Chat only exists in the map view, where its
   button sits next to Ask Reach's, beside the zoom buttons:
     - not in a room: the button opens a list of the places on the map to pick from
     - minimize: the chat shrinks back into the button, which then shows the
       place's name and unread messages (you stay in the room)
     - close (×): leaves the room
   Leaving the map minimizes it. Backend: Supabase (Postgres + Realtime + Presence),
   with anonymous sign-in so nobody needs an account. Setup: README > Local Chat,
   and supabase/chat.sql for the database.

   Privacy: no location is used. A room is named after the place you picked
   (e.g. "place-guadalupe-river-park-1x2y3z"), and that's all the server sees.

   Sections: config · DOM · rooms · connection · messages · sending ·
             moderation · screens · panel state · map card button · init
   Reuses from app.js: store, state, findPlace, hashString, mapCardHTML, esc,
   fmtDuration, CONFIG, TYPE_LABELS, showRecommendation, showToast.
   ===================================================================== */
(() => {
  'use strict';

  /* ---------- Config ---------- */
  const cfg = window.GREENESCAPE_CONFIG || {};
  const CHAT = {
    url: (cfg.SUPABASE_URL || '').trim(),
    key: (cfg.SUPABASE_ANON_KEY || '').trim(),
    historyLimit: 100,     // messages loaded when you join a room
    maxBody: 500,          // same limits as supabase/chat.sql
    nameMin: 2, nameMax: 24,
    cooldownMs: 1500,      // client-side pause between sends (the server enforces its own limits)
    nearBottomPx: 80,      // auto-scroll only if you're already this close to the latest message
  };
  const KEYS = {
    name: 'reach.chat.name',
    room: 'reach.chat.room',          // { slug, name } of the last room you joined
    lastRead: 'reach.chat.lastRead.', // + room slug -> last message id you've seen
  };
  const validRoom = (r) => (r && r.slug && r.name ? r : null);
  const configured = Boolean(CHAT.url && CHAT.key && window.supabase && window.supabase.createClient);

  const chat = {
    client: null, user: null, channel: null,
    room: validRoom(store.get(KEYS.room, null)), // rooms saved before per-place chat have no name: dropped
    name: store.get(KEYS.name, ''),
    messages: new Map(), // id -> message row
    open: false,
    unread: 0, online: 0,
    isMod: false, banned: false,
    lastSentAt: 0, sending: false,
    status: 'idle', // idle | connecting | live | offline
  };

  /* ---------- DOM ---------- */
  const ICONS = {
    chat: '<svg viewBox="0 0 24 24" width="26" height="26" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 5.5A2.5 2.5 0 0 1 6.5 3h11A2.5 2.5 0 0 1 20 5.5v8a2.5 2.5 0 0 1-2.5 2.5H10l-4.2 3.6a.5.5 0 0 1-.8-.4V16h0a2.5 2.5 0 0 1-1-2V5.5z"/><path d="M8 8.5h8M8 12h5"/></svg>',
    min: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 12h12"/></svg>',
    close: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"><path d="M6 6l12 12M18 6L6 18"/></svg>',
    more: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="currentColor"><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/></svg>',
    send: '<svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 12l16-8-6 16-2.5-6.5L4 12z"/></svg>',
  };

  const root = document.createElement('div');
  root.className = 'chat-root';
  root.innerHTML = `
    <button type="button" class="chat-fab" id="chat-fab" aria-controls="chat-panel" aria-expanded="false" aria-label="Open Reach Local Chat">
      ${ICONS.chat}
      <span class="chat-fab-label" id="chat-fab-label" hidden></span>
      <span class="chat-badge" id="chat-fab-badge" hidden></span>
    </button>
    <section class="chat-panel" id="chat-panel" role="dialog" aria-labelledby="chat-title" hidden>
      <header class="chat-head">
        <div class="chat-head-main">
          <span class="chat-title" id="chat-title">Reach Local Chat</span>
          <span class="chat-sub">
            <span id="chat-room-name">Choose a place</span>
            <span class="chat-online" id="chat-online" hidden><span class="chat-dot" aria-hidden="true"></span><span id="chat-online-count"></span></span>
          </span>
        </div>
        <button type="button" class="chat-icon-btn" id="chat-menu-btn" aria-label="Chat options" aria-expanded="false" aria-controls="chat-menu">${ICONS.more}</button>
        <button type="button" class="chat-icon-btn" id="chat-min-btn" aria-label="Minimize chat">${ICONS.min}</button>
        <button type="button" class="chat-icon-btn" id="chat-close-btn" aria-label="Leave chat" title="Leave chat">${ICONS.close}</button>
      </header>
      <div class="chat-menu" id="chat-menu" role="menu" hidden>
        <button type="button" role="menuitem" data-chat-action="places">Chat about another place</button>
        <button type="button" role="menuitem" data-chat-action="rename">Change my name</button>
        <button type="button" role="menuitem" data-chat-action="guidelines">Community guidelines</button>
        <button type="button" role="menuitem" data-chat-action="copy-id">Copy my chat ID</button>
      </div>
      <div class="chat-status" id="chat-status" role="status" aria-live="polite" hidden></div>
      <div class="chat-body" id="chat-body">
        <ol class="chat-list" id="chat-list" aria-label="Messages" aria-live="polite"></ol>
        <button type="button" class="chat-jump" id="chat-jump" hidden>New messages ↓</button>
      </div>
      <form class="chat-compose" id="chat-compose" novalidate hidden>
        <label for="chat-input" class="sr-only">Message</label>
        <textarea id="chat-input" rows="1" maxlength="${CHAT.maxBody}" placeholder="Write a message…" autocomplete="off" enterkeyhint="send"></textarea>
        <button type="submit" class="chat-send" id="chat-send" aria-label="Send message">${ICONS.send}</button>
      </form>
      <p class="chat-error" id="chat-error" role="alert" hidden></p>
    </section>`;
  document.body.appendChild(root);

  // One row for the floating buttons: Ask Reach's (moved in once assistant.js builds it) and this one,
  // so the two can never overlap. Positioned in chat.css; the chat button only shows on the map.
  const dock = document.createElement('div');
  dock.className = 'fab-dock';
  document.body.appendChild(dock);
  dock.append(root.querySelector('#chat-fab'));
  // assistant.js loads first, so its DOMContentLoaded handler (which builds #ask-fab) has already run.
  document.addEventListener('DOMContentLoaded', () => {
    const ask = document.getElementById('ask-fab');
    if (ask) dock.prepend(ask);
  });

  const $c = (sel) => root.querySelector(sel);
  const el = {
    fab: dock.querySelector('#chat-fab'), fabLabel: dock.querySelector('#chat-fab-label'), fabBadge: dock.querySelector('#chat-fab-badge'),
    panel: $c('#chat-panel'),
    roomName: $c('#chat-room-name'), online: $c('#chat-online'), onlineCount: $c('#chat-online-count'),
    menuBtn: $c('#chat-menu-btn'), menu: $c('#chat-menu'), minBtn: $c('#chat-min-btn'), closeBtn: $c('#chat-close-btn'),
    status: $c('#chat-status'), body: $c('#chat-body'), list: $c('#chat-list'), jump: $c('#chat-jump'),
    compose: $c('#chat-compose'), input: $c('#chat-input'), send: $c('#chat-send'), error: $c('#chat-error'),
  };

  /** Small element builder; text always goes in as textContent (never HTML). */
  function h(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') node.className = v;
      else if (k === 'text') node.textContent = v;
      else node.setAttribute(k, v === true ? '' : v);
    }
    children.flat().forEach((c) => c != null && node.append(c));
    return node;
  }

  /* ---------- Rooms: one per place ---------- */
  const slugify = (text) => text.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

  /** Place -> { slug, name }. The slug mixes a readable name with a hash of the place id, so two
      parks with the same name get different rooms. It matches the room rule in supabase/chat.sql. */
  function roomForPlace(place) {
    const base = slugify(place.name).slice(0, 50) || 'place';
    return { slug: `place-${base}-${hashString(place.id).toString(36)}`, name: place.name };
  }

  /* ---------- Connection ---------- */
  function getClient() {
    if (!chat.client) {
      chat.client = window.supabase.createClient(CHAT.url, CHAT.key, {
        auth: { persistSession: true, autoRefreshToken: true, storageKey: 'reach.chat.auth' },
        realtime: { params: { eventsPerSecond: 5 } },
      });
    }
    return chat.client;
  }

  /** Reuses this browser's anonymous chat identity, or creates one if `create`. */
  async function ensureUser(create) {
    const client = getClient();
    const { data } = await client.auth.getSession();
    if (data.session) {
      // supabase-js only passes the token to Realtime on sign-in/refresh, not for a restored
      // session, and the RLS policies need it to deliver live messages.
      client.realtime.setAuth(data.session.access_token);
      chat.user = data.session.user;
      return chat.user;
    }
    if (!create) return null;
    const res = await client.auth.signInAnonymously();
    if (res.error) {
      throw new Error(/anonymous/i.test(res.error.message)
        ? 'Local Chat sign-in is turned off. The site owner needs to enable Anonymous sign-ins in Supabase.'
        : `Couldn't connect to Local Chat (${res.error.message}).`);
    }
    chat.user = res.data.user;
    return chat.user;
  }

  async function loadRoles() {
    const client = getClient();
    const uid = chat.user.id;
    const [mod, ban] = await Promise.all([
      client.from('chat_moderators').select('user_id').eq('user_id', uid).maybeSingle(),
      client.from('chat_bans').select('user_id').eq('user_id', uid).maybeSingle(),
    ]);
    chat.isMod = Boolean(mod.data);
    chat.banned = Boolean(ban.data);
  }

  async function connect(room) {
    chat.room = room;
    store.set(KEYS.room, room);
    chat.messages.clear();
    chat.unread = 0;
    renderBadges();
    el.list.replaceChildren();
    renderHeader();
    renderPanel();
    setStatus('connecting', 'Connecting…');
    showComposer(true);
    await disconnect();

    try {
      await ensureUser(true);
      await loadRoles();
    } catch (err) {
      setStatus('offline', err.message);
      return;
    }
    renderComposerState();

    const client = getClient();
    const channel = client.channel(`room:${room.slug}`, { config: { presence: { key: chat.user.id } } });
    chat.channel = channel;
    channel
      .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages', filter: `room=eq.${room.slug}` },
        (payload) => { if (channel === chat.channel) addMessages([payload.new], { live: true }); })
      // Deletes can't be filtered by room in Supabase Realtime; ids we don't have are ignored.
      .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'chat_messages' },
        (payload) => { if (channel === chat.channel && payload.old) removeMessage(payload.old.id); })
      .on('presence', { event: 'sync' }, () => {
        if (channel !== chat.channel) return;
        chat.online = Object.keys(channel.presenceState()).length;
        renderHeader();
      })
      .subscribe(async (status) => {
        if (channel !== chat.channel) return;
        if (status === 'SUBSCRIBED') {
          setStatus('live');
          const active = document.activeElement;
          if (isReading() && (active === document.body || el.panel.contains(active))) el.input.focus();
          channel.track({ name: chat.name || 'Guest' }).catch(() => {});
          await loadHistory(); // after subscribing, so nothing sent in between is missed
        } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          setStatus('offline', 'Connection lost. Reconnecting…');
        } else if (status === 'CLOSED') {
          setStatus('offline', 'Disconnected.');
        }
      });
  }

  async function disconnect() {
    if (chat.channel) {
      const old = chat.channel;
      chat.channel = null;
      try { await getClient().removeChannel(old); } catch (err) { /* already closed */ }
    }
    chat.online = 0;
  }

  async function loadHistory() {
    const room = chat.room;
    const { data, error } = await getClient().from('chat_messages')
      .select('id, room, user_id, username, body, created_at')
      .eq('room', room.slug).order('created_at', { ascending: false }).limit(CHAT.historyLimit);
    if (chat.room !== room) return;
    if (error) { setStatus('offline', "Couldn't load messages. Check your connection."); return; }

    const rows = data.reverse();
    const lastReadKey = KEYS.lastRead + room.slug;
    const lastRead = store.get(lastReadKey, null);
    const isFirstVisit = lastRead == null;
    addMessages(rows, { live: false });
    if (isFirstVisit) markRead(); // joining a room for the first time doesn't start with 100 unread
    else recountUnread();
    if (!chat.messages.size) renderEmpty();
    scrollToBottom();
  }

  /* ---------- Messages ---------- */
  const timeFmt = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });
  const dayFmt = new Intl.DateTimeFormat([], { month: 'short', day: 'numeric' });
  function formatTime(iso) {
    const d = new Date(iso);
    const today = new Date();
    const sameDay = d.toDateString() === today.toDateString();
    return sameDay ? timeFmt.format(d) : `${dayFmt.format(d)}, ${timeFmt.format(d)}`;
  }

  const isNearBottom = () => el.body.scrollHeight - el.body.scrollTop - el.body.clientHeight < CHAT.nearBottomPx;
  function scrollToBottom() {
    el.body.scrollTop = el.body.scrollHeight;
    el.jump.hidden = true;
  }

  function renderEmpty() {
    el.list.replaceChildren(h('li', { class: 'chat-empty' },
      h('strong', { text: `Welcome to ${chat.room.name} Chat` }),
      h('span', { text: 'No messages yet. Say hi, ask how it is right now, or plan to meet up!' })));
  }

  function messageNode(m) {
    const mine = chat.user && m.user_id === chat.user.id;
    const actions = [];
    if (!mine) actions.push(h('button', { type: 'button', 'data-msg-action': 'report', text: 'Report' }));
    if (chat.isMod) {
      actions.push(h('button', { type: 'button', 'data-msg-action': 'remove', text: 'Remove' }));
      if (!mine) actions.push(h('button', { type: 'button', 'data-msg-action': 'ban', text: 'Ban' }));
    }
    // Focusable when it has actions, so keyboard users can reach Report / Remove
    return h('li', { class: `chat-msg${mine ? ' is-mine' : ''}`, 'data-id': String(m.id), tabindex: actions.length ? '0' : null },
      h('div', { class: 'chat-meta' },
        h('span', { class: 'chat-name', text: mine ? `${m.username} (you)` : m.username }),
        h('time', { datetime: m.created_at, text: formatTime(m.created_at) })),
      h('p', { class: 'chat-text', text: m.body }),
      actions.length ? h('div', { class: 'chat-actions' }, actions) : null);
  }

  /** Adds rows (deduped by id) in time order. `live` = arrived just now via Realtime. */
  function addMessages(rows, { live }) {
    const stick = isNearBottom();
    let added = 0;
    let addedOthers = 0;
    let addedMine = false;
    for (const m of rows) {
      if (!m || m.room !== chat.room.slug || chat.messages.has(m.id)) continue;
      chat.messages.set(m.id, m);
      added += 1;
      if (chat.user && m.user_id === chat.user.id) addedMine = true; else addedOthers += 1;
    }
    if (!added) return;
    // Re-render in id order (ids only grow), which also handles history arriving after live messages.
    const sorted = [...chat.messages.values()].sort((a, b) => a.id - b.id);
    el.list.replaceChildren(...sorted.map(messageNode));

    if (!live) return;
    if (isReading()) markRead(); else { chat.unread += addedOthers; renderBadges(); }
    if (addedMine || stick) scrollToBottom();
    else if (addedOthers) el.jump.hidden = false;
  }

  function removeMessage(id) {
    if (!chat.messages.delete(id)) return;
    const node = el.list.querySelector(`[data-id="${id}"]`);
    if (node) node.remove();
    recountUnread();
    if (!chat.messages.size) renderEmpty();
  }

  /* ---------- Unread ---------- */
  const isReading = () => chat.open && document.visibilityState === 'visible';
  const maxId = () => Math.max(0, ...chat.messages.keys());

  function markRead() {
    if (!chat.room) return;
    store.set(KEYS.lastRead + chat.room.slug, maxId());
    chat.unread = 0;
    renderBadges();
  }

  function recountUnread() {
    if (!chat.room) return;
    if (isReading()) { markRead(); return; }
    const lastRead = store.get(KEYS.lastRead + chat.room.slug, 0);
    chat.unread = [...chat.messages.values()]
      .filter((m) => m.id > lastRead && !(chat.user && m.user_id === chat.user.id)).length;
    renderBadges();
  }

  function renderBadges() {
    const n = chat.unread;
    const text = n > 99 ? '99+' : String(n);
    el.fabBadge.hidden = n === 0;
    el.fabBadge.textContent = text;
    const label = chat.room ? `Open ${chat.room.name} Chat` : 'Open Reach Local Chat';
    el.fab.setAttribute('aria-label', n ? `${label}, ${n} unread message${n === 1 ? '' : 's'}` : label);
  }

  /* ---------- Sending ---------- */
  async function sendMessage() {
    const body = el.input.value.trim();
    showError('');
    if (!body || chat.sending || !chat.channel) return;
    if (body.length > CHAT.maxBody) { showError(`Messages can be up to ${CHAT.maxBody} characters.`); return; }
    const wait = chat.lastSentAt + CHAT.cooldownMs - Date.now();
    if (wait > 0) { showError('One moment before your next message.'); return; }

    chat.sending = true;
    el.send.disabled = true;
    const { data, error } = await getClient().from('chat_messages')
      .insert({ room: chat.room.slug, username: chat.name, body })
      .select('id, room, user_id, username, body, created_at').single();
    chat.sending = false;
    el.send.disabled = false;

    if (error) {
      showError(friendlyError(error));
      if (/removed from Local Chat/i.test(error.message)) { chat.banned = true; renderComposerState(); }
      return;
    }
    chat.lastSentAt = Date.now();
    el.input.value = '';
    autoGrow();
    addMessages([data], { live: true });
    el.input.focus();
  }

  function friendlyError(error) {
    const msg = error.message || '';
    if (/too fast|just sent|removed from Local Chat/i.test(msg)) return msg;
    if (/check constraint|violates/i.test(msg)) return 'That message or name is not allowed.';
    if (/Failed to fetch|NetworkError/i.test(msg)) return "You're offline. Your message wasn't sent.";
    return "Your message couldn't be sent. Please try again.";
  }

  /** Grow the box with what you type, up to 120px; only then does it scroll. */
  function autoGrow() {
    el.input.style.height = 'auto';
    const border = el.input.offsetHeight - el.input.clientHeight; // height includes the border, scrollHeight doesn't
    const full = el.input.scrollHeight + border;
    el.input.style.height = `${Math.min(full, 120)}px`;
    el.input.style.overflowY = full > 120 ? 'auto' : 'hidden';
  }

  /* ---------- Reporting & moderation ---------- */
  async function onMessageAction(action, id) {
    const m = chat.messages.get(id);
    if (!m) return;
    const client = getClient();
    if (action === 'report') {
      const reason = window.prompt(`Report this message from ${m.username}?\n\n"${m.body.slice(0, 140)}"\n\nOptional: tell moderators why.`, '');
      if (reason === null) return;
      const { error } = await client.from('chat_reports').insert({ message_id: id, reason: reason.trim().slice(0, 200) || null });
      if (error && error.code !== '23505') { toast(/own message|no longer/i.test(error.message) ? error.message : "Couldn't send the report."); return; }
      toast('Thanks. Moderators will take a look.');
    } else if (action === 'remove') {
      if (!window.confirm('Remove this message for everyone?')) return;
      const { error } = await client.rpc('chat_remove_message', { message_id: id });
      if (error) { toast(error.message); return; }
      removeMessage(id);
    } else if (action === 'ban') {
      const reason = window.prompt(`Ban ${m.username} from Local Chat? Their messages from the last 24 hours will be removed.\n\nReason (optional):`, '');
      if (reason === null) return;
      const { error } = await client.rpc('chat_ban_author', { message_id: id, reason: reason.trim() || null });
      if (error) { toast(error.message); return; }
      [...chat.messages.values()].filter((x) => x.user_id === m.user_id).forEach((x) => removeMessage(x.id));
      toast(`${m.username} was banned.`);
    }
  }

  const toast = (text) => (typeof showToast === 'function' ? showToast(text) : window.alert(text));

  /* ---------- Rendering: header, status, screens ---------- */
  function renderHeader() {
    el.roomName.textContent = chat.room ? `${chat.room.name} Chat` : 'Choose a place';
    el.online.hidden = chat.status !== 'live' || !chat.online;
    el.onlineCount.textContent = `${chat.online} online`;
  }

  function setStatus(status, text = '') {
    chat.status = status;
    el.status.hidden = !text;
    el.status.textContent = text;
    el.status.classList.toggle('is-error', status === 'offline');
    renderHeader();
    renderComposerState();
  }

  function showComposer(show) {
    el.compose.hidden = !show;
    el.body.hidden = !show;
    el.menu.querySelectorAll('[data-chat-action="places"], [data-chat-action="rename"], [data-chat-action="copy-id"]')
      .forEach((b) => { b.hidden = !show; });
  }

  function renderComposerState() {
    const blocked = chat.banned || chat.status !== 'live';
    el.input.disabled = blocked;
    el.send.disabled = blocked || chat.sending;
    // Short on purpose: the place's name is already in the header, and a long hint would wrap
    el.input.placeholder = chat.banned ? 'You have been removed from Local Chat.' : 'Write a message…';
  }

  function showError(text) {
    el.error.hidden = !text;
    el.error.textContent = text;
  }

  /** Screens shown in place of the message list: setup needed, pick a place, or join. */
  function showScreen(node) {
    showComposer(false);
    el.status.hidden = true;
    root.querySelector('.chat-screen')?.remove();
    if (node) el.panel.insertBefore(node, el.error);
  }

  function setupNeededScreen() {
    return h('div', { class: 'chat-screen' },
      h('h3', { text: 'Local Chat is almost ready' }),
      h('p', { text: "This site hasn't been connected to a chat server yet." }),
      h('p', { class: 'chat-fine', text: 'Site owner: add SUPABASE_URL and SUPABASE_ANON_KEY to config.js and run supabase/chat.sql (see README > Local Chat).' }));
  }

  /** Every place on the map, numbered like its pin, to pick which place's chat to join. */
  function placesScreen() {
    el.roomName.textContent = 'Choose a place';
    const fitting = (state.results && state.results.fitting) || [];
    const current = chat.room && chat.room.slug;
    const search = h('input', { type: 'search', id: 'chat-place-search', placeholder: 'Search places', autocomplete: 'off', 'aria-label': 'Search places' });
    const list = h('ol', { class: 'chat-places' }, fitting.map((fit, i) => {
      const mode = CONFIG.MODES[fit.mode] || CONFIG.MODES[state.results.prefs.mode];
      const room = roomForPlace(fit.place);
      return h('li', { 'data-name': fit.place.name.toLowerCase() },
        h('button', { type: 'button', class: room.slug === current ? 'is-current' : null, 'data-pick': String(i) },
          h('span', { class: `chat-place-num${fit.verdict === 'short' ? ' is-short' : ''}`, 'aria-hidden': 'true', text: String(i + 1) }),
          h('span', { class: 'chat-place-text' },
            h('span', { class: 'chat-place-name', text: fit.place.name }),
            h('span', { class: 'chat-place-meta', text: [
              fit.place.kindLabel || TYPE_LABELS[fit.place.type] || fit.place.type, `${fmtDuration(fit.travel.thereMin)} ${mode ? mode.by : ''}`.trim(),
              room.slug === current ? "You're in this chat" : '',
            ].filter(Boolean).join(' · ') }))));
    }));
    const none = h('p', { class: 'chat-fine', hidden: true, text: 'No places match that.' });
    const screen = h('div', { class: 'chat-screen chat-picker' },
      h('h3', { text: 'Which place do you want to chat about?' }),
      fitting.length
        ? [h('p', { text: `Each place on the map has its own public chat. Pick one of these ${fitting.length}, or tap a pin and press Chat on its card.` }),
          fitting.length > 6 ? search : null, list, none]
        : h('p', { text: 'There are no places on the map right now. Change your plan to find some.' }));

    search.addEventListener('input', () => {
      const q = search.value.trim().toLowerCase();
      let shown = 0;
      list.querySelectorAll('li').forEach((li) => { li.hidden = q && !li.dataset.name.includes(q); if (!li.hidden) shown += 1; });
      none.hidden = shown > 0;
    });
    list.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-pick]');
      if (!btn) return;
      const i = Number(btn.dataset.pick);
      const fit = state.results.fitting[i];
      if (!fit) return;
      if (typeof showRecommendation === 'function') showRecommendation(i); // move the map and card to that place too
      openPanel(roomForPlace(fit.place));
    });
    return screen;
  }

  /** First visit: pick a display name, then join `room`. */
  function joinScreen(room) {
    el.roomName.textContent = `${room.name} Chat`;
    const nameInput = h('input', { type: 'text', id: 'chat-name', maxlength: String(CHAT.nameMax), autocomplete: 'nickname', placeholder: 'e.g. Alex' });
    nameInput.value = chat.name;
    const err = h('p', { class: 'chat-error', role: 'alert', hidden: true });
    const form = h('form', { class: 'chat-screen chat-join', novalidate: true },
      h('h3', { text: `Chat about ${room.name}` }),
      h('p', { text: 'A public chat for anyone heading here or nearby. Ask how busy it is, share tips, or find people to meet up with.' }),
      h('label', { for: 'chat-name', text: 'Display name' }), nameInput,
      err,
      h('button', { type: 'submit', class: 'btn btn-primary chat-join-btn', text: 'Join chat' }),
      h('p', { class: 'chat-fine', text: 'Messages are public to everyone in this room. Be kind and never share personal details like your address.' }));

    form.addEventListener('submit', (e) => {
      e.preventDefault();
      const nameError = saveName(nameInput.value, true);
      if (nameError) { err.textContent = nameError; err.hidden = false; nameInput.focus(); return; }
      showScreen(null);
      connect(room);
    });
    return form;
  }

  /** Validates and saves the display name. Returns an error message, or ''. */
  function saveName(raw, strict) {
    const name = raw.replace(/\s+/g, ' ').trim();
    if (strict && (name.length < CHAT.nameMin || name.length > CHAT.nameMax)) {
      return `Pick a name between ${CHAT.nameMin} and ${CHAT.nameMax} characters.`;
    }
    chat.name = name;
    store.set(KEYS.name, name);
    return '';
  }

  function showGuidelines() {
    window.alert([
      'Reach Local Chat guidelines',
      '',
      '• Be kind. No harassment, hate, or threats.',
      '• No spam, ads, or repeated messages.',
      "• Keep it safe: don't post addresses, phone numbers, or anyone's exact location.",
      '• Meeting up? Pick a public place and tell a friend.',
      '• Use Report on any message that breaks these rules.',
    ].join('\n'));
  }

  /* ---------- Panel state: open, minimize, leave ---------- */
  /** Open the panel on `room` (default: the room you're in). With no room, show the list of places. */
  function openPanel(room = chat.room) {
    document.dispatchEvent(new CustomEvent('reach:localchat-open')); // closes Ask Reach if it's open
    chat.open = true;
    renderPanel();
    if (!configured) showScreen(setupNeededScreen());
    else if (!room) showScreen(placesScreen());
    else if (!chat.name) showScreen(joinScreen(room));
    else if (!chat.channel || !chat.room || chat.room.slug !== room.slug) { showScreen(null); connect(room); }
    else { showScreen(null); showComposer(true); renderHeader(); } // already in this room: just show it again
    if (!el.body.hidden) { markRead(); scrollToBottom(); }
    const focusTarget = root.querySelector('.chat-screen input:not([hidden])') || root.querySelector('.chat-screen [data-pick]')
      || (!el.input.disabled && !el.compose.hidden ? el.input : el.closeBtn);
    focusTarget.focus();
  }

  /** Shrink back into the button. You stay in the room; the button shows its name and unread count. */
  function minimizePanel({ focus = true } = {}) {
    chat.open = false;
    toggleMenu(false);
    renderPanel();
    if (focus) el.fab.focus();
  }

  /** Leave the room and close. The button goes back to opening the list of places. */
  async function leaveRoom() {
    const left = chat.room;
    minimizePanel();
    await disconnect();
    chat.room = null;
    store.set(KEYS.room, null);
    chat.messages.clear();
    el.list.replaceChildren();
    chat.unread = 0;
    setStatus('idle');
    renderBadges();
    renderPanel();
    if (left) toast(`You left ${left.name} Chat`);
  }

  function renderPanel() {
    el.panel.hidden = !chat.open;
    el.fab.hidden = chat.open;
    el.fab.setAttribute('aria-expanded', String(chat.open));
    el.fab.classList.toggle('has-room', Boolean(chat.room));
    el.fabLabel.hidden = !chat.room;
    el.fabLabel.textContent = chat.room ? chat.room.name : '';
    el.fab.title = chat.room ? `${chat.room.name} Chat` : 'Chat about a place on the map';
    renderBadges();
  }

  function toggleMenu(show = el.menu.hidden) {
    el.menu.hidden = !show;
    el.menuBtn.setAttribute('aria-expanded', String(show));
  }

  async function onMenuAction(action) {
    toggleMenu(false);
    if (action === 'guidelines') showGuidelines();
    else if (action === 'places') { showScreen(placesScreen()); (root.querySelector('#chat-place-search') || root.querySelector('[data-pick]') || el.closeBtn).focus(); }
    else if (action === 'rename') {
      const next = window.prompt(`Your display name (${CHAT.nameMin}-${CHAT.nameMax} characters):`, chat.name);
      if (next === null) return;
      const problem = saveName(next, true);
      if (problem) { toast(problem); return; }
      if (chat.channel) chat.channel.track({ name: chat.name }).catch(() => {});
      toast(`You're now ${chat.name}.`);
    } else if (action === 'copy-id') {
      const id = chat.user ? chat.user.id : '';
      if (!id) return;
      try { await navigator.clipboard.writeText(id); toast('Chat ID copied.'); } catch (err) { window.prompt('Your chat ID:', id); }
    }
  }

  /* ---------- Events ---------- */
  el.fab.addEventListener('click', () => openPanel());
  el.closeBtn.addEventListener('click', leaveRoom);
  el.minBtn.addEventListener('click', () => minimizePanel());
  el.menuBtn.addEventListener('click', () => toggleMenu());
  el.menu.addEventListener('click', (e) => {
    const b = e.target.closest('[data-chat-action]');
    if (b) onMenuAction(b.dataset.chatAction);
  });
  el.jump.addEventListener('click', () => { scrollToBottom(); markRead(); });
  el.body.addEventListener('scroll', () => { if (isNearBottom()) el.jump.hidden = true; }, { passive: true });
  el.list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-msg-action]');
    if (b) { onMessageAction(b.dataset.msgAction, Number(b.closest('.chat-msg').dataset.id)); return; }
    // Touch screens have no hover: tap a message to show its Report button
    const msg = e.target.closest('.chat-msg');
    if (msg) msg.classList.toggle('show-actions');
  });
  el.compose.addEventListener('submit', (e) => { e.preventDefault(); sendMessage(); });
  el.input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendMessage(); }
  });
  el.input.addEventListener('input', () => { autoGrow(); if (!el.error.hidden) showError(''); });
  el.panel.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!el.menu.hidden) { toggleMenu(false); el.menuBtn.focus(); } else minimizePanel();
  });
  document.addEventListener('click', (e) => {
    if (!el.menu.hidden && !e.target.closest('#chat-menu, #chat-menu-btn')) toggleMenu(false);
  });
  // Only one chat open at a time: Ask Reach (assistant.js) says when it opens.
  document.addEventListener('reach:assistant-open', () => { if (chat.open) minimizePanel({ focus: false }); });
  document.addEventListener('visibilitychange', () => { if (isReading()) markRead(); });

  /* ---------- Map card button & map-only behavior ---------- */
  // app.js calls mapCardHTML by name, so wrapping window.mapCardHTML adds a "Chat" button to every
  // place card (after Get directions and Save). agent.js wraps it the same way; both still apply.
  const originalCardHTML = window.mapCardHTML;
  window.mapCardHTML = (fit, i, results) => originalCardHTML(fit, i, results)
    .replace(/<\/div>\s*<\/article>\s*$/, `<button type="button" class="btn btn-chat" data-chat-place="${esc(fit.place.id)}"
          aria-label="Chat with people at ${esc(fit.place.name)}">${ICONS.chat}<span>Chat</span></button>
      </div>
    </article>`);

  document.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-chat-place]');
    if (!btn) return;
    const place = findPlace(btn.dataset.chatPlace);
    if (place) openPanel(roomForPlace(place));
  });

  // Chat lives on the map: minimize it when you leave the map view (app.js toggles body.map-mode).
  new MutationObserver(() => {
    if (!document.body.classList.contains('map-mode') && chat.open) minimizePanel({ focus: false });
  }).observe(document.body, { attributes: true, attributeFilter: ['class'] });

  /* ---------- Init ---------- */
  // If you've joined before, reconnect quietly so the map's chat button can show unread
  // messages. This never creates an account; it only reuses this browser's saved room.
  async function init() {
    renderPanel();
    renderBadges();
    if (!configured || !chat.room || !chat.name) return;
    try {
      if (await ensureUser(false)) connect(chat.room);
    } catch (err) {
      console.warn('[Reach] Local Chat offline:', err.message);
    }
  }
  init();
})();
