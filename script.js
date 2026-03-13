const HOT_FEED_URI =
  "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot";
const PUBLIC_API = "https://public.api.bsky.app";
const STORAGE_KEY = "bsky-for-you-preferences";
const TIMELINE_PAGE_LIMIT = 100;
const TIMELINE_MAX_PAGES = 3;
const GLOBAL_FETCH_LIMIT = 30;
const RECENT_HOT_WINDOW_MINUTES = 30;
const RECENT_HOT_MIN_ENGAGEMENT = 10;
const RECENT_HOT_MIN_VELOCITY = 0.7;

const state = {
  session: null,
  profile: null,
  rawTimeline: [],
  personalFeed: [],
  globalFeed: [],
  preferences: loadPreferences(),
};

const elements = {
  loginForm: document.querySelector("[data-login-form]"),
  controlsForm: document.querySelector("[data-controls-form]"),
  personalFeed: document.querySelector("[data-personal-feed]"),
  globalFeed: document.querySelector("[data-global-feed]"),
  sessionState: document.querySelector("[data-session-state]"),
  profileChip: document.querySelector("[data-profile-chip]"),
  profileAvatar: document.querySelector("[data-profile-avatar]"),
  profileName: document.querySelector("[data-profile-name]"),
  profileHandle: document.querySelector("[data-profile-handle]"),
  template: document.querySelector("#post-card-template"),
};

bootstrap();

function bootstrap() {
  hydrateForms();
  bindEvents();
  renderPersonalFeed([]);
  renderLoading(elements.globalFeed, 3);
  updateSessionState("offline", "offline");
  updateDashboardStats();
  refreshGlobalFeed();
}

function bindEvents() {
  elements.loginForm?.addEventListener("submit", handleLoginSubmit);
  elements.controlsForm?.addEventListener("change", handleControlsChange);

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;

      if (action === "refresh-all") {
        await Promise.all([
          refreshGlobalFeed(),
          state.session ? refreshPersonalFeed() : Promise.resolve(),
        ]);
      }

      if (action === "refresh-global") {
        await refreshGlobalFeed();
      }

      if (action === "refresh-personal") {
        await refreshPersonalFeed();
      }

      if (action === "logout") {
        logout();
      }
    });
  });

  const identifierInput = elements.loginForm?.elements.namedItem("identifier");
  const serviceInput = elements.loginForm?.elements.namedItem("service");

  [identifierInput, serviceInput].forEach((input) => {
    input?.addEventListener("change", persistIdentityPreferences);
  });
}

function hydrateForms() {
  if (!elements.controlsForm || !elements.loginForm) {
    return;
  }

  elements.controlsForm.elements.namedItem("mode").value = state.preferences.mode;
  elements.controlsForm.elements.namedItem("windowHours").value = String(
    state.preferences.windowHours
  );
  elements.controlsForm.elements.namedItem("postLimit").value = String(
    state.preferences.postLimit
  );
  elements.controlsForm.elements.namedItem("includeReposts").checked =
    state.preferences.includeReposts;

  elements.loginForm.elements.namedItem("identifier").value =
    state.preferences.identifier || "";
  elements.loginForm.elements.namedItem("service").value =
    state.preferences.service || "https://bsky.social";
}

async function handleLoginSubmit(event) {
  event.preventDefault();

  const formData = new FormData(elements.loginForm);
  const identifier = String(formData.get("identifier") || "").trim();
  const password = String(formData.get("password") || "").trim();
  const service = normalizeService(String(formData.get("service") || ""));

  if (!identifier || !password) {
    updateSessionState("error", "faltando dados");
    return;
  }

  updateSessionState("busy", "entrando");

  try {
    const session = await apiFetch(service, "com.atproto.server.createSession", {
      method: "POST",
      body: {
        identifier,
        password,
      },
    });

    state.session = {
      accessJwt: session.accessJwt,
      did: session.did,
      handle: session.handle,
      service,
    };

    persistIdentityPreferences();
    elements.loginForm.elements.namedItem("password").value = "";
    await loadProfile();
    updateSessionState("online", "online");
    await refreshPersonalFeed();
  } catch (error) {
    console.error(error);
    state.session = null;
    state.profile = null;
    updateProfileChip();
    updateSessionState("error", "erro no login");
    renderPersonalFeed([], "Não consegui entrar com essa conta. Confira o handle e a app password.");
  }
}

