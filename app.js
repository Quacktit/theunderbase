"use strict";

(() => {
  /* Anti-clickjacking fallback. Real protection = frame-ancestors header on your server. */
  if (window.top !== window.self) {
    document.documentElement.hidden = true;
    try { window.top.location = window.location.href; } catch (_) { /* ignore */ }
    return;
  }

  /* ------------------------------------------------------------------
     CONFIG
     classifyEndpoint: URL of YOUR OWN backend route that calls the
     third-party AI (OpenAI, Gemini, Claude, etc). Never put an AI API
     key in this file - anyone can read it. Leave "" to use the local
     keyword fallback below.
  ------------------------------------------------------------------ */
  const CONFIG = Object.freeze({
    classifyEndpoint: "",
    classifyTimeoutMs: 6000,
    postCooldownMs: 20000,
    maxPostsPerSession: 20,
    maxTitle: 140,
    maxBody: 5000,
    maxSearch: 100
  });

  const CATEGORIES = Object.freeze([
    "General", "Confession", "Academics", "Clinical",
    "Campus Life", "Campus Concern", "Events"
  ]);

  const STORE_KEY = "underground_demo_v1";

  /* ------------------------------------------------------------------
     PAGES - one entry per HTML file
  ------------------------------------------------------------------ */
  const PAGES = Object.freeze({
    home: {
      file: "index.html", label: "Home", icon: "⌂",
      title: "Your campus, unfiltered.", note: "",
      compose: true, chips: true, placeholder: "Start a conversation...",
      match: () => true,
      emptyTitle: "Nothing here yet.", emptyText: "Start a conversation on campus."
    },
    trending: {
      file: "trending.html", label: "Trending", icon: "↗",
      title: "Trending discussions.", note: "The most active discussions on campus right now.",
      compose: false, chips: false, placeholder: "",
      match: () => true,
      emptyTitle: "Nothing is trending yet.", emptyText: "Upvote and comment to push discussions up."
    },
    confessions: {
      file: "confessions.html", label: "Confessions", icon: "◉",
      title: "Whispers from campus.", note: "Say what you can't say out loud. Stay kind: no names and no patient details.",
      compose: true, chips: false, placeholder: "Confess something...",
      match: p => p.category === "Confession",
      emptyTitle: "No confessions yet.", emptyText: "Be the first to share something."
    },
    saved: {
      file: "saved.html", label: "Saved", icon: "▱",
      title: "Your saved discussions.", note: "Saved posts are kept for this browser session only (demo mode).",
      compose: false, chips: false, placeholder: "",
      match: p => p.saved,
      emptyTitle: "Nothing saved.", emptyText: "Tap Save on a post to keep it here."
    },
    events: {
      file: "events.html", label: "Events", icon: "✳",
      title: "Campus events.", note: "Fests, workshops, CMEs and meetups.",
      compose: true, chips: false, placeholder: "Share an event...",
      match: p => p.category === "Events",
      emptyTitle: "No events yet.", emptyText: "Share what's coming up on campus."
    },
    concerns: {
      file: "concerns.html", label: "Raise a concern", icon: "⚑",
      title: "Campus concerns.", note: "Describe the problem, where it is and since when. Don't name individuals.",
      compose: true, chips: false, placeholder: "Raise a concern...",
      match: p => p.category === "Campus Concern",
      emptyTitle: "No concerns raised.", emptyText: "Raise an issue so it can be discussed."
    },
    account: {
      file: "account.html", label: "Account", icon: "◐",
      title: "Your account.", note: "You're browsing as an anonymous guest.",
      compose: false, chips: false, placeholder: "",
      match: p => p.mine,
      emptyTitle: "No posts yet.", emptyText: "Posts you create in this session will appear here."
    }
  });

  const PAGE = Object.prototype.hasOwnProperty.call(PAGES, document.body.dataset.page)
    ? document.body.dataset.page : "home";
  const CFG = PAGES[PAGE];

  /* ---------------------------- Helpers ---------------------------- */

  const $ = id => document.getElementById(id);

  function escapeHTML(value) {
    return String(value).replace(/[&<>"'`]/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
      '"': "&quot;", "'": "&#39;", "`": "&#96;"
    })[char]);
  }

  // Strips control characters and invisible / bidi-override characters (text spoofing)
  function cleanText(value, max) {
    return String(value == null ? "" : value)
      .normalize("NFC")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
      .trim()
      .slice(0, max);
  }

  function toInt(value) {
    const n = Number.parseInt(value, 10);
    return Number.isSafeInteger(n) ? n : NaN;
  }

  function clampInt(value, min, max, fallback) {
    return Number.isSafeInteger(value) ? Math.min(max, Math.max(min, value)) : fallback;
  }

  function timeAgo(ts) {
    const m = Math.floor((Date.now() - ts) / 60000);
    if (m < 1) return "Just now";
    if (m < 60) return `${m} min ago`;
    const h = Math.floor(m / 60);
    if (h < 24) return `${h} hour${h === 1 ? "" : "s"} ago`;
    const d = Math.floor(h / 24);
    return `${d} day${d === 1 ? "" : "s"} ago`;
  }

  let toastTimer;
  function showToast(message) {
    const toast = $("toast");
    if (!toast) return;
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 3000);
  }

  /* ---------------------------- State (sessionStorage) ---------------------------- */

  let posts = [];
  let userVotes = Object.create(null);      // postId -> -1 | 1
  let commentVotes = Object.create(null);   // "postId:commentId" -> -1 | 1
  let nextPostId = 1;
  let postsCreated = 0;
  let lastPostAt = 0;

  let activeFilter = "all";
  let searchTerm = "";
  let openPostId = null;
  let lastFocus = null;
  let publishing = false;

  function makeSeed() {
    const now = Date.now();
    const H = 3600000;
    const c = (a, b, av, bv) => [{ id: 1, text: a, votes: av }, { id: 2, text: b, votes: bv }];
    return [
      { id: 1, title: "Why is the examination schedule announced so late?", body: "Does anyone else think we need a proper examination calendar? Students need enough time to plan their preparation.", category: "Academics", author: "Neon_Scholar", ts: now - 2 * H, votes: 48, comments: c("We definitely need a proper schedule.", "Our department should publish it earlier.", 12, 7) },
      { id: 2, title: "Sometimes university feels lonelier than living alone.", body: "You can be surrounded by hundreds of people and still feel disconnected. Does anyone else experience this?", category: "Confession", author: "Midnight_Owl", ts: now - 4 * H, votes: 126, comments: c("I understand this feeling.", "You're definitely not alone.", 31, 24) },
      { id: 3, title: "How do you prepare for first-year BDS practicals?", body: "Dental anatomy carving, histology slides and dissection all at once. Looking for study tips from senior students.", category: "Academics", author: "Void_Coder", ts: now - 6 * H, votes: 32, comments: c("Practice carving a little every day.", "Make short notes for histology slides.", 9, 5) },
      { id: 4, title: "The hostel Wi-Fi needs serious improvement.", body: "Connection drops frequently, especially during the evening. Can we organize a constructive discussion about this?", category: "Campus Concern", author: "Silent_Orbit", ts: now - 8 * H, votes: 67, comments: c("Same problem in our block.", "We should document the issue.", 14, 6) },
      { id: 5, title: "Annual college fest: volunteers needed?", body: "Planning meetings start next week. Anyone interested in helping with decorations, registration or sound?", category: "Events", author: "Fest_Crew", ts: now - 10 * H, votes: 41, comments: c("I can help with registration.", "Count me in for decorations.", 8, 4) },
      { id: 6, title: "The second-floor water cooler has been broken for weeks.", body: "It has been out of order since the start of the month. Is there a proper way to get this reported and fixed?", category: "Campus Concern", author: "Quiet_Lantern", ts: now - 20 * H, votes: 58, comments: c("Report it to the hostel office in writing.", "Let's raise it together with a date.", 11, 6) },
      { id: 7, title: "I pretend to understand every lecture so nobody thinks I'm slow.", body: "Half the time I copy notes without following. Everyone else seems to get it instantly. Does anyone else fake it?", category: "Confession", author: "Paper_Ghost", ts: now - 26 * H, votes: 89, comments: c("Most of us do this at some point.", "Study groups helped me a lot.", 22, 15) },
      { id: 8, title: "Tips for your first week in the clinic?", body: "We start clinical postings soon. What should a first-timer know about instruments, sterilisation protocols and talking to patients?", category: "Clinical", author: "Steady_Hands", ts: now - 29 * H, votes: 37, comments: c("Learn the instrument tray setup first.", "Be calm and explain every step.", 10, 8) },
      { id: 9, title: "CME workshop on endodontics next month", body: "Registrations open soon. Would anyone be interested in attending together?", category: "Events", author: "Campus_Radar", ts: now - 52 * H, votes: 24, comments: c("Yes, interested!", "Please share the date once it's confirmed.", 5, 3) }
    ].map(p => Object.assign(p, { saved: false, mine: false }));
  }

  function sanitizeComment(c) {
    if (!c || typeof c !== "object") return null;
    const id = clampInt(c.id, 1, 1e9, NaN);
    const text = cleanText(c.text, 1000);
    if (!Number.isSafeInteger(id) || !text) return null;
    return { id, text, votes: clampInt(c.votes, -1e6, 1e6, 0) };
  }

  function sanitizePost(p) {
    if (!p || typeof p !== "object") return null;
    const id = clampInt(p.id, 1, 1e9, NaN);
    const title = cleanText(p.title, CONFIG.maxTitle);
    const body = cleanText(p.body, CONFIG.maxBody);
    if (!Number.isSafeInteger(id) || !title || !body) return null;
    return {
      id, title, body,
      category: CATEGORIES.includes(p.category) ? p.category : "General",
      author: cleanText(p.author, 40) || "Anonymous_Guest",
      ts: clampInt(p.ts, 0, 8.64e15, Date.now()),
      votes: clampInt(p.votes, -1e6, 1e6, 0),
      comments: (Array.isArray(p.comments) ? p.comments.slice(0, 200) : []).map(sanitizeComment).filter(Boolean),
      saved: p.saved === true,
      mine: p.mine === true
    };
  }

  function cleanVoteMap(obj, keyRegex) {
    const out = Object.create(null);
    if (obj && typeof obj === "object") {
      for (const [k, v] of Object.entries(obj)) {
        if (keyRegex.test(k) && (v === 1 || v === -1)) out[k] = v;
      }
    }
    return out;
  }

  function loadState() {
    try {
      const raw = sessionStorage.getItem(STORE_KEY);
      if (!raw || raw.length > 600000) return false;
      const d = JSON.parse(raw);
      if (!d || d.v !== 1 || !Array.isArray(d.posts) || d.posts.length > 300) return false;
      const loaded = d.posts.map(sanitizePost).filter(Boolean);
      if (!loaded.length && d.posts.length) return false;
      posts = loaded;
      userVotes = cleanVoteMap(d.userVotes, /^\d{1,9}$/);
      commentVotes = cleanVoteMap(d.commentVotes, /^\d{1,9}:\d{1,9}$/);
      nextPostId = Math.max(clampInt(d.nextPostId, 1, 1e9, 1), ...posts.map(p => p.id + 1), 1);
      postsCreated = clampInt(d.postsCreated, 0, 1000, 0);
      lastPostAt = clampInt(d.lastPostAt, 0, 8.64e15, 0);
      return true;
    } catch (_) {
      return false;
    }
  }

  function saveState() {
    try {
      sessionStorage.setItem(STORE_KEY, JSON.stringify({
        v: 1, posts, userVotes, commentVotes, nextPostId, postsCreated, lastPostAt
      }));
    } catch (_) { /* storage unavailable or full: continue without persistence */ }
  }

  function initState() {
    if (!loadState()) {
      posts = makeSeed();
      userVotes = Object.create(null);
      commentVotes = Object.create(null);
      nextPostId = posts.length + 1;
      postsCreated = 0;
      lastPostAt = 0;
      saveState();
    }
  }

  /* ---------------------------- Auto categorisation ---------------------------- */

  const RULES = [
    ["Campus Concern", /\b(harass|ragging|unsafe|threat|complain|complaint|broken|not working|out of order|wi-?fi|internet|mess food|water supply|water cooler|electricity|fees?|corruption|bribe)\b/i],
    ["Confession", /\b(confess|confession|secret|never told|nobody knows|lonely|loneliness|anxious|anxiety|stressed|crush|regret|ashamed|burnout|homesick|pretend)\b/i],
    ["Clinical", /\b(patient|patients|clinic|clinical|extraction|filling|root canal|rct|scaling|ortho|oral|dental chair|opd|case sheet|posting|postings)\b/i],
    ["Events", /\b(event|events|fest|festival|competition|workshop|seminar|cme|conference|cultural|sports day|farewell|freshers|volunteers)\b/i],
    ["Academics", /\b(exam|exams|syllabus|viva|practical|practicals|anatomy|histology|physiology|notes|lecture|attendance|internal|marks|university|study|studying|prepare|preparation|carving)\b/i],
    ["Campus Life", /\b(hostel|canteen|mess|library|roommate|friends|bus|transport|campus|club|hangout)\b/i]
  ];

  function classifyLocal(title, body) {
    const text = `${title} ${body}`;
    for (const [category, regex] of RULES) {
      if (regex.test(text)) return category;
    }
    return "General";
  }

  // Calls YOUR backend, which calls the third-party AI. The reply is checked
  // against a fixed whitelist so a bad response can never inject anything.
  async function classifyPost(title, body) {
    if (!CONFIG.classifyEndpoint) return classifyLocal(title, body);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONFIG.classifyTimeoutMs);
    try {
      const res = await fetch(CONFIG.classifyEndpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ title, body }),
        credentials: "omit",
        referrerPolicy: "no-referrer",
        signal: controller.signal
      });
      if (!res.ok) throw new Error("classify failed");
      const data = await res.json();
      if (data && CATEGORIES.includes(data.category)) return data.category;
    } catch (_) {
      /* fall through to local fallback */
    } finally {
      clearTimeout(timer);
    }
    return classifyLocal(title, body);
  }

  /* ---------------------------- Page shell ---------------------------- */

  function sideLink(key) {
    const p = PAGES[key];
    const on = key === PAGE;
    return `<a class="nav-item${on ? " active" : ""}" href="${p.file}"${on ? ' aria-current="page"' : ""}><span class="nav-icon">${p.icon}</span><span>${p.label}</span></a>`;
  }

  function pillLink(key) {
    const p = PAGES[key];
    const on = key === PAGE;
    return `<a class="community-chip${on ? " active" : ""}" href="${p.file}"${on ? ' aria-current="page"' : ""}>${p.label}</a>`;
  }

  function tabLink(key, label, icon) {
    const on = key === PAGE;
    return `<a class="mobile-tab${on ? " active" : ""}" href="${PAGES[key].file}"${on ? ' aria-current="page"' : ""}><span>${icon}</span><small>${label}</small></a>`;
  }

  function feedMain() {
    const sort = PAGE === "trending" ? "" : `<select id="sortSelect" aria-label="Sort posts"><option value="new">Latest</option><option value="hot">Hot</option><option value="top">Top</option></select>`;

    const chips = CFG.chips ? `
      <section class="community-strip" aria-label="Browse by topic">
        <button class="community-chip active" type="button" data-filter="all"><span class="chip-symbol">✳</span> For you</button>
        <button class="community-chip" type="button" data-filter="Confession"><span class="chip-symbol">☾</span> Confessions</button>
        <button class="community-chip" type="button" data-filter="Academics"><span class="chip-symbol">✎</span> Academics</button>
        <button class="community-chip" type="button" data-filter="Clinical"><span class="chip-symbol">＋</span> Clinical</button>
        <button class="community-chip" type="button" data-filter="Campus Life"><span class="chip-symbol">◌</span> Campus life</button>
      </section>` : "";

    const composer = CFG.compose ? `
      <section class="composer">
        <div class="guest-avatar">G</div>
        <button id="openComposer" class="composer-trigger" type="button">${CFG.placeholder}</button>
        <button id="quickCreate" class="create-icon" type="button" aria-label="Create post">＋</button>
      </section>
      <div id="composerPanel" class="composer-panel hidden">
        <h3>Create a post</h3>
        <input id="postTitle" maxlength="${CONFIG.maxTitle}" autocomplete="off" placeholder="Give your post a title...">
        <textarea id="postBody" maxlength="${CONFIG.maxBody}" placeholder="Share what's on your mind..."></textarea>
        <div class="composer-controls"><p class="auto-note">Your post's topic is assigned automatically.</p><button id="publishPost" class="primary-btn" type="button">Post anonymously <span>↗</span></button></div>
        <p class="demo-note">Demo mode: posts are stored only in this browser session. They are not yet private or shared with other students.</p>
      </div>` : "";

    return `
      <div class="feed-heading"><div><span class="eyebrow">THE CAMPUS COMMUNITY</span><h1 id="feedTitle">${CFG.title}</h1></div>${sort}</div>
      ${CFG.note ? `<p class="page-note">${CFG.note}</p>` : ""}
      ${chips}
      ${composer}
      <div class="feed-subhead"><span>${PAGE === "trending" ? "Most active right now" : "Recent conversations"}</span><span class="live-label"><i></i> COMMUNITY FEED</span></div>
      <section id="posts" class="posts" aria-live="polite"></section>
      <div id="emptyState" class="empty hidden"><span>◌</span><h3>${CFG.emptyTitle}</h3><p>${CFG.emptyText}</p></div>`;
  }

  function accountMain() {
    return `
      <div class="feed-heading"><div><span class="eyebrow">YOUR SPACE</span><h1 id="feedTitle">${CFG.title}</h1></div></div>
      <p class="page-note">${CFG.note} Nothing here identifies you.</p>

      <section class="profile-card">
        <div class="guest-avatar">G</div>
        <div><strong>Anonymous_Guest</strong><small>Guest session · not signed in</small></div>
        <div class="stat-grid">
          <div class="stat"><b id="statPosts">0</b><span>Your posts</span></div>
          <div class="stat"><b id="statVotes">0</b><span>Votes on your posts</span></div>
          <div class="stat"><b id="statSaved">0</b><span>Saved posts</span></div>
          <div class="stat"><b id="statCvotes">0</b><span>Comment votes</span></div>
        </div>
      </section>

      <section class="auth-card">
        <h3>Sign in or create an account</h3>
        <p>Accounts are not connected yet. This form only checks your input; nothing is sent, stored or saved.</p>
        <div class="auth-tabs" role="tablist">
          <button class="auth-tab active" type="button" role="tab" data-auth="signin">Sign in</button>
          <button class="auth-tab" type="button" role="tab" data-auth="signup">Create account</button>
        </div>

        <div id="panelSignin">
          <label class="field"><span>Email</span><input id="siEmail" type="email" maxlength="254" autocomplete="email" placeholder="you@example.com"></label>
          <label class="field"><span>Password</span><input id="siPass" type="password" maxlength="128" autocomplete="current-password" placeholder="Your password"></label>
          <button id="signinBtn" class="primary-btn" type="button">Sign in</button>
        </div>

        <div id="panelSignup" class="hidden">
          <label class="field"><span>Email</span><input id="suEmail" type="email" maxlength="254" autocomplete="email" placeholder="you@example.com"></label>
          <label class="field"><span>Password (10+ characters)</span><input id="suPass" type="password" maxlength="128" autocomplete="new-password" placeholder="Create a password"></label>
          <label class="field"><span>Confirm password</span><input id="suPass2" type="password" maxlength="128" autocomplete="new-password" placeholder="Repeat the password"></label>
          <label class="check"><input id="suAge" type="checkbox"><span>I am 18 years or older.</span></label>
          <button id="signupBtn" class="primary-btn" type="button">Create account</button>
        </div>
      </section>

      <section class="auth-card">
        <h3>Session data</h3>
        <p>Everything in this demo lives in this browser tab only. You can clear it at any time.</p>
        <div class="btn-row">
          <button class="secondary-btn" type="button" data-action="deletemine">Delete my posts</button>
          <button class="danger-btn" type="button" data-action="reset">Reset all demo data</button>
        </div>
      </section>

      <div class="feed-subhead"><span>Your posts</span><span class="live-label"><i></i> THIS SESSION</span></div>
      <section id="posts" class="posts" aria-live="polite"></section>
      <div id="emptyState" class="empty hidden"><span>◌</span><h3>${CFG.emptyTitle}</h3><p>${CFG.emptyText}</p></div>`;
  }

  function buildShell() {
    const home = PAGES.home.file;
    $("shell").innerHTML = `
      <header class="topbar">
        <a class="brand" href="${home}" aria-label="The Underground home"><span class="brand-icon">u.</span><span class="brand-word">the <b>underground</b></span></a>
        <label class="search"><span aria-hidden="true">⌕</span><input id="searchInput" type="search" maxlength="${CONFIG.maxSearch}" autocomplete="off" placeholder="Search discussions" aria-label="Search posts"></label>
        <a class="guest-pill" href="${PAGES.account.file}"><span class="online-dot"></span> Guest</a>
      </header>
      <div class="app-layout">
        <aside class="sidebar">
          <p class="section-label">YOUR SPACE</p>
          ${sideLink("home")}${sideLink("trending")}${sideLink("confessions")}${sideLink("saved")}
          <p class="section-label campus-label">CAMPUS</p>
          ${sideLink("events")}${sideLink("concerns")}
          <p class="section-label campus-label">YOU</p>
          ${sideLink("account")}
          <a class="sidebar-footer" href="${PAGES.account.file}"><div class="guest-avatar">G</div><div><strong>Anonymous Guest</strong><small>Browsing privately</small></div><span class="more-dots">···</span></a>
        </aside>
        <main class="feed">
          <nav class="mobile-pages" aria-label="Pages">${Object.keys(PAGES).map(pillLink).join("")}</nav>
          ${PAGE === "account" ? accountMain() : feedMain()}
        </main>
        <aside class="rightbar">
          <div class="right-card pulse-card"><span class="eyebrow">CAMPUS PULSE</span><h3>What's happening?</h3><div class="pulse-line"><span class="pulse-dot"></span> The community is open</div><p>Find your people. Share what's happening. Keep the conversation going.</p></div>
          <div class="right-card"><div class="card-heading"><span class="eyebrow">PEOPLE ARE TALKING</span><span class="tiny-arrow">↗</span></div><div id="talkList"></div></div>
          <div class="right-card safety-card"><span class="eyebrow">A QUICK REMINDER</span><p>Speak freely. Respect privacy. Challenge ideas, not people. Report threats and harassment.</p></div>
          <footer class="site-footer">THE UNDERGROUND © 2026<br>Built for students, by students.</footer>
        </aside>
      </div>
      <nav class="mobile-nav" aria-label="Mobile navigation">
        ${tabLink("home", "Home", "⌂")}${tabLink("trending", "Explore", "↗")}
        <button class="mobile-tab create-tab" id="mobileCreate" type="button"><span>＋</span><small>Create</small></button>
        ${tabLink("confessions", "Confess", "◉")}${tabLink("account", "Account", "◐")}
      </nav>
      <div id="postModal" class="modal hidden" role="dialog" aria-modal="true" aria-labelledby="modalTitle"><div class="modal-content"><button id="closeModal" class="close-btn" type="button" aria-label="Close">×</button><div id="modalContent"></div></div></div>
      <div id="toast" class="toast" role="status"></div>`;
  }

  /* ---------------------------- Rendering ---------------------------- */

  function visiblePosts() {
    let list = posts.filter(CFG.match);

    if (activeFilter !== "all") list = list.filter(p => p.category === activeFilter);

    if (searchTerm) {
      list = list.filter(p => `${p.title} ${p.body} ${p.category} ${p.author}`.toLowerCase().includes(searchTerm));
    }

    const now = Date.now();
    const sortEl = $("sortSelect");
    const sort = sortEl ? sortEl.value : "top";

    if (PAGE === "trending") {
      list.sort((a, b) => (b.votes + b.comments.length * 2) - (a.votes + a.comments.length * 2));
    } else if (sort === "hot") {
      const hot = p => (p.votes + p.comments.length * 2 + 1) / Math.pow(Math.max(0, (now - p.ts) / 3600000) + 2, 1.3);
      list.sort((a, b) => hot(b) - hot(a));
    } else if (sort === "top") {
      list.sort((a, b) => b.votes - a.votes);
    } else {
      list.sort((a, b) => b.ts - a.ts || b.id - a.id);
    }
    return list;
  }

  function postCardHTML(post) {
    const vote = userVotes[post.id] || 0;
    return `
      <article class="post-card" data-id="${post.id}">
        <div class="post-top">
          <div class="post-author">
            <div class="mini-avatar">${escapeHTML(post.author.charAt(0).toUpperCase())}</div>
            <div>
              <strong>${escapeHTML(post.author)}</strong>
              <small>${escapeHTML(timeAgo(post.ts))} · Guest identity</small>
            </div>
          </div>
          <span class="flair">${escapeHTML(post.category)}</span>
        </div>
        <h3>${escapeHTML(post.title)}</h3>
        <p class="post-body">${escapeHTML(post.body)}</p>
        <div class="post-actions">
          <button class="action-btn ${vote === 1 ? "selected" : ""}" type="button" aria-label="Upvote" data-vote="1" data-id="${post.id}">↑ ${post.votes}</button>
          <button class="action-btn ${vote === -1 ? "selected" : ""}" type="button" aria-label="Downvote" data-vote="-1" data-id="${post.id}">↓</button>
          <button class="action-btn" type="button" data-open="${post.id}">◯ ${post.comments.length} Comments</button>
          <span class="action-spacer"></span>
          <button class="action-btn ${post.saved ? "selected" : ""}" type="button" data-save="${post.id}">♧ ${post.saved ? "Saved" : "Save"}</button>
        </div>
      </article>`;
  }

  function renderPosts() {
    const list = visiblePosts();
    $("emptyState").classList.toggle("hidden", list.length !== 0);
    $("posts").innerHTML = list.map(postCardHTML).join("");
  }

  function renderRightbar() {
    const byCat = new Map();
    for (const p of posts) {
      const entry = byCat.get(p.category) || { count: 0, top: p };
      entry.count++;
      if (p.votes > entry.top.votes) entry.top = p;
      byCat.set(p.category, entry);
    }
    const top = [...byCat.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 3);
    const cut = s => (s.length > 48 ? s.slice(0, 47) + "…" : s);
    $("talkList").innerHTML = top.map(([cat, e]) => `
      <div class="trend-item"><small>${escapeHTML(cat.toUpperCase())}</small><strong>${escapeHTML(cut(e.top.title))}</strong><span>${e.count} discussion${e.count === 1 ? "" : "s"}</span></div>
    `).join("");
  }

  function renderStats() {
    if (PAGE !== "account") return;
    const mine = posts.filter(p => p.mine);
    $("statPosts").textContent = mine.length;
    $("statVotes").textContent = mine.reduce((sum, p) => sum + p.votes, 0);
    $("statSaved").textContent = posts.filter(p => p.saved).length;
    $("statCvotes").textContent = Object.keys(commentVotes).length;
  }

  function renderAll() {
    renderPosts();
    renderRightbar();
    renderStats();
  }

  /* ---------------------------- Composer ---------------------------- */

  function toggleComposer() {
    const panel = $("composerPanel");
    if (!panel) {
      window.location.href = `${PAGES.home.file}#compose`;
      return;
    }
    panel.classList.toggle("hidden");
    if (!panel.classList.contains("hidden")) {
      $("postTitle").focus();
      panel.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
  }

  async function publishPost() {
    if (publishing) return;

    const title = cleanText($("postTitle").value, CONFIG.maxTitle);
    const body = cleanText($("postBody").value, CONFIG.maxBody);

    if (!title || !body) { showToast("Please enter a title and post content."); return; }
    if (postsCreated >= CONFIG.maxPostsPerSession) { showToast("Post limit reached for this session."); return; }
    const wait = CONFIG.postCooldownMs - (Date.now() - lastPostAt);
    if (wait > 0) { showToast(`Please wait ${Math.ceil(wait / 1000)}s before posting again.`); return; }

    publishing = true;
    const btn = $("publishPost");
    btn.disabled = true;

    try {
      const category = await classifyPost(title, body);
      const post = {
        id: nextPostId++, title, body, category,
        author: "Anonymous_Guest", ts: Date.now(),
        votes: 0, comments: [], saved: false, mine: true
      };
      posts.unshift(post);
      lastPostAt = Date.now();
      postsCreated++;
      saveState();

      $("postTitle").value = "";
      $("postBody").value = "";
      $("composerPanel").classList.add("hidden");

      const sortEl = $("sortSelect");
      if (sortEl) sortEl.value = "new";
      if (activeFilter !== "all" && activeFilter !== category) setFilter("all");

      renderAll();
      showToast(CFG.match(post)
        ? `Posted under "${category}".`
        : `Posted under "${category}". Find it on the ${category === "Events" ? "Events" : category === "Confession" ? "Confessions" : "Home"} page.`);
    } finally {
      publishing = false;
      btn.disabled = false;
    }
  }

  function setFilter(filter) {
    activeFilter = filter;
    document.querySelectorAll("[data-filter]").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.filter === filter);
    });
  }

  /* ---------------------------- Modal + comments ---------------------------- */

  function renderModal() {
    const post = posts.find(p => p.id === openPostId);
    if (!post) return;
    const comments = [...post.comments].sort((a, b) => b.votes - a.votes);

    $("modalContent").innerHTML = `
      <span class="eyebrow">${escapeHTML(post.category)}</span>
      <h2 id="modalTitle">${escapeHTML(post.title)}</h2>
      <p class="post-body">${escapeHTML(post.body)}</p>
      <p class="demo-note">Posted by ${escapeHTML(post.author)} · ${escapeHTML(timeAgo(post.ts))}</p>
      <hr>
      <h3>Comments (${post.comments.length})</h3>
      ${comments.map(c => {
        const v = commentVotes[`${post.id}:${c.id}`] || 0;
        return `
          <div class="modal-comment">
            <div class="comment-text">${escapeHTML(c.text)}</div>
            <div class="comment-votes">
              <button class="comment-vote-btn ${v === 1 ? "selected" : ""}" type="button" aria-label="Upvote comment" data-cvote="1" data-post="${post.id}" data-comment="${c.id}">↑</button>
              <span class="comment-score">${c.votes}</span>
              <button class="comment-vote-btn ${v === -1 ? "selected" : ""}" type="button" aria-label="Downvote comment" data-cvote="-1" data-post="${post.id}" data-comment="${c.id}">↓</button>
            </div>
          </div>`;
      }).join("")}
      <p class="demo-note">Comment creation will be connected in a later stage.</p>`;
  }

  function openPost(id) {
    const post = posts.find(p => p.id === id);
    if (!post) return;
    lastFocus = document.activeElement;
    openPostId = post.id;
    renderModal();
    $("postModal").classList.remove("hidden");
    $("closeModal").focus();
  }

  function closeModal() {
    $("postModal").classList.add("hidden");
    openPostId = null;
    if (lastFocus && typeof lastFocus.focus === "function") lastFocus.focus();
    lastFocus = null;
  }

  /* ---------------------------- Voting / saving ---------------------------- */

  function handleVote(id, direction) {
    const post = posts.find(p => p.id === id);
    if (!post || (direction !== 1 && direction !== -1)) return;
    const oldVote = userVotes[id] || 0;
    const newVote = oldVote === direction ? 0 : direction;
    post.votes += newVote - oldVote;
    if (newVote === 0) delete userVotes[id]; else userVotes[id] = newVote;
    saveState();
    renderAll();
  }

  function handleCommentVote(postId, commentId, direction) {
    const post = posts.find(p => p.id === postId);
    const comment = post && post.comments.find(c => c.id === commentId);
    if (!comment || (direction !== 1 && direction !== -1)) return;
    const key = `${postId}:${commentId}`;
    const oldVote = commentVotes[key] || 0;
    const newVote = oldVote === direction ? 0 : direction;
    comment.votes += newVote - oldVote;
    if (newVote === 0) delete commentVotes[key]; else commentVotes[key] = newVote;
    saveState();
    renderModal();
    renderStats();
  }

  function handleSave(id) {
    const post = posts.find(p => p.id === id);
    if (!post) return;
    post.saved = !post.saved;
    saveState();
    renderAll();
    showToast(post.saved ? "Added to saved posts." : "Removed from saved posts.");
  }

  /* ---------------------------- Account page ---------------------------- */

  const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;

  function switchAuth(which) {
    document.querySelectorAll("[data-auth]").forEach(btn => btn.classList.toggle("active", btn.dataset.auth === which));
    $("panelSignin").classList.toggle("hidden", which !== "signin");
    $("panelSignup").classList.toggle("hidden", which !== "signup");
  }

  function clearPasswords() {
    ["siPass", "suPass", "suPass2"].forEach(id => { const el = $(id); if (el) el.value = ""; });
  }

  const NOT_CONNECTED = "Accounts aren't connected yet. Nothing was sent or saved.";

  function submitSignin() {
    const email = cleanText($("siEmail").value, 254);
    const pass = $("siPass").value;
    if (!EMAIL_RE.test(email)) { showToast("Enter a valid email address."); return; }
    if (!pass) { showToast("Enter your password."); return; }
    clearPasswords();
    showToast(NOT_CONNECTED);
  }

  function submitSignup() {
    const email = cleanText($("suEmail").value, 254);
    const pass = $("suPass").value;
    const pass2 = $("suPass2").value;
    if (!EMAIL_RE.test(email)) { showToast("Enter a valid email address."); return; }
    if (pass.length < 10) { showToast("Use a password of at least 10 characters."); return; }
    if (pass.toLowerCase() === email.toLowerCase()) { showToast("Your password can't be your email."); return; }
    if (pass !== pass2) { showToast("The passwords don't match."); return; }
    if (!$("suAge").checked) { showToast("You must be 18 or older."); return; }
    clearPasswords();
    showToast(NOT_CONNECTED);
  }

  function deleteMine() {
    posts = posts.filter(p => !p.mine);
    saveState();
    renderAll();
    showToast("Your posts were deleted from this session.");
  }

  function resetAll() {
    try { sessionStorage.removeItem(STORE_KEY); } catch (_) { /* ignore */ }
    window.location.reload();
  }

  /* ---------------------------- Events ---------------------------- */

  function bindEvents() {
    document.addEventListener("click", event => {
      const target = event.target;
      if (!(target instanceof Element)) return;

      const cvote = target.closest("[data-cvote]");
      if (cvote) { handleCommentVote(toInt(cvote.dataset.post), toInt(cvote.dataset.comment), toInt(cvote.dataset.cvote)); return; }

      const vote = target.closest("[data-vote]");
      if (vote) { handleVote(toInt(vote.dataset.id), toInt(vote.dataset.vote)); return; }

      const save = target.closest("[data-save]");
      if (save) { handleSave(toInt(save.dataset.save)); return; }

      const open = target.closest("[data-open]");
      if (open) { openPost(toInt(open.dataset.open)); return; }

      const filter = target.closest("[data-filter]");
      if (filter) { setFilter(filter.dataset.filter); renderPosts(); return; }

      const auth = target.closest("[data-auth]");
      if (auth) { switchAuth(auth.dataset.auth === "signup" ? "signup" : "signin"); return; }

      const action = target.closest("[data-action]");
      if (action) {
        if (action.dataset.action === "deletemine") deleteMine();
        else if (action.dataset.action === "reset") resetAll();
      }
    });

    const on = (id, evt, fn) => { const el = $(id); if (el) el.addEventListener(evt, fn); };

    on("openComposer", "click", toggleComposer);
    on("quickCreate", "click", toggleComposer);
    on("mobileCreate", "click", toggleComposer);
    on("publishPost", "click", publishPost);
    on("sortSelect", "change", renderPosts);
    on("signinBtn", "click", submitSignin);
    on("signupBtn", "click", submitSignup);

    on("searchInput", "input", event => {
      if (PAGE === "account") return;
      searchTerm = cleanText(event.target.value, CONFIG.maxSearch).toLowerCase();
      renderPosts();
    });
    on("searchInput", "keydown", event => {
      if (PAGE !== "account" || event.key !== "Enter") return;
      const q = cleanText(event.target.value, CONFIG.maxSearch);
      if (q) window.location.href = `${PAGES.home.file}?q=${encodeURIComponent(q)}`;
    });

    on("closeModal", "click", closeModal);
    on("postModal", "click", event => { if (event.target === $("postModal")) closeModal(); });
    document.addEventListener("keydown", event => { if (event.key === "Escape" && openPostId !== null) closeModal(); });
  }

  /* ---------------------------- Init ---------------------------- */

  function init() {
    initState();
    buildShell();
    bindEvents();

    // Search term passed from another page (?q=...)
    if (PAGE !== "account") {
      const q = cleanText(new URLSearchParams(window.location.search).get("q") || "", CONFIG.maxSearch);
      if (q) { $("searchInput").value = q; searchTerm = q.toLowerCase(); }
    }

    renderAll();

    if (window.location.hash === "#compose" && $("composerPanel")) toggleComposer();
  }

  init();
})();
