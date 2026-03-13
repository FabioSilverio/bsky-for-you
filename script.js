const HOT_FEED_URI =
  "at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot";
const PUBLIC_API = "https://public.api.bsky.app";
const STORAGE_KEY = "bsky-for-you-preferences";
const SESSION_STORAGE_KEY = "bsky-for-you-session";
const TIMELINE_PAGE_LIMIT = 100;
const TIMELINE_MAX_PAGES = 5;
const GLOBAL_FETCH_LIMIT = 30;
const GLOBAL_MANUAL_PAGE_LIMIT = 3;
const RECENT_HOT_WINDOW_MINUTES = 30;
const BASE_MIN_ENGAGEMENT = 10;
const BASE_MIN_VELOCITY = 0.7;
const WINDOW_SEQUENCE = [0.5, 1, 1.5, 2, 3, 4, 6, 12, 24];
const MAX_COMPOSER_IMAGES = 4;
const TRENDING_TOPICS_LIMIT = 8;
const STOPWORDS = new Set([
  "about",
  "after",
  "agora",
  "ainda",
  "alguem",
  "antes",
  "aqui",
  "assim",
  "being",
  "bluesky",
  "como",
  "com",
  "contra",
  "porque",
  "para",
  "mais",
  "menos",
  "muito",
  "muita",
  "muitas",
  "muitos",
  "that",
  "this",
  "from",
  "with",
  "without",
  "have",
  "just",
  "into",
  "sobre",
  "entre",
  "the",
  "and",
  "you",
  "your",
  "meu",
  "minha",
  "meus",
  "minhas",
  "they",
  "them",
  "their",
  "quando",
  "onde",
  "what",
  "whats",
  "been",
  "estao",
  "esta",
  "esse",
  "essa",
  "isso",
  "those",
  "these",
  "from",
  "uma",
  "umas",
  "uns",
  "nos",
  "nas",
  "dos",
  "das",
  "por",
  "pra",
  "pro",
  "que",
  "quem",
  "will",
  "would",
  "https",
  "http",
  "coisa",
  "coisas",
  "news",
  "post",
  "posts",
  "today",
  "amanha",
  "ontem",
]);

const state = {
  session: null,
  profile: null,
  rawTimeline: [],
  personalRanked: [],
  personalFeed: [],
  globalFeed: [],
  preferences: loadPreferences(),
  composeImages: [],
  personalRelaxLevel: 0,
  personalWindowHours: 0.5,
  personalRenderCount: 0,
  isLoadingMorePersonal: false,
  globalCursor: null,
  globalRefreshSerial: 0,
  globalRefreshDepth: 0,
};

const elements = {
  loginForm: document.querySelector("[data-login-form]"),
  controlsForm: document.querySelector("[data-controls-form]"),
  composeForm: document.querySelector("[data-compose-form]"),
  composeText: document.querySelector("[data-compose-text]"),
  composeImageInput: document.querySelector("[data-compose-images]"),
  composePreviews: document.querySelector("[data-compose-previews]"),
  composeStatus: document.querySelector("[data-compose-status]"),
  personalFeed: document.querySelector("[data-personal-feed]"),
  personalLoader: document.querySelector("[data-personal-loader]"),
  personalSentinel: document.querySelector("[data-personal-sentinel]"),
  globalFeed: document.querySelector("[data-global-feed]"),
  globalTopics: document.querySelector("[data-global-topics]"),
  sessionState: document.querySelector("[data-session-state]"),
  profileChip: document.querySelector("[data-profile-chip]"),
  profileAvatar: document.querySelector("[data-profile-avatar]"),
  profileName: document.querySelector("[data-profile-name]"),
  profileHandle: document.querySelector("[data-profile-handle]"),
  template: document.querySelector("#post-card-template"),
};

let personalObserver = null;

bootstrap();

async function bootstrap() {
  state.personalWindowHours = Math.max(Number(state.preferences.windowHours || 0.5), 0.5);
  state.personalRenderCount = state.preferences.postLimit;
  hydrateForms();
  bindEvents();
  setupInfiniteScroll();
  renderPersonalFeed([]);
  renderLoading(elements.globalFeed, 3);
  renderTopics(elements.globalTopics, []);
  updateSessionState("offline", "offline");
  updateComposerState();
  await restorePersistedSession();
  await refreshGlobalFeed();
}