function handleControlsChange() {
  const form = elements.controlsForm;
  if (!form) {
    return;
  }

  state.preferences = {
    ...state.preferences,
    mode: form.elements.namedItem("mode").value,
    windowHours: Number(form.elements.namedItem("windowHours").value),
    postLimit: Number(form.elements.namedItem("postLimit").value),
    includeReposts: form.elements.namedItem("includeReposts").checked,
  };

  savePreferences();

  if (state.rawTimeline.length > 0) {
    rerankPersonalFeed();
  }

  if (state.globalFeed.length > 0) {
    renderGlobalFeed(state.globalFeed.slice(0, state.preferences.postLimit));
  }
}

function persistIdentityPreferences() {
  if (!elements.loginForm) {
    return;
  }

  state.preferences.identifier = String(
    elements.loginForm.elements.namedItem("identifier").value || ""
  ).trim();
  state.preferences.service = normalizeService(
    String(elements.loginForm.elements.namedItem("service").value || "")
  );
  savePreferences();
}

async function loadProfile() {
  if (!state.session) {
    return;
  }

  const profile = await apiFetch(state.session.service, "app.bsky.actor.getProfile", {
    token: state.session.accessJwt,
    params: { actor: state.session.did },
  });

  state.profile = profile;
  updateProfileChip();
}

async function refreshPersonalFeed() {
  if (!state.session) {
    renderPersonalFeed([], "Conecte sua conta para montar o ranking quente do seu following.");
    return;
  }

  updateSessionState("busy", "sincronizando");
  renderLoading(elements.personalFeed, 4);

  try {
    state.rawTimeline = await fetchTimelinePages();
    rerankPersonalFeed();
    updateSessionState("online", "online");
  } catch (error) {
    console.error(error);
    updateSessionState("error", "erro na sync");
    renderPersonalFeed([], "Não consegui puxar sua timeline agora. Tenta de novo em alguns segundos.");
  }
}

function rerankPersonalFeed() {
  const ranked = rankPersonalFeed(state.rawTimeline, state.preferences);
  state.personalFeed = ranked.slice(0, state.preferences.postLimit);
  renderPersonalFeed(state.personalFeed);
  updatePersonalSummary(state.personalFeed);
  updateDashboardStats();
}

async function refreshGlobalFeed() {
  renderLoading(elements.globalFeed, 3);

  try {
    const data = await apiFetch(PUBLIC_API, "app.bsky.feed.getFeed", {
      params: {
        feed: HOT_FEED_URI,
        limit: GLOBAL_FETCH_LIMIT,
      },
    });

    state.globalFeed = (data.feed || []).map((item, index) =>
      normalizeFeedItem(item, "global", index + 1)
    );

    renderGlobalFeed(state.globalFeed.slice(0, state.preferences.postLimit));
    updateDashboardStats();
  } catch (error) {
    console.error(error);
    renderEmptyState(
      elements.globalFeed,
      "Sem hot posts agora",
      "A consulta ao feed global falhou. Recarregue para tentar outra vez."
    );
  }
}

async function fetchTimelinePages() {
  const items = [];
  let cursor = null;

  for (let page = 0; page < TIMELINE_MAX_PAGES; page += 1) {
    const params = {
      limit: TIMELINE_PAGE_LIMIT,
    };

    if (cursor) {
      params.cursor = cursor;
    }

    const data = await apiFetch(state.session.service, "app.bsky.feed.getTimeline", {
      token: state.session.accessJwt,
      params,
    });

    items.push(...(data.feed || []));
    cursor = data.cursor;

    if (!cursor) {
      break;
    }
  }

  return items;
}

