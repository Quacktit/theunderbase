"use strict";

(() => {
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
    maxBody: 5000
  });

  const CATEGORIES = Object.freeze([
    "General", "Confession", "Academics", "Clinical",
    "Campus Life", "Campus Concern", "Events"
  ]);

  let nextPostId = 5;
  let posts = [
    {
      id: 1,
      title: "Why is the examination schedule announced so late?",
      body: "Does anyone else think we need a proper examination calendar? Students need enough time to plan their preparation.",
      category: "Academics",
      author: "Neon_Scholar",
      age: "2 hours ago",
      votes: 48,
      comments: [
        { id: 1, text: "We definitely need a proper schedule.", votes: 12 },
        { id: 2, text: "Our department should publish it earlier.", votes: 7 }
      ],
      saved: false
    },
    {
      id: 2,
      title: "Sometimes university feels lonelier than living alone.",
      body: "You can be surrounded by hundreds of people and still feel disconnected. Does anyone else experience this?",
      category: "Confession",
      author: "Midnight_Owl",
      age: "4 hours ago",
      votes: 126,
      comments: [
        { id: 1, text: "I understand this feeling.", votes: 31 },
        { id: 2, text: "You're definitely not alone.", votes: 24 }
      ],
      saved: false
    },
    {
      id: 3,
      title: "How do you prepare for first-year BDS practicals?",
      body: "Dental anatomy carving, histology slides and dissection all at once. Looking for study tips from senior students.",
      category: "Academics",
      author: "Void_Coder",
      age: "6 hours ago",
      votes: 32,
      comments: [
        { id: 1, text: "Practice carving a little every day.", votes: 9 },
        { id: 2, text: "Make short notes for histology slides.", votes: 5 }
      ],
      saved: false
    },
    {
      id: 4,
      title: "The hostel Wi-Fi needs serious improvement.",
      body: "Connection drops frequently, especially during the evening. Can we organize a constructive discussion about this?",
      category: "Campus Concern",
      author: "Silent_Orbit",
      age: "8 hours ago",
      votes: 67,
      comments: [
        { id: 1, text: "Same problem in our block.", votes: 14 },
        { id: 2, text: "We should document the issue.", votes: 6 }
      ],
      saved: false
    }
  ];

  let activeFilter = "all";
  let activePage = "home";
  let searchTerm = "";
  let userVotes = Object.create(null);        // postId -> -1 | 0 | 1
  let commentVotes = Object.create(null);     // "postId:commentId" -> -1 | 0 | 1
  let openPostId = null;
  let toastTimer;
  let lastPostAt = 0;
  let postsCreated = 0;
  let publishing = false;

  const $ = id => document.getElementById(id);

  /* ---------------------------- Security helpers ---------------------------- */

  function escapeHTML(value) {
    return String(value).replace(/[&<>"'`]/g, char => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;",
      '"': "&quot;", "'": "&#39;", "`": "&#96;"
    })[char]);
  }

  // Strips control characters and bidi-override characters (used for text spoofing)
  function cleanText(value, max) {
    return String(value)
      .normalize("NFC")
      .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g, "")
      .trim()
      .slice(0, max);
  }

  function toInt(value) {
    const n = Number.parseInt(value, 10);
    return Number.isSafeInteger(n) ? n : NaN;
  }

  function showToast(message) {
    const toast = $("toast");
    toast.textContent = message;
    toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toast.classList.remove("show"), 2800);
  }

  /* ---------------------------- Auto categorisation ---------------------------- */

  const RULES = [
    ["Campus Concern", /\b(harass|ragging|unsafe|threat|complain|complaint|broken|not working|wi-?fi|internet|mess food|water supply|electricity|fees?|corruption|bribe)\b/i],
    ["Confession", /\b(confess|confession|secret|never told|nobody knows|lonely|loneliness|anxious|anxiety|stressed|crush|regret|ashamed|burnout|homesick)\b/i],
    ["Clinical", /\b(patient|clinic|clinical|extraction|filling|root canal|rct|scaling|ortho|oral|dental chair|opd|case sheet|posting)\b/i],
    ["Academics", /\b(exam|exams|syllabus|viva|practical|practicals|anatomy|histology|physiology|notes|lecture|attendance|internal|marks|university|study|studying|prepare|preparation|carving)\b/i],
    ["Events", /\b(event|fest|festival|competition|workshop|seminar|cme|conference|cultural|sports day|farewell|freshers)\b/i],
    ["Campus Life", /\b(hostel|canteen|mess|library|roommate|friends|bus|transport|campus|club|hangout)\b/i]
  ];

  function classifyLocal(title, body) {
    const text = `${title} ${body}`;
    for (const [category, regex] of RULES) {
      if (regex.test(text)) return category;
    }
    return "General";
  }

  // Calls your backend, which calls the third-party AI. The response is
  // validated against a whitelist so a bad response can never inject anything.
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

  /* ---------------------------- Rendering ---------------------------- */

  function renderPosts() {
    const container = $("posts");
    let filtered = [...posts];

    if (activePage === "confessions") {
      filtered = filtered.filter(p => p.category === "Confession");
    } else if (activePage === "saved") {
      filtered = filtered.filter(p => p.saved);
    } else if (activePage === "concerns") {
      filtered = filtered.filter(p => p.category === "Campus Concern");
    } else if (activePage === "events") {
      filtered = filtered.filter(p => p.category === "Events");
    }

    if (activeFilter !== "all") {
      filtered = filtered.filter(p => p.category === activeFilter);
    }

    if (searchTerm) {
      filtered = filtered.filter(p =>
        `${p.title} ${p.body} ${p.category} ${p.author}`.toLowerCase().includes(searchTerm)
      );
    }

    const sort = $("sortSelect").value;
    if (activePage === "trending" || sort === "top" || sort === "hot") {
      filtered.sort((a, b) => b.votes - a.votes);
    } else {
      filtered.sort((a, b) => b.id - a.id);
    }

    $("emptyState").classList.toggle("hidden", filtered.length !== 0);

    container.innerHTML = filtered.map(post => {
      const vote = userVotes[post.id] || 0;
      return `
        <article class="post-card" data-id="${post.id}">
          <div class="post-top">
            <div class="post-author">
              <div class="mini-avatar">${escapeHTML(post.author.charAt(0).toUpperCase())}</div>
              <div>
                <strong>${escapeHTML(post.author)}</strong>
                <small>${escapeHTML(post.age)} · Guest identity</small>
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
        </article>
      `;
    }).join("");
  }

  function setPage(page, filter) {
    activePage = page;
    activeFilter = filter || "all";

    const titles = {
      home: "Your campus, unfiltered.",
      trending: "Trending discussions.",
      confessions: "Whispers from campus.",
      saved: "Your saved discussions.",
      events: "Campus events.",
      concerns: "Campus concerns."
    };
    $("feedTitle").textContent = titles[page] || titles.home;

    document.querySelectorAll(".nav-item,.mobile-tab").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.page === page);
    });
    document.querySelectorAll(".community-chip").forEach(btn => {
      btn.classList.toggle("active", btn.dataset.filter === activeFilter);
    });

    renderPosts();
  }

  function toggleComposer() {
    const panel = $("composerPanel");
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

    if (!title || !body) {
      showToast("Please enter a title and post content.");
      return;
    }
    if (postsCreated >= CONFIG.maxPostsPerSession) {
      showToast("Post limit reached for this session.");
      return;
    }
    const wait = CONFIG.postCooldownMs - (Date.now() - lastPostAt);
    if (wait > 0) {
      showToast(`Please wait ${Math.ceil(wait / 1000)}s before posting again.`);
      return;
    }

    publishing = true;
    const btn = $("publishPost");
    btn.disabled = true;

    try {
      const category = await classifyPost(title, body);

      posts.unshift({
        id: nextPostId++,
        title,
        body,
        category,
        author: "Anonymous_Guest",
        age: "Just now",
        votes: 0,
        comments: [],
        saved: false
      });

      lastPostAt = Date.now();
      postsCreated++;
      $("postTitle").value = "";
      $("postBody").value = "";
      $("composerPanel").classList.add("hidden");
      $("sortSelect").value = "new";
      setPage("home");
      showToast("Demo post created in this browser session.");
    } finally {
      publishing = false;
      btn.disabled = false;
    }
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
      <p class="demo-note">Posted by ${escapeHTML(post.author)} · ${escapeHTML(post.age)}</p>
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
          </div>
        `;
      }).join("")}
      <p class="demo-note">Comment creation will be connected in a later stage.</p>
    `;
  }

  function openPost(id) {
    const post = posts.find(p => p.id === id);
    if (!post) return;
    openPostId = post.id;
    renderModal();
    $("postModal").classList.remove("hidden");
    $("closeModal").focus();
  }

  function closeModal() {
    $("postModal").classList.add("hidden");
    openPostId = null;
  }

  /* ---------------------------- Voting ---------------------------- */

  function handleVote(id, direction) {
    const post = posts.find(p => p.id === id);
    if (!post || (direction !== 1 && direction !== -1)) return;

    const oldVote = userVotes[id] || 0;
    const newVote = oldVote === direction ? 0 : direction;
    post.votes += newVote - oldVote;
    userVotes[id] = newVote;
    renderPosts();
  }

  function handleCommentVote(postId, commentId, direction) {
    const post = posts.find(p => p.id === postId);
    const comment = post && post.comments.find(c => c.id === commentId);
    if (!comment || (direction !== 1 && direction !== -1)) return;

    const key = `${postId}:${commentId}`;
    const oldVote = commentVotes[key] || 0;
    const newVote = oldVote === direction ? 0 : direction;
    comment.votes += newVote - oldVote;
    commentVotes[key] = newVote;
    renderModal();
  }

  function handleSave(id) {
    const post = posts.find(p => p.id === id);
    if (!post) return;
    post.saved = !post.saved;
    renderPosts();
    showToast(post.saved ? "Added to saved posts." : "Removed from saved posts.");
  }

  /* ---------------------------- Events ---------------------------- */

  document.addEventListener("click", event => {
    const target = event.target;
    if (!(target instanceof Element)) return;

    const pageButton = target.closest("[data-page]");
    const cvoteButton = target.closest("[data-cvote]");
    const voteButton = target.closest("[data-vote]");
    const saveButton = target.closest("[data-save]");
    const openButton = target.closest("[data-open]");
    const filterButton = target.closest("[data-filter]");

    if (cvoteButton) {
      handleCommentVote(toInt(cvoteButton.dataset.post), toInt(cvoteButton.dataset.comment), toInt(cvoteButton.dataset.cvote));
      return;
    }
    if (voteButton) { handleVote(toInt(voteButton.dataset.id), toInt(voteButton.dataset.vote)); return; }
    if (saveButton) { handleSave(toInt(saveButton.dataset.save)); return; }
    if (openButton) { openPost(toInt(openButton.dataset.open)); return; }
    if (pageButton) { setPage(pageButton.dataset.page); return; }
    if (filterButton) { setPage("home", filterButton.dataset.filter); }
  });

  $("openComposer").addEventListener("click", toggleComposer);
  $("quickCreate").addEventListener("click", toggleComposer);
  $("mobileCreate").addEventListener("click", toggleComposer);
  $("publishPost").addEventListener("click", publishPost);
  $("sortSelect").addEventListener("change", renderPosts);

  $("searchInput").addEventListener("input", event => {
    searchTerm = cleanText(event.target.value, 100).toLowerCase();
    renderPosts();
  });

  $("closeModal").addEventListener("click", closeModal);
  $("postModal").addEventListener("click", event => {
    if (event.target === $("postModal")) closeModal();
  });
  document.addEventListener("keydown", event => {
    if (event.key === "Escape") closeModal();
  });

  setPage("home");
})();