function bindEvents() {
  elements.loginForm?.addEventListener("submit", handleLoginSubmit);
  elements.controlsForm?.addEventListener("change", handleControlsChange);
  elements.composeForm?.addEventListener("submit", handleComposeSubmit);
  elements.composeImageInput?.addEventListener("change", handleComposeImagesSelected);
  elements.composePreviews?.addEventListener("input", handleComposePreviewInput);
  elements.composePreviews?.addEventListener("click", handleComposePreviewClick);

  document.querySelectorAll("[data-action]").forEach((button) => {
    button.addEventListener("click", async () => {
      const action = button.dataset.action;

      if (action === "refresh-all") {
        await withButtonBusy(button, "Atualizando...", async () => {
          await Promise.all([
            refreshGlobalFeed({ manual: true }),
            state.session ? refreshPersonalFeed({ manual: true }) : Promise.resolve(),
          ]);
        });
      }

      if (action === "refresh-global") {
        await withButtonBusy(button, "Atualizando...", () =>
          refreshGlobalFeed({ manual: true })
        );
      }

      if (action === "refresh-personal") {
        await withButtonBusy(button, "Atualizando...", () =>
          refreshPersonalFeed({ manual: true })
        );
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

function setupInfiniteScroll() {
  if (!elements.personalSentinel || !("IntersectionObserver" in window)) {
    return;
  }

  personalObserver = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          loadMorePersonalFeed();
        }
      });
    },
    {
      rootMargin: "0px 0px 220px 0px",
      threshold: 0.01,
    }
  );

  personalObserver.observe(elements.personalSentinel);
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

async function withButtonBusy(button, label, task) {
  if (!button) {
    return task();
  }

  const originalLabel = button.dataset.originalLabel || button.textContent.trim();
  button.dataset.originalLabel = originalLabel;
  button.disabled = true;
  button.textContent = label;

  try {
    return await task();
  } finally {
    button.disabled = false;
    button.textContent = originalLabel;
  }
}

async function restorePersistedSession() {
  const persisted = loadStoredSession();
  if (!persisted) {
    return;
  }

  state.session = persisted;
  updateSessionState("busy", "restaurando");

  try {
    await refreshStoredSession();
    await loadProfile();
    updateSessionState("online", "online");
    updateComposerState();
    await refreshPersonalFeed();
  } catch (error) {
    console.error(error);
    clearStoredSession();
    state.session = null;
    state.profile = null;
    updateProfileChip();
    updateSessionState("offline", "offline");
    updateComposerState();
  }
}

async function refreshStoredSession() {
  if (!state.session?.refreshJwt) {
    return state.session;
  }

  const refreshed = await apiFetch(
    state.session.service,
    "com.atproto.server.refreshSession",
    {
      method: "POST",
      token: state.session.refreshJwt,
      allowSessionRefresh: false,
    }
  );

  state.session = {
    accessJwt: refreshed.accessJwt,
    refreshJwt: refreshed.refreshJwt || state.session.refreshJwt,
    did: refreshed.did || state.session.did,
    handle: refreshed.handle || state.session.handle,
    service: state.session.service,
  };

  state.preferences.identifier = state.session.handle || state.preferences.identifier;
  state.preferences.service = state.session.service;
  savePreferences();
  persistSession();
  return state.session;
}

function loadStoredSession() {
  try {
    const parsed = JSON.parse(localStorage.getItem(SESSION_STORAGE_KEY) || "null");
    if (!parsed?.accessJwt || !parsed?.refreshJwt || !parsed?.did || !parsed?.service) {
      return null;
    }

    return {
      accessJwt: parsed.accessJwt,
      refreshJwt: parsed.refreshJwt,
      did: parsed.did,
      handle: parsed.handle || "",
      service: normalizeService(parsed.service),
    };
  } catch {
    return null;
  }
}

function persistSession() {
  if (!state.session?.accessJwt || !state.session?.refreshJwt) {
    clearStoredSession();
    return;
  }

  localStorage.setItem(
    SESSION_STORAGE_KEY,
    JSON.stringify({
      accessJwt: state.session.accessJwt,
      refreshJwt: state.session.refreshJwt,
      did: state.session.did,
      handle: state.session.handle,
      service: state.session.service,
    })
  );
}

function clearStoredSession() {
  localStorage.removeItem(SESSION_STORAGE_KEY);
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
      refreshJwt: session.refreshJwt,
      did: session.did,
      handle: session.handle,
      service,
    };

    state.preferences.identifier = session.handle || identifier;
    state.preferences.service = service;
    persistIdentityPreferences();
    persistSession();
    elements.loginForm.elements.namedItem("password").value = "";
    resetPersonalWindowing();
    await loadProfile();
    updateSessionState("online", "online");
    updateComposerState();
    await Promise.all([refreshPersonalFeed(), refreshGlobalFeed()]);
  } catch (error) {
    console.error(error);
    clearStoredSession();
    state.session = null;
    state.profile = null;
    updateProfileChip();
    updateComposerState();
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
  resetPersonalWindowing();

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

function resetPersonalWindowing() {
  state.personalRelaxLevel = 0;
  state.personalWindowHours = Math.max(Number(state.preferences.windowHours || 0.5), 0.5);
  state.personalRenderCount = state.preferences.postLimit;
}

async function handleComposeSubmit(event) {
  event.preventDefault();

  if (!state.session) {
    setComposeStatus("Entre na sua conta para postar.", true);
    return;
  }

  const text = String(elements.composeText?.value || "").trim();
  if (!text && state.composeImages.length === 0) {
    setComposeStatus("Escreva algo ou escolha pelo menos uma imagem.", true);
    return;
  }

  setComposeStatus("Postando...", false);
  setComposerBusy(true);

  try {
    let embed;

    if (state.composeImages.length > 0) {
      const images = [];

      for (const imageItem of state.composeImages) {
        const uploaded = await uploadImage(imageItem.file);
        images.push({
          alt: imageItem.alt.trim(),
          image: uploaded.blob,
          aspectRatio: {
            width: imageItem.width,
            height: imageItem.height,
          },
        });
      }

      embed = {
        $type: "app.bsky.embed.images",
        images,
      };
    }

    const record = {
      $type: "app.bsky.feed.post",
      text,
      createdAt: new Date().toISOString(),
    };

    if (embed) {
      record.embed = embed;
    }

    const created = await apiFetch(state.session.service, "com.atproto.repo.createRecord", {
      method: "POST",
      token: state.session.accessJwt,
      body: {
        repo: state.session.did,
        collection: "app.bsky.feed.post",
        record,
      },
    });

    clearComposeState();
    await refreshPersonalFeed();
    setComposeStatus(`Post publicado: ${buildPostUrl(created.uri, state.session.did)}`, false);
  } catch (error) {
    console.error(error);
    setComposeStatus("NÃ£o consegui publicar agora. Tente novamente.", true);
  } finally {
    setComposerBusy(false);
  }
}

function handleComposeImagesSelected(event) {
  const files = Array.from(event.target.files || []);
  const remainingSlots = MAX_COMPOSER_IMAGES - state.composeImages.length;

  files.slice(0, remainingSlots).forEach((file) => {
    enqueueComposeImage(file).catch((error) => {
      console.error(error);
      setComposeStatus("Alguma imagem falhou ao carregar. Tente outra.", true);
    });
  });

  event.target.value = "";
}

async function enqueueComposeImage(file) {
  const dimensions = await readImageDimensions(file);
  state.composeImages.push({
    id: crypto.randomUUID(),
    file,
    previewUrl: URL.createObjectURL(file),
    alt: "",
    width: dimensions.width,
    height: dimensions.height,
  });

  renderComposePreviews();
}

function handleComposePreviewInput(event) {
  const target = event.target;
  if (!(target instanceof HTMLInputElement) || target.dataset.role !== "compose-alt") {
    return;
  }

  const image = state.composeImages.find((item) => item.id === target.dataset.id);
  if (image) {
    image.alt = target.value;
  }
}

function handleComposePreviewClick(event) {
  const target = event.target;
  if (!(target instanceof HTMLButtonElement) || target.dataset.role !== "compose-remove") {
    return;
  }

  removeComposeImage(target.dataset.id);
}

function removeComposeImage(imageId) {
  const imageIndex = state.composeImages.findIndex((item) => item.id === imageId);
  if (imageIndex === -1) {
    return;
  }

  URL.revokeObjectURL(state.composeImages[imageIndex].previewUrl);
  state.composeImages.splice(imageIndex, 1);
  renderComposePreviews();
}

function renderComposePreviews() {
  if (!elements.composePreviews) {
    return;
  }

  if (state.composeImages.length === 0) {
    elements.composePreviews.hidden = true;
    elements.composePreviews.replaceChildren();
    return;
  }

  const fragment = document.createDocumentFragment();
  state.composeImages.forEach((image) => {
    const node = document.createElement("article");
    node.className = "compose-preview";
    node.innerHTML = `
      <img src="${image.previewUrl}" alt="" />
      <div class="compose-preview__meta">
        <input
          type="text"
          data-role="compose-alt"
          data-id="${image.id}"
          value="${escapeAttribute(image.alt)}"
          placeholder="DescriÃ§Ã£o da imagem (alt)"
        />
        <button class="ghost-button compose-remove" type="button" data-role="compose-remove" data-id="${image.id}">
          Remover
        </button>
      </div>
    `;
    fragment.appendChild(node);
  });

  elements.composePreviews.hidden = false;
  elements.composePreviews.replaceChildren(fragment);
}

function clearComposeState() {
  state.composeImages.forEach((image) => URL.revokeObjectURL(image.previewUrl));
  state.composeImages = [];

  if (elements.composeForm) {
    elements.composeForm.reset();
  }

  renderComposePreviews();
}

function setComposeStatus(message, isError) {
  if (!elements.composeStatus) {
    return;
  }

  elements.composeStatus.textContent = message;
  elements.composeStatus.dataset.error = isError ? "true" : "false";
}

function setComposerBusy(isBusy) {
  if (!elements.composeForm) {
    return;
  }

  Array.from(elements.composeForm.elements).forEach((element) => {
    element.disabled = isBusy;
  });
}

function updateComposerState() {
  if (!elements.composeForm) {
    return;
  }

  const isOnline = Boolean(state.session);
  Array.from(elements.composeForm.elements).forEach((element) => {
    element.disabled = !isOnline;
  });

  setComposeStatus(
    isOnline ? "Poste texto, imagem ou os dois." : "Entre no Bluesky para publicar pela pÃ¡gina.",
    false
  );
}

async function uploadImage(file) {
  if (file.size > 1000000) {
    throw new Error("Image too large");
  }

  return apiFetch(state.session.service, "com.atproto.repo.uploadBlob", {
    method: "POST",
    token: state.session.accessJwt,
    headers: {
      "Content-Type": file.type || "application/octet-stream",
    },
    rawBody: file,
  });
}

async function refreshPersonalFeed(options = {}) {
  if (!state.session) {
    renderPersonalFeed([], "Conecte sua conta para montar o ranking quente do seu following.");
    return;
  }

  if (options.manual) {
    state.personalRelaxLevel = Math.min(state.personalRelaxLevel + 1, 8);
  }

  updateSessionState("busy", "sincronizando");
  if (state.personalFeed.length === 0) {
    renderLoading(elements.personalFeed, 4);
  }

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
  state.personalRanked = rankPersonalFeed(state.rawTimeline, state.preferences, {
    relaxLevel: state.personalRelaxLevel,
    windowHours: state.personalWindowHours,
  });
  state.personalFeed = selectVisiblePersonalFeed(
    state.personalRanked,
    state.personalRenderCount,
    state.personalWindowHours
  );
  renderPersonalFeed(state.personalFeed);
  updatePersonalLoader();
}

async function refreshGlobalFeed(options = {}) {
  if (state.globalFeed.length === 0) {
    renderLoading(elements.globalFeed, 3);
  }

  try {
    if (options.manual) {
      state.globalRefreshDepth = Math.min(state.globalRefreshDepth + 1, GLOBAL_MANUAL_PAGE_LIMIT);
    }

    const pageCount = options.manual ? 1 + state.globalRefreshDepth : 1;
    const { feed: fetchedFeed, cursor } = await fetchGlobalFeedPages(pageCount);
    let nextFeed = fetchedFeed;

    if (options.manual && isMostlySameFeed(state.globalFeed, nextFeed) && cursor) {
      const extraBatch = await fetchGlobalFeedPages(1, cursor, nextFeed.length);
      nextFeed = mergeUniqueByUri([...nextFeed, ...extraBatch.feed]);
      state.globalCursor = extraBatch.cursor || cursor || null;
    } else {
      state.globalCursor = cursor || null;
    }

    state.globalRefreshSerial += 1;
    state.globalFeed = sortGlobalFeed(nextFeed, options.manual);
    renderGlobalFeed(state.globalFeed.slice(0, state.preferences.postLimit));
  } catch (error) {
    console.error(error);
    renderEmptyState(
      elements.globalFeed,
      "Sem hot posts agora",
      "A consulta ao feed global falhou. Recarregue para tentar outra vez."
    );
    renderTopics(elements.globalTopics, []);
  }
}

async function fetchGlobalFeedPages(pageCount, initialCursor = null, rankOffset = 0) {
  const items = [];
  let cursor = initialCursor;

  for (let page = 0; page < pageCount; page += 1) {
    const data = await apiFetch(
      state.session ? state.session.service : PUBLIC_API,
      "app.bsky.feed.getFeed",
      {
        token: state.session ? state.session.accessJwt : undefined,
        params: {
          feed: HOT_FEED_URI,
          limit: GLOBAL_FETCH_LIMIT,
          cursor,
        },
      }
    );

    items.push(
      ...(data.feed || []).map((item, index) =>
        normalizeFeedItem(item, "global", rankOffset + items.length + index + 1)
      )
    );

    cursor = data.cursor || null;
    if (!cursor) {
      break;
    }
  }

  return {
    feed: mergeUniqueByUri(items),
    cursor,
  };
}

function sortGlobalFeed(feedItems, manual = false) {
  return [...feedItems].sort((left, right) => {
    const ageDiff = getAgeMinutes(left) - getAgeMinutes(right);

    if (manual && Math.abs(ageDiff) > 6) {
      return ageDiff;
    }

    if (!manual && Math.abs(ageDiff) > 14) {
      return ageDiff;
    }

    const scoreDiff = scorePost(right, state.preferences) - scorePost(left, state.preferences);
    if (Math.abs(scoreDiff) > 3) {
      return scoreDiff;
    }

    return ageDiff;
  });
}

function updatePersonalLoader() {
  if (!elements.personalLoader) {
    return;
  }

  const nextWindow = getNextWindowHours(state.personalWindowHours);
  const hasHiddenEntries = state.personalRanked.length > state.personalFeed.length;
  const hasMoreWindows = nextWindow > state.personalWindowHours;

  elements.personalLoader.hidden = !state.session || (!hasHiddenEntries && !hasMoreWindows);

  if (!elements.personalLoader.hidden) {
    elements.personalLoader.textContent = hasMoreWindows
      ? `Rolando atÃ© o fim, eu amplio a busca para ${formatWindowLabel(nextWindow)} atrÃ¡s.`
      : "Rolando atÃ© o fim, eu mostro mais posts recentes.";
  }
}

async function loadMorePersonalFeed() {
  if (
    !state.session ||
    state.isLoadingMorePersonal ||
    state.personalRanked.length === 0 ||
    elements.personalLoader?.hidden
  ) {
    return;
  }

  state.isLoadingMorePersonal = true;

  try {
    const nextWindow = getNextWindowHours(state.personalWindowHours);
    if (nextWindow > state.personalWindowHours) {
      state.personalWindowHours = nextWindow;
    }

    state.personalRenderCount += state.preferences.postLimit;
    rerankPersonalFeed();
  } finally {
    state.isLoadingMorePersonal = false;
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

function rankPersonalFeed(feedItems, preferences, options) {
  const normalized = dedupeByUri(
    feedItems
      .map((item) => normalizeFeedItem(item, "personal"))
      .filter((item) => preferences.includeReposts || !isRepost(item))
  );

  const thresholds = getCurrentHotThresholds(options.relaxLevel);
  const recentWindowMinutes = Math.max(options.windowHours * 60, 30);
  const hotNow = normalized
    .filter((item) => isHotNowCandidate(item, thresholds))
    .map((item) => ({
      ...item,
      bucketIndex: getWindowBucketIndex(getAgeMinutes(item)),
      score: scorePost(item, preferences),
    }))
    .sort(compareHotNow);

  const hotUris = new Set(hotNow.map((item) => item.uri));

  const recentMomentum = normalized
    .filter(
      (item) => !hotUris.has(item.uri) && getAgeMinutes(item) <= recentWindowMinutes
    )
    .map((item) => ({
      ...item,
      bucketIndex: getWindowBucketIndex(getAgeMinutes(item)),
      score: scorePost(item, preferences),
    }))
    .sort(compareRecentMomentum);

  const recentUris = new Set(recentMomentum.map((item) => item.uri));

  const fallback = normalized
    .filter((item) => !hotUris.has(item.uri) && !recentUris.has(item.uri))
    .map((item) => ({
      ...item,
      bucketIndex: getWindowBucketIndex(getAgeMinutes(item)),
      score: scorePost(item, preferences),
    }))
    .sort((left, right) => right.score - left.score);

  return [...hotNow, ...recentMomentum, ...fallback].map((item, index) => ({
    ...item,
    rank: index + 1,
  }));
}

function selectVisiblePersonalFeed(ranked, maxCount, windowHours) {
  const unlockedBucketIndexes = getUnlockedBucketIndexes(windowHours);
  const grouped = new Map();

  ranked.forEach((item) => {
    if (!unlockedBucketIndexes.includes(item.bucketIndex)) {
      return;
    }

    if (!grouped.has(item.bucketIndex)) {
      grouped.set(item.bucketIndex, []);
    }

    grouped.get(item.bucketIndex).push(item);
  });

  const selected = [];
  const usedUris = new Set();
  let remaining = maxCount;
  let activeBucketIndexes = unlockedBucketIndexes.filter(
    (bucketIndex) => (grouped.get(bucketIndex) || []).length > 0
  );

  while (remaining > 0 && activeBucketIndexes.length > 0) {
    const quota = Math.max(1, Math.ceil(remaining / activeBucketIndexes.length));

    activeBucketIndexes.forEach((bucketIndex) => {
      const bucket = grouped.get(bucketIndex) || [];
      let taken = 0;

      while (bucket.length > 0 && taken < quota && remaining > 0) {
        const candidate = bucket.shift();
        if (usedUris.has(candidate.uri)) {
          continue;
        }

        usedUris.add(candidate.uri);
        selected.push(candidate);
        taken += 1;
        remaining -= 1;
      }
    });

    activeBucketIndexes = activeBucketIndexes.filter(
      (bucketIndex) => (grouped.get(bucketIndex) || []).length > 0
    );
  }

  return selected;
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

function compareHotNow(left, right) {
  const ageDiff = getAgeMinutes(left) - getAgeMinutes(right);
  if (Math.abs(ageDiff) > 3) {
    return ageDiff;
  }

  return right.score - left.score;
}

function compareRecentMomentum(left, right) {
  const ageDiff = getAgeMinutes(left) - getAgeMinutes(right);
  if (Math.abs(ageDiff) > 10) {
    return ageDiff;
  }

  return right.score - left.score;
}

function getCurrentHotThresholds(relaxLevel) {
  return {
    minEngagement: Math.max(4, BASE_MIN_ENGAGEMENT - relaxLevel * 1.5),
    minVelocity: Math.max(0.18, BASE_MIN_VELOCITY - relaxLevel * 0.08),
  };
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
    updatePersonalLoader();
    return;
  }

  const fragment = document.createDocumentFragment();
  entries.forEach((entry) => {
    fragment.appendChild(buildPostCard(entry));
  });

  elements.personalFeed.replaceChildren(fragment);
  updatePersonalLoader();
}

function renderGlobalFeed(entries) {
  if (!entries.length) {
    renderEmptyState(
      elements.globalFeed,
      "Sem posts globais agora",
      "O feed oficial What's Hot não retornou resultados nesta tentativa."
    );
    renderTopics(elements.globalTopics, []);
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
  renderTopics(elements.globalTopics, extractTrendingTopics(state.globalFeed, "global"));
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
  const likeButton = node.querySelector("[data-like-button]");
  const repostButton = node.querySelector("[data-repost-button]");
  const embed = node.querySelector("[data-embed]");

  node.dataset.source = entry.source;

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

  configureLikeButton(likeButton, entry);
  configureRepostButton(repostButton, entry);

  const embedNodes = buildEmbedNodes(entry.embed);
  if (embedNodes.length > 0) {
    embed.hidden = false;
    embed.replaceChildren(...embedNodes);
  }

  return node;
}

function configureLikeButton(button, entry) {
  if (!button) {
    return;
  }

  const liked = Boolean(entry.viewerLikeUri);
  button.textContent = liked ? "Curtido" : "Curtir";
  button.classList.toggle("is-liked", liked);
  button.disabled = !state.session;

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await toggleLike(entry, button);
  });
}

function configureRepostButton(button, entry) {
  if (!button) {
    return;
  }

  const reposted = Boolean(entry.viewerRepostUri);
  button.textContent = reposted ? "Repostado" : "Repostar";
  button.classList.toggle("is-reposted", reposted);
  button.disabled = !state.session;

  button.addEventListener("click", async (event) => {
    event.preventDefault();
    event.stopPropagation();
    await toggleRepost(entry, button);
  });
}

async function toggleLike(entry, button) {
  if (!state.session) {
    updateSessionState("error", "entre para curtir");
    return;
  }

  button.disabled = true;

  try {
    if (entry.viewerLikeUri) {
      await apiFetch(state.session.service, "com.atproto.repo.deleteRecord", {
        method: "POST",
        token: state.session.accessJwt,
        body: {
          repo: state.session.did,
          collection: "app.bsky.feed.like",
          rkey: entry.viewerLikeUri.split("/").pop(),
        },
      });

      applyLikeMutation(entry.uri, null, -1);
    } else {
      const created = await apiFetch(state.session.service, "com.atproto.repo.createRecord", {
        method: "POST",
        token: state.session.accessJwt,
        body: {
          repo: state.session.did,
          collection: "app.bsky.feed.like",
          record: {
            $type: "app.bsky.feed.like",
            subject: {
              uri: entry.uri,
              cid: entry.cid,
            },
            createdAt: new Date().toISOString(),
          },
        },
      });

      applyLikeMutation(entry.uri, created.uri, 1);
    }

    rerenderVisibleFeeds();
  } catch (error) {
    console.error(error);
    updateSessionState("error", "erro ao curtir");
  } finally {
    button.disabled = !state.session;
  }
}

async function toggleRepost(entry, button) {
  if (!state.session) {
    updateSessionState("error", "entre para repostar");
    return;
  }

  button.disabled = true;

  try {
    if (entry.viewerRepostUri) {
      await apiFetch(state.session.service, "com.atproto.repo.deleteRecord", {
        method: "POST",
        token: state.session.accessJwt,
        body: {
          repo: state.session.did,
          collection: "app.bsky.feed.repost",
          rkey: entry.viewerRepostUri.split("/").pop(),
        },
      });

      applyRepostMutation(entry.uri, null, -1);
    } else {
      const created = await apiFetch(state.session.service, "com.atproto.repo.createRecord", {
        method: "POST",
        token: state.session.accessJwt,
        body: {
          repo: state.session.did,
          collection: "app.bsky.feed.repost",
          record: {
            $type: "app.bsky.feed.repost",
            subject: {
              uri: entry.uri,
              cid: entry.cid,
            },
            createdAt: new Date().toISOString(),
          },
        },
      });

      applyRepostMutation(entry.uri, created.uri, 1);
    }

    rerenderVisibleFeeds();
  } catch (error) {
    console.error(error);
    updateSessionState("error", "erro ao repostar");
  } finally {
    button.disabled = !state.session;
  }
}

function applyLikeMutation(uri, likeUri, delta) {
  state.rawTimeline.forEach((item) => {
    if (item.post?.uri === uri) {
      item.post.likeCount = Math.max(0, Number(item.post.likeCount || 0) + delta);
      item.post.viewer = item.post.viewer || {};
      item.post.viewer.like = likeUri || undefined;
    }
  });

  state.personalRanked = state.personalRanked.map((item) =>
    item.uri === uri
      ? {
          ...item,
          likeCount: Math.max(0, item.likeCount + delta),
          viewerLikeUri: likeUri,
        }
      : item
  );

  state.personalFeed = state.personalFeed.map((item) =>
    item.uri === uri
      ? {
          ...item,
          likeCount: Math.max(0, item.likeCount + delta),
          viewerLikeUri: likeUri,
        }
      : item
  );

  state.globalFeed = state.globalFeed.map((item) =>
    item.uri === uri
      ? {
          ...item,
          likeCount: Math.max(0, item.likeCount + delta),
          viewerLikeUri: likeUri,
        }
      : item
  );
}

function applyRepostMutation(uri, repostUri, delta) {
  state.rawTimeline.forEach((item) => {
    if (item.post?.uri === uri) {
      item.post.repostCount = Math.max(0, Number(item.post.repostCount || 0) + delta);
      item.post.viewer = item.post.viewer || {};
      item.post.viewer.repost = repostUri || undefined;
    }
  });

  state.personalRanked = state.personalRanked.map((item) =>
    item.uri === uri
      ? {
          ...item,
          repostCount: Math.max(0, item.repostCount + delta),
          viewerRepostUri: repostUri,
        }
      : item
  );

  state.personalFeed = state.personalFeed.map((item) =>
    item.uri === uri
      ? {
          ...item,
          repostCount: Math.max(0, item.repostCount + delta),
          viewerRepostUri: repostUri,
        }
      : item
  );

  state.globalFeed = state.globalFeed.map((item) =>
    item.uri === uri
      ? {
          ...item,
          repostCount: Math.max(0, item.repostCount + delta),
          viewerRepostUri: repostUri,
        }
      : item
  );
}

function rerenderVisibleFeeds() {
  renderPersonalFeed(state.personalFeed);
  renderGlobalFeed(state.globalFeed.slice(0, state.preferences.postLimit));
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

function renderTopics(container, topics) {
  if (!container) {
    return;
  }

  if (!topics.length) {
    const empty = document.createElement("p");
    empty.className = "topic-list__empty";
    empty.textContent = "Atualize o feed para eu puxar os temas mais quentes.";
    container.replaceChildren(empty);
    return;
  }

  const fragment = document.createDocumentFragment();
  topics.forEach((topic) => {
    const node = document.createElement("article");
    node.className = "topic-chip";
    node.innerHTML = `
      <strong>${escapeHtml(topic.label)}</strong>
      <span>${escapeHtml(topic.context)}</span>
    `;
    fragment.appendChild(node);
  });

  container.replaceChildren(fragment);
}

function extractTrendingTopics(entries, source) {
  const weights = new Map();

  entries.slice(0, 60).forEach((entry, index) => {
    const rankingWeight = Math.max(1, 14 - index);
    const scoreWeight = Math.max(1, Math.round((entry.score || scorePost(entry, state.preferences)) / 70));
    const freshnessWeight = Math.max(1, 8 - Math.floor(getAgeMinutes(entry) / 12));
    const totalWeight = rankingWeight + scoreWeight + freshnessWeight;

    collectHashtagTopics(entry).forEach((label) => {
      upsertTopic(weights, label, totalWeight, "hashtag");
    });

    collectKeywordTopics(entry).forEach((label) => {
      upsertTopic(weights, label, Math.max(1, Math.round(totalWeight * 0.65)), "keyword");
    });
  });

  return [...weights.values()]
    .sort((left, right) => {
      if (right.weight !== left.weight) {
        return right.weight - left.weight;
      }

      return left.label.localeCompare(right.label, "pt-BR");
    })
    .slice(0, TRENDING_TOPICS_LIMIT)
    .map((topic) => ({
      label: topic.type === "hashtag" ? topic.label : `#${topic.label.replace(/\s+/g, "")}`,
      context:
        source === "personal"
          ? `${topic.count} sinais no seu feed`
          : `${topic.count} sinais no whats hot`,
    }));
}

function collectHashtagTopics(entry) {
  const matches = String(entry.text || "").match(/(^|\s)(#[\p{L}\p{N}_-]{2,40})/gu) || [];
  return [...new Set(matches.map((match) => match.trim().toLowerCase()))];
}

function collectKeywordTopics(entry) {
  const words = String(entry.text || "")
    .toLowerCase()
    .replace(/https?:\/\/\S+/g, " ")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 4 && !STOPWORDS.has(word) && !word.startsWith("#"));

  return [...new Set(words.slice(0, 6))];
}

function upsertTopic(map, label, weight, type) {
  if (!label) {
    return;
  }

  const existing = map.get(label);
  if (existing) {
    existing.weight += weight;
    existing.count += 1;
    return;
  }

  map.set(label, {
    label,
    weight,
    count: 1,
    type,
  });
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
  state.personalRanked = [];
  state.personalFeed = [];
  state.globalFeed = [];
  clearStoredSession();
  resetPersonalWindowing();
  clearComposeState();
  updateProfileChip();
  updateSessionState("offline", "offline");
  updateComposerState();
  renderPersonalFeed([], "Sessão encerrada. Entre novamente para montar seu feed.");
  refreshGlobalFeed();
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
    cid: post.cid,
    viewerLikeUri: post.viewer?.like || null,
    viewerRepostUri: post.viewer?.repost || null,
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

function isHotNowCandidate(item, thresholds) {
  return (
    getAgeMinutes(item) <= RECENT_HOT_WINDOW_MINUTES &&
    getEngagementUnits(item) >= thresholds.minEngagement &&
    getVelocity(item) >= thresholds.minVelocity
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

function mergeUniqueByUri(items) {
  const seen = new Set();
  return items.filter((item) => {
    if (seen.has(item.uri)) {
      return false;
    }

    seen.add(item.uri);
    return true;
  });
}

function isMostlySameFeed(currentFeed, nextFeed) {
  if (!currentFeed.length || !nextFeed.length) {
    return false;
  }

  const currentTop = currentFeed.slice(0, 8).map((item) => item.uri);
  const nextTop = nextFeed.slice(0, 8).map((item) => item.uri);
  const overlap = nextTop.filter((uri) => currentTop.includes(uri)).length;
  return overlap >= Math.min(currentTop.length, nextTop.length) - 1;
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

function getNextWindowHours(currentWindowHours) {
  const normalizedCurrent = normalizeWindowValue(currentWindowHours);
  return WINDOW_SEQUENCE.find((value) => value > normalizedCurrent) || normalizedCurrent;
}

function getUnlockedBucketIndexes(windowHours) {
  const cutoffMinutes = normalizeWindowValue(windowHours) * 60;
  return WINDOW_SEQUENCE.map((value, index) => ({ value, index }))
    .filter((item) => item.value * 60 <= cutoffMinutes)
    .map((item) => item.index);
}

function getWindowBucketIndex(ageMinutes) {
  const ageHours = ageMinutes / 60;
  const foundIndex = WINDOW_SEQUENCE.findIndex((windowValue) => ageHours <= windowValue);
  return foundIndex === -1 ? WINDOW_SEQUENCE.length : foundIndex;
}

function normalizeWindowValue(windowHours) {
  const normalized = Number(windowHours || 0.5);
  return WINDOW_SEQUENCE.includes(normalized) ? normalized : 0.5;
}

function formatWindowLabel(windowHours) {
  if (windowHours < 1) {
    return `${Math.round(windowHours * 60)} minutos`;
  }

  if (Number.isInteger(windowHours)) {
    return `${windowHours} hora${windowHours > 1 ? "s" : ""}`;
  }

  return `${String(windowHours).replace(".", ",")} horas`;
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

  const headers = {
    ...(options.token ? { Authorization: `Bearer ${options.token}` } : {}),
    ...(options.headers || {}),
  };

  if (!options.rawBody && options.body) {
    headers["Content-Type"] = "application/json";
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.rawBody || (options.body ? JSON.stringify(options.body) : undefined),
  });

  if (!response.ok) {
    if (
      response.status === 401 &&
      options.allowSessionRefresh !== false &&
      state.session?.refreshJwt &&
      options.token &&
      options.token === state.session.accessJwt
    ) {
      await refreshStoredSession();
      return apiFetch(baseUrl, nsid, {
        ...options,
        token: state.session.accessJwt,
        allowSessionRefresh: false,
      });
    }

    const errorText = await response.text();
    throw new Error(`${nsid} failed: ${response.status} ${errorText}`);
  }

  const text = await response.text();
  return text ? JSON.parse(text) : {};
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
      rankingVersion: 3,
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

function escapeAttribute(value) {
  return escapeHtml(value);
}

function readImageDimensions(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    image.onload = () => {
      resolve({
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      URL.revokeObjectURL(url);
    };

    image.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("Failed to read image"));
    };

    image.src = url;
  });
}