function rankPersonalFeed(feedItems, preferences) {
  const normalized = dedupeByUri(
    feedItems
      .map((item) => normalizeFeedItem(item, "personal"))
      .filter((item) => preferences.includeReposts || !isRepost(item))
  );

  const recentWindowMinutes = Math.max(preferences.windowHours * 60, 120);
  const hotNow = normalized
    .filter(isHotNowCandidate)
    .map((item) => ({
      ...item,
      score: scorePost(item, preferences),
    }))
    .sort((left, right) => right.score - left.score);

  const hotUris = new Set(hotNow.map((item) => item.uri));

  const recentMomentum = normalized
    .filter(
      (item) => !hotUris.has(item.uri) && getAgeMinutes(item) <= recentWindowMinutes
    )
    .map((item) => ({
      ...item,
      score: scorePost(item, preferences),
    }))
    .sort((left, right) => right.score - left.score);

  const recentUris = new Set(recentMomentum.map((item) => item.uri));

  const fallback = normalized
    .filter((item) => !hotUris.has(item.uri) && !recentUris.has(item.uri))
    .map((item) => ({
      ...item,
      score: scorePost(item, preferences),
    }))
    .sort((left, right) => right.score - left.score);

  return [...hotNow, ...recentMomentum, ...fallback].map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

function scorePost(item, preferences) {
  const engagement = getEngagementUnits(item);
  const ageMinutes = getAgeMinutes(item);
  const velocity = getVelocity(item);
  const mediaBonus = hasRichEmbed(item.embed) ? 10 : 0;
  const freshnessBoost = Math.max(0, RECENT_HOT_WINDOW_MINUTES - ageMinutes) * 4.6;
  const basePenalty = penaltyMultiplier(item);

  if (preferences.mode === "viral") {
    return roundScore(
      (engagement * 1.28 + velocity * 88 + freshnessBoost * 0.45 + mediaBonus) *
        basePenalty
    );
  }

  if (preferences.mode === "rising") {
    return roundScore(
      (engagement * 0.82 + velocity * 176 + freshnessBoost * 1.6 + mediaBonus) *
        basePenalty
    );
  }

  return roundScore(
    (engagement + velocity * 128 + freshnessBoost + mediaBonus) * basePenalty
  );
}

function penaltyMultiplier(item) {
  let multiplier = 1;

  if (isRepost(item)) {
    multiplier *= 0.88;
  }

  if (item.reply) {
    multiplier *= 0.84;
  }

  return multiplier;
}

function renderPersonalFeed(entries, message) {
  if (!entries.length) {
    renderEmptyState(
      elements.personalFeed,
      "Seu feed quente vai aparecer aqui",
      message ||
        "Entre com sua conta e eu monto uma timeline pessoal puxando primeiro o que disparou agora."
    );
    updateDashboardStats();
    return;
  }

  const fragment = document.createDocumentFragment();
  entries.forEach((entry) => {
    fragment.appendChild(buildPostCard(entry));
  });

  elements.personalFeed.replaceChildren(fragment);
}

function renderGlobalFeed(entries) {
  if (!entries.length) {
    renderEmptyState(
      elements.globalFeed,
      "Sem posts globais agora",
      "O feed oficial What's Hot não retornou resultados nesta tentativa."
    );
    updateDashboardStats();
    return;
  }

  const fragment = document.createDocumentFragment();
  entries.forEach((entry) => {
    fragment.appendChild(
      buildPostCard({
        ...entry,
        score: scorePost(entry, state.preferences),
      })
    );
  });

  elements.globalFeed.replaceChildren(fragment);
  updateDashboardStats();
}

function buildPostCard(entry) {
  const node = elements.template.content.firstElementChild.cloneNode(true);
  const avatar = node.querySelector("[data-avatar]");
  const name = node.querySelector("[data-name]");
  const handle = node.querySelector("[data-handle]");
  const badge = node.querySelector("[data-badge]");
  const time = node.querySelector("[data-time]");
  const text = node.querySelector("[data-text]");
  const link = node.querySelector("[data-post-link]");
  const likes = node.querySelector("[data-likes]");
  const reposts = node.querySelector("[data-reposts]");
  const replies = node.querySelector("[data-replies]");
  const quotes = node.querySelector("[data-quotes]");
  const score = node.querySelector("[data-score]");
  const embed = node.querySelector("[data-embed]");

  avatar.src = entry.avatar || makeAvatarFallback(entry.authorName);
  avatar.alt = `Avatar de ${entry.authorName}`;
  name.textContent = entry.authorName;
  handle.textContent = `@${entry.authorHandle}`;
  time.textContent = formatRelativeTime(entry.indexedAt);
  time.dateTime = entry.indexedAt;
  text.textContent = entry.text || "Abrir post no Bluesky";
  link.href = entry.postUrl;

  likes.textContent = `${formatCompact(entry.likeCount)} likes`;
  reposts.textContent = `${formatCompact(entry.repostCount)} reposts`;
  replies.textContent = `${formatCompact(entry.replyCount)} replies`;
  quotes.textContent = `${formatCompact(entry.quoteCount)} quotes`;
  score.textContent = `${entry.score.toFixed(1)} pts`;

  const badgeLabel = getBadgeLabel(entry);
  if (badgeLabel) {
    badge.hidden = false;
    badge.textContent = badgeLabel;
  }

  const embedNodes = buildEmbedNodes(entry.embed);
  if (embedNodes.length > 0) {
    embed.hidden = false;
    embed.replaceChildren(...embedNodes);
  }

  return node;
}

function getBadgeLabel(entry) {
  if (entry.source === "global") {
    return "what's hot";
  }

  if (getAgeMinutes(entry) <= RECENT_HOT_WINDOW_MINUTES) {
    return "agora";
  }

  if (isRepost(entry)) {
    return "repost";
  }

  return "";
}

function buildEmbedNodes(embed) {
  const summary = summarizeEmbed(embed);

  if (!summary) {
    return [];
  }

  if (summary.type === "image") {
    const wrapper = document.createElement("div");
    wrapper.className = "embed-strip__image";

    const image = document.createElement("img");
    image.src = summary.url;
    image.alt = summary.alt || "";
    image.loading = "lazy";

    wrapper.appendChild(image);
    return [wrapper];
  }

  if (summary.type === "external") {
    const wrapper = document.createElement("div");
    wrapper.className = "embed-strip__external";

    const title = document.createElement("strong");
    title.textContent = summary.title || "Link externo";

    const description = document.createElement("span");
    description.textContent = summary.description || "Abrir preview externo do post.";

    const url = document.createElement("small");
    url.textContent = simplifyUrl(summary.url);

    wrapper.append(title, description, url);
    return [wrapper];
  }

  return [];
}

function summarizeEmbed(embed) {
  if (!embed || !embed.$type) {
    return null;
  }

  if (embed.$type === "app.bsky.embed.images#view" && embed.images?.length) {
    return {
      type: "image",
      url: embed.images[0].thumb || embed.images[0].fullsize,
      alt: embed.images[0].alt || "",
    };
  }

  if (embed.$type === "app.bsky.embed.video#view") {
    return {
      type: "image",
      url: embed.thumbnail,
      alt: "Prévia de vídeo",
    };
  }

  if (embed.$type === "app.bsky.embed.external#view") {
    return {
      type: "external",
      title: embed.external?.title,
      description: embed.external?.description,
      url: embed.external?.uri,
    };
  }

  if (embed.$type === "app.bsky.embed.recordWithMedia#view") {
    return summarizeEmbed(embed.media);
  }

  return null;
}

function renderLoading(container, count) {
  const fragment = document.createDocumentFragment();

  for (let index = 0; index < count; index += 1) {
    const card = document.createElement("article");
    card.className = "loading-card";
    card.innerHTML = `
      <div class="loading-card__bar"></div>
      <div class="loading-card__bar loading-card__bar--wide"></div>
      <div class="loading-card__bar"></div>
    `;
    fragment.appendChild(card);
  }

  container.replaceChildren(fragment);
}

function renderEmptyState(container, title, copy) {
  const node = document.createElement("article");
  node.className = "empty-state";
  node.innerHTML = `
    <p class="empty-state__eyebrow">sem posts</p>
    <h3>${escapeHtml(title)}</h3>
    <p>${escapeHtml(copy)}</p>
  `;

  container.replaceChildren(node);
}

function updateProfileChip() {
  if (!state.profile) {
    elements.profileChip.hidden = true;
    return;
  }

  elements.profileChip.hidden = false;
  elements.profileAvatar.src =
    state.profile.avatar || makeAvatarFallback(state.profile.displayName || state.profile.handle);
  elements.profileAvatar.alt = `Avatar de ${state.profile.displayName || state.profile.handle}`;
  elements.profileName.textContent = state.profile.displayName || state.profile.handle;
  elements.profileHandle.textContent = `@${state.profile.handle}`;
}

function updatePersonalSummary(entries) {
  if (!elements.summaryWindow || !elements.summaryScore || !elements.summaryLikes) {
    return;
  }

  elements.summaryWindow.textContent = `${state.preferences.windowHours}h`;

  if (!entries.length) {
    elements.summaryScore.textContent = "0";
    elements.summaryLikes.textContent = "0";
    return;
  }

  const avgScore =
    entries.reduce((total, entry) => total + entry.score, 0) / Math.max(entries.length, 1);
  const topLikes = Math.max(...entries.map((entry) => entry.likeCount));

  elements.summaryScore.textContent = avgScore.toFixed(1);
  elements.summaryLikes.textContent = formatCompact(topLikes);
}

function updateDashboardStats() {
  if (elements.scannedStat) {
    elements.scannedStat.textContent = String(state.rawTimeline.length || 0);
  }

  if (elements.personalStat) {
    elements.personalStat.textContent = String(state.personalFeed.length || 0);
  }

  if (elements.globalStat) {
    elements.globalStat.textContent = String(
      Math.min(state.globalFeed.length || 0, state.preferences.postLimit)
    );
  }
}

function updateSessionState(kind, label) {
  const badge = elements.sessionState;
  if (!badge) {
    return;
  }

  badge.classList.remove("is-online", "is-busy", "is-error");

  if (kind === "online") {
    badge.classList.add("is-online");
  }

  if (kind === "busy") {
    badge.classList.add("is-busy");
  }

  if (kind === "error") {
    badge.classList.add("is-error");
  }

  badge.textContent = label;
}

function logout() {
  state.session = null;
  state.profile = null;
  state.rawTimeline = [];
  state.personalFeed = [];
  updateProfileChip();
  updateSessionState("offline", "offline");
  renderPersonalFeed([], "Sessão encerrada. Entre novamente para montar seu feed.");
}

function normalizeFeedItem(item, source, rank = 0) {
  const post = item.post || item;
  const authorName = post.author?.displayName || post.author?.handle || "Conta desconhecida";
  const text = String(post.record?.text || "").trim();

  return {
    id: post.uri,
    rank,
    source,
    uri: post.uri,
    postUrl: buildPostUrl(post.uri, post.author?.did),
    authorName,
    authorHandle: post.author?.handle || "desconhecido",
    avatar: post.author?.avatar || "",
    text,
    indexedAt: post.indexedAt || post.record?.createdAt || new Date().toISOString(),
    likeCount: Number(post.likeCount || 0),
    repostCount: Number(post.repostCount || 0),
    replyCount: Number(post.replyCount || 0),
    quoteCount: Number(post.quoteCount || 0),
    bookmarkCount: Number(post.bookmarkCount || 0),
    reason: item.reason || null,
    reply: item.reply || null,
    embed: post.embed || null,
    score: source === "global" ? scorePost(
      {
        likeCount: Number(post.likeCount || 0),
        repostCount: Number(post.repostCount || 0),
        replyCount: Number(post.replyCount || 0),
        quoteCount: Number(post.quoteCount || 0),
        bookmarkCount: Number(post.bookmarkCount || 0),
        embed: post.embed || null,
        indexedAt: post.indexedAt || post.record?.createdAt || new Date().toISOString(),
        reason: item.reason || null,
        reply: item.reply || null,
      },
      state.preferences
    ) : 0,
  };
}

function buildPostUrl(uri, did) {
  const rkey = uri?.split("/").pop();
  if (!did || !rkey) {
    return "https://bsky.app";
  }

  return `https://bsky.app/profile/${did}/post/${rkey}`;
}

function isRepost(item) {
  return Boolean(item.reason?.$type?.includes("repost"));
}

function hasRichEmbed(embed) {
  return Boolean(summarizeEmbed(embed));
}

function getAgeMinutes(item) {
  return Math.max(1, (Date.now() - new Date(item.indexedAt).getTime()) / 60000);
}

function getEngagementUnits(item) {
  return (
    item.likeCount +
    item.repostCount * 4 +
    item.quoteCount * 5 +
    item.replyCount * 1.6 +
    item.bookmarkCount * 3
  );
}

function getVelocity(item) {
  return getEngagementUnits(item) / Math.max(getAgeMinutes(item), 3);
}

function isHotNowCandidate(item) {
  return (
    getAgeMinutes(item) <= RECENT_HOT_WINDOW_MINUTES &&
    getEngagementUnits(item) >= RECENT_HOT_MIN_ENGAGEMENT &&
    getVelocity(item) >= RECENT_HOT_MIN_VELOCITY
  );
}

function dedupeByUri(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.uri)) {
      return false;
    }

    seen.add(item.uri);
    return true;
  });
}

function roundScore(value) {
  return Number(value.toFixed(1));
}

function formatCompact(value) {
  return new Intl.NumberFormat("pt-BR", {
    notation: "compact",
    maximumFractionDigits: 1,
  }).format(value);
}

function formatRelativeTime(dateInput) {
  const date = new Date(dateInput);
  const diffMs = date.getTime() - Date.now();
  const diffHours = diffMs / 36e5;
  const rtf = new Intl.RelativeTimeFormat("pt-BR", { numeric: "auto" });

  if (Math.abs(diffHours) < 1) {
    return rtf.format(Math.round(diffMs / 60000), "minute");
  }

  if (Math.abs(diffHours) < 24) {
    return rtf.format(Math.round(diffHours), "hour");
  }

  return rtf.format(Math.round(diffHours / 24), "day");
}

function makeAvatarFallback(label) {
  const initials = (label || "B")
    .split(" ")
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase())
    .join("");

  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="96" height="96" viewBox="0 0 96 96">
      <defs>
        <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stop-color="#6de1ff" />
          <stop offset="100%" stop-color="#1083fe" />
        </linearGradient>
      </defs>
      <rect width="96" height="96" rx="24" fill="url(#g)" />
      <text x="50%" y="54%" dominant-baseline="middle" text-anchor="middle"
        font-family="Arial, sans-serif" font-size="34" fill="#03101d">${initials || "B"}</text>
    </svg>
  `;

  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

function simplifyUrl(url) {
  if (!url) {
    return "link";
  }

  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

function normalizeService(service) {
  const cleaned = service.trim() || "https://bsky.social";
  return cleaned.replace(/\/+$/, "");
}

async function apiFetch(baseUrl, nsid, options = {}) {
  const url = new URL(`${normalizeService(baseUrl)}/xrpc/${nsid}`);

  if (options.params) {
    Object.entries(options.params).forEach(([key, value]) => {
      if (value !== undefined && value !== null && value !== "") {
        url.searchParams.set(key, String(value));
      }
    });
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      "Content-Type": "application/json",
      ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`${nsid} failed: ${response.status} ${errorText}`);
  }

  return response.json();
}

function loadPreferences() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "{}");
    const isLegacyPreferences = !parsed.rankingVersion;
    return {
      mode: isLegacyPreferences ? "rising" : parsed.mode || "rising",
      windowHours: isLegacyPreferences ? 0.5 : Number(parsed.windowHours || 0.5),
      postLimit: Number(parsed.postLimit || 15),
      includeReposts: parsed.includeReposts ?? true,
      identifier: parsed.identifier || "",
      service: parsed.service || "https://bsky.social",
    };
  } catch {
    return {
      mode: "rising",
      windowHours: 0.5,
      postLimit: 15,
      includeReposts: true,
      identifier: "",
      service: "https://bsky.social",
    };
  }
}

function savePreferences() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      ...state.preferences,
      rankingVersion: 2,
    })
  );
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
