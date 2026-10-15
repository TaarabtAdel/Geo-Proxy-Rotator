// Geo Proxy Rotator — service worker MV3.
// Luồng: đặt proxy HTTP -> mở tab kiểm tra IP -> giả lập toạ độ/múi giờ -> mở lần lượt bài viết.
// Trạng thái chạy nằm trong chrome.storage.session để khôi phục khi service worker bị tắt giữa chừng.
importScripts("data/us_locations.js", "data/parse_proxy.js", "data/proxy-sources.js", "data/shared-store.js");

const CHECK_HOST = "api.ipify.org";
const CHECK_URL = "https://api.ipify.org?format=json";
const SESSION_KEY = "run";
const ALARM_NEXT = "gpr-next";
const ALARM_CHECK = "gpr-check";
const ALARM_LOAD = "gpr-load";
const ALARM_WATCH = "gpr-watch";
const ALARM_SWITCH = "gpr-switch";
const ALARM_BUSY = "gpr-busy";
const ALARM_SPOOF = "gpr-spoof";
const API_SOURCE = "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=US&ssl=all&anonymity=all";
const JSDELIVR_SOURCE = "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/countries/us/data.json";
const DEFAULT_SOURCE = self.DEFAULT_PROXY_SOURCES || (API_SOURCE + "\n" + JSDELIVR_SOURCE);

const PHASE_LABEL = {
  idle: "Sẵn sàng",
  applying_proxy: "Đang đặt proxy",
  checking: "Đang kiểm tra kết nối",
  spoofing: "Đang giả lập vị trí",
  loading_article: "Đang mở bài viết",
  waiting: "Đang chờ bài tiếp theo",
  switching: "Đang chuyển proxy"
};

// alive/generation nằm trong bộ nhớ để hủy bước đang chạy ngay khi bấm Dừng,
// kể cả khi service worker chưa kịp ghi storage.
let alive = false;
let generation = 0;
let currentAuth = null;
let authAttempts = 0;
let intentionalDetach = false;
let reattachFails = 0;
let checkTimer = null;
let loadTimer = null;
let switchTimer = null;
let spoofTimer = null;
let installedScriptKey = "";
let mem = null;
let lock = Promise.resolve();
let flow = Promise.resolve();
const probeScheduled = new Set();
let doneMap = null;
let doneMapAt = 0;
let healthMap = null;
let profileKey = "";
let heldKey = "";
let heldTouchAt = 0;
let openingProxy = false;

function defaultState() {
  return {
    running: false,
    gen: 0,
    phase: "idle",
    proxyIndex: 0,
    articleIndex: 0,
    tabId: null,
    nav: 0,
    nextArticleAt: null,
    checkDeadline: null,
    loadDeadline: null,
    switchDeadline: null,
    spoofDeadline: null,
    expectedUrl: "",
    currentProxy: "",
    location: null,
    failedCount: 0,
    logs: [],
    proxyAuth: null,
    snapshot: null,
    stopReason: "",
    debuggerAttached: false,
    articleStatus: 0,
    articleError: "",
    navStartedAt: 0
  };
}

function report(err) {
  console.error("[Geo Proxy Rotator]", err);
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runFlow(fn) {
  const job = flow.then(() => fn(), () => fn());
  flow = job.then(() => {}, () => {});
  return job;
}

function updateState(mutator) {
  const run = lock.then(async () => {
    if (!mem) {
      const stored = await chrome.storage.session.get(SESSION_KEY);
      mem = { ...defaultState(), ...(stored[SESSION_KEY] || {}) };
      if (!Array.isArray(mem.logs)) mem.logs = [];
    }
    const draft = {
      ...mem,
      logs: mem.logs.map((entry) => ({ ...entry })),
      location: mem.location ? { ...mem.location } : null,
      proxyAuth: mem.proxyAuth ? { ...mem.proxyAuth } : null,
      snapshot: mem.snapshot
    };
    const next = mutator(draft) || draft;
    mem = next;
    await chrome.storage.session.set({ [SESSION_KEY]: mem });
    return mem;
  });
  lock = run.then(() => {}, () => {});
  return run;
}

function getState() {
  return updateState((state) => state);
}

function addLog(level, message) {
  return updateState((state) => {
    state.logs.unshift({
      ts: Date.now(),
      level,
      message: String(message || "").slice(0, 300)
    });
    if (state.logs.length > 20) state.logs.length = 20;
    return state;
  });
}

function still(gen) {
  return alive && generation === gen;
}

function formatProxy(proxy) {
  const protocol = proxy.protocol && proxy.protocol !== "http" ? proxy.protocol + "://" : "";
  const base = protocol + proxy.host + ":" + proxy.port;
  return proxy.username ? base + " (có xác thực)" : base;
}

function proxyStorageKey(proxy) {
  return self.proxyKey ? self.proxyKey(proxy) : proxy.host + ":" + proxy.port;
}

async function profileId() {
  if (profileKey) return profileKey;
  const stored = await chrome.storage.local.get("profileId");
  if (stored.profileId) {
    profileKey = String(stored.profileId);
    return profileKey;
  }
  profileKey = crypto.randomUUID();
  await chrome.storage.local.set({ profileId: profileKey });
  return profileKey;
}

function rememberDoneCache(map) {
  doneMap = map && typeof map === "object" && !Array.isArray(map) ? map : {};
  doneMapAt = Date.now();
}

async function readProxyHealthMap() {
  const data = await self.sharedStore.readData();
  healthMap = data.proxyHealth || {};
  return healthMap;
}

async function setProxyHealth(proxy, status, extra) {
  if (!proxy) return;
  const key = proxyStorageKey(proxy);
  const owner = await profileId();
  const saved = await self.sharedStore.update(function (data) {
    const prev = data.proxyHealth[key] || {};
    data.proxyHealth[key] = {
      status: status,
      updatedAt: Date.now(),
      owner: owner,
      ip: extra && extra.ip ? String(extra.ip) : (prev.ip || ""),
      note: extra && extra.note ? String(extra.note).slice(0, 160) : (prev.note || "")
    };
    return data;
  });
  healthMap = saved && saved.proxyHealth ? saved.proxyHealth : healthMap;
}

async function releaseKey(key) {
  if (!key) return;
  const owner = await profileId();
  if (heldKey === key) heldKey = "";
  try {
    await self.sharedStore.update(function (data) {
      const lease = data.proxyLease && data.proxyLease[key];
      if (lease && lease.owner === owner) delete data.proxyLease[key];
      return data;
    });
  } catch (err) {
    report(err);
  }
}

async function releaseHeld() {
  await releaseKey(heldKey);
}

async function touchHeld() {
  if (!heldKey) return;
  if (Date.now() - heldTouchAt < 60000) return;
  const key = heldKey;
  const owner = await profileId();
  heldTouchAt = Date.now();
  try {
    await self.sharedStore.update(function (data) {
      const lease = data.proxyLease && data.proxyLease[key];
      if (!lease || lease.owner !== owner) return data;
      data.proxyLease[key] = { owner: owner, claimedAt: Date.now() };
      return data;
    });
  } catch (err) {
    heldTouchAt = 0;
    report(err);
  }
}

// Giữ đúng proxy đang mở. Profile khác thấy lease còn hạn thì bỏ qua.
async function takeProxy(proxies, start, articles) {
  const owner = await profileId();
  const now = Date.now();
  const leaseMs = self.sharedStore.LEASE_MS || 180000;
  let chosen = -1;
  let skippedDead = 0;
  let skippedDone = 0;
  let skippedBusy = 0;
  let lost = false;
  const saved = await self.sharedStore.update(function (data) {
    if (!data.proxyLease || typeof data.proxyLease !== "object" || Array.isArray(data.proxyLease)) data.proxyLease = {};
    const order = [];
    for (let i = start; i < proxies.length; i++) order.push(i);
    for (let i = 0; i < start; i++) order.push(i);
    for (const i of order) {
      const proxy = proxies[i];
      const key = proxyStorageKey(proxy);
      if (isDeadProxy(data.proxyHealth, proxy)) {
        skippedDead += 1;
        continue;
      }
      if (!pendingPairExists([proxy], articles, data.proxyArticleDone || {})) {
        skippedDone += 1;
        continue;
      }
      const lease = data.proxyLease[key];
      if (lease && lease.owner !== owner && now - Number(lease.claimedAt || 0) < leaseMs) {
        skippedBusy += 1;
        continue;
      }
      const prev = data.proxyHealth[key] || {};
      data.proxyHealth[key] = {
        status: "pending",
        updatedAt: now,
        owner: owner,
        ip: prev.ip || "",
        note: "Đang dùng"
      };
      data.proxyLease[key] = { owner: owner, claimedAt: now };
      chosen = i;
      return data;
    }
    return data;
  });
  if (chosen >= 0) {
    const key = proxyStorageKey(proxies[chosen]);
    const lease = saved.proxyLease && saved.proxyLease[key];
    if (!lease || lease.owner !== owner) {
      lost = true;
      chosen = -1;
    } else if (heldKey && heldKey !== key) {
      const prev = heldKey;
      heldKey = key;
      heldTouchAt = now;
      await releaseKey(prev);
    } else {
      heldKey = key;
      heldTouchAt = now;
    }
  }
  if (saved && saved.proxyHealth) healthMap = saved.proxyHealth;
  if (saved && saved.proxyArticleDone) rememberDoneCache(saved.proxyArticleDone);
  return { chosen: chosen, skippedDead: skippedDead, skippedDone: skippedDone, skippedBusy: skippedBusy, lost: lost };
}

function isDeadProxy(health, proxy) {
  const entry = health && health[proxyStorageKey(proxy)];
  return Boolean(entry && entry.status === "dead");
}

async function ensureDoneMap() {
  if (doneMap && Date.now() - doneMapAt < 8000) return doneMap;
  const data = await self.sharedStore.readData();
  rememberDoneCache(data.proxyArticleDone);
  healthMap = data.proxyHealth || healthMap;
  return doneMap;
}

function articleAlreadyRun(map, proxy, url) {
  if (!proxy || !url || !map) return false;
  const list = map[proxyStorageKey(proxy)];
  if (!Array.isArray(list)) return false;
  return list.some((entry) => self.sharedStore.pairUrl(entry) === url);
}

function pendingPairExists(proxies, articles, map) {
  for (const proxy of proxies || []) {
    for (const url of articles || []) {
      if (!articleAlreadyRun(map, proxy, url)) return true;
    }
  }
  return false;
}

async function rememberProxyArticle(proxy, url, outcome) {
  if (!proxy || !url) return;
  const key = proxyStorageKey(proxy);
  const now = Date.now();
  const incoming = outcome && typeof outcome.ok === "boolean"
    ? { url: url, ok: outcome.ok, note: outcome.ok ? "" : String(outcome.note || "").slice(0, 160), at: now }
    : url;
  const data = await self.sharedStore.update(function (store) {
    const list = Array.isArray(store.proxyArticleDone[key]) ? store.proxyArticleDone[key].slice() : [];
    const index = list.findIndex((entry) => self.sharedStore.pairUrl(entry) === url);
    const merged = self.sharedStore.mergePair(index >= 0 ? list[index] : null, incoming);
    if (!merged) return store;
    if (index >= 0) list[index] = merged;
    else list.push(merged);
    store.proxyArticleDone[key] = list;
    return store;
  });
  rememberDoneCache(data.proxyArticleDone);
}

function articleOutcome(state, reason) {
  const err = String(state && state.articleError || "");
  const status = Number(state && state.articleStatus) || 0;
  if ((err && err !== "net::ERR_ABORTED") || status >= 400) {
    const note = err && err !== "chrome-error" ? err : ("HTTP " + status);
    return { ok: false, note: note.slice(0, 160) };
  }
  if (state && state.phase === "loading_article") {
    return { ok: false, note: String(reason || "Chưa tải xong").slice(0, 160) };
  }
  return { ok: true };
}

async function rememberCurrentArticle(state, outcome) {
  if (!state || !state.snapshot) return;
  const proxy = state.snapshot.proxies[state.proxyIndex];
  const url = state.snapshot.articles[state.articleIndex];
  await rememberProxyArticle(proxy, url, outcome);
}

function shortenUrl(url) {
  try {
    const parsed = new URL(url);
    return (parsed.host + parsed.pathname + parsed.search).slice(0, 72);
  } catch (err) {
    return String(url || "").slice(0, 72);
  }
}

function pickLocation() {
  const list = self.US_LOCATIONS || [];
  if (!list.length) throw new Error("Thiếu danh sách vị trí USA");
  return list[Math.floor(Math.random() * list.length)];
}

function pickWait(min, max) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

function isHttpUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch (err) {
    return false;
  }
}

function hostKey(hostname) {
  return String(hostname || "").replace(/^www\./i, "").toLowerCase();
}

function sameSite(actualUrl, expectedUrl) {
  try {
    const actual = hostKey(new URL(actualUrl).hostname);
    const expected = hostKey(new URL(expectedUrl).hostname);
    if (!actual || !expected) return false;
    return actual === expected || actual.endsWith("." + expected) || expected.endsWith("." + actual);
  } catch (err) {
    return false;
  }
}

function articlePathKey(raw) {
  try {
    const url = new URL(raw);
    const path = url.pathname.replace(/\/+$/, "") || "/";
    return hostKey(url.hostname) + path;
  } catch (err) {
    return "";
  }
}

// Tab còn đứng ở bài trước (cùng site) không được tính là bài đang mở đã tải xong.
function isOtherListedArticle(actualUrl, expectedUrl, articles) {
  const key = articlePathKey(actualUrl);
  const expectedKey = articlePathKey(expectedUrl);
  if (!key || key === expectedKey) return false;
  return (articles || []).some((item) => articlePathKey(item) === key);
}

// Trang bài hợp lệ: http(s), không phải trang kiểm tra IP (kể cả redirect sang domain khác).
function isArticlePageUrl(url) {
  if (!url || url === "about:blank" || url.startsWith("chrome-error://")) return false;
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
    return hostKey(parsed.hostname) !== hostKey(CHECK_HOST);
  } catch (err) {
    return false;
  }
}

function articleFailedToLoad(state, tabUrl) {
  const url = String(tabUrl || "");
  const err = String(state?.articleError || "");
  const status = Number(state?.articleStatus) || 0;
  if (status === 407 || (err && isFatalProxyError(err))) return false;

  if (url.startsWith("chrome-error://")) return true;
  if (err && err !== "net::ERR_ABORTED" && err !== "chrome-error") return true;
  if (status >= 400) return true;
  if (!isArticlePageUrl(url)) return true;
  return false;
}

async function stopTabLoading(tabId) {
  if (tabId == null) return;
  try {
    await chrome.debugger.sendCommand({ tabId }, "Page.stopLoading");
  } catch (err) {
    // Tab có thể chưa gắn debugger hoặc đã dừng tải.
  }
}

const SCROLL_PRESETS = {
  slow: { tickMin: 1600, tickMax: 3400, stepMin: 50, stepMax: 120 },
  normal: { tickMin: 900, tickMax: 2600, stepMin: 85, stepMax: 210 },
  fast: { tickMin: 500, tickMax: 1400, stepMin: 110, stepMax: 260 }
};

function resolveScrollSettings(snapshot) {
  if (!snapshot || snapshot.scrollEnabled === false) return null;
  const preset = SCROLL_PRESETS[snapshot.scrollSpeed] || SCROLL_PRESETS.normal;
  return {
    depth: clampRange(snapshot.scrollDepthPercent, 50, 100, 95) / 100,
    tickMin: preset.tickMin,
    tickMax: preset.tickMax,
    stepMin: preset.stepMin,
    stepMax: preset.stepMax
  };
}

function buildHumanScrollSource(settings) {
  return (
    "(function(){if(window.__gprScrollTimer){clearTimeout(window.__gprScrollTimer);window.__gprScrollTimer=null;}" +
    "window.__gprScrollStop=false;function rnd(a,b){return a+Math.random()*(b-a);}" +
    "function maxY(){var d=document.documentElement,b=document.body,h=d&&d.scrollHeight||0,hb=b&&b.scrollHeight||0;" +
    "return Math.max(0,Math.max(h,hb)-window.innerHeight)*" + settings.depth + ";}" +
    "function topY(){return window.scrollY||document.documentElement.scrollTop||document.body.scrollTop||0;}" +
    "function tick(){if(window.__gprScrollStop)return;var target=maxY(),y=topY();" +
    "if(y>=target-4){window.scrollTo({top:target,behavior:'smooth'});return;}" +
    "var step=rnd(" + settings.stepMin + "," + settings.stepMax + ");" +
    "window.scrollTo({top:Math.min(target,y+step),behavior:'smooth'});" +
    "window.__gprScrollTimer=setTimeout(tick,rnd(" + settings.tickMin + "," + settings.tickMax + "));}" +
    "window.__gprScrollTimer=setTimeout(tick,rnd(500,1600));})();"
  );
}

function withTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error(message || "Quá hạn"));
    }, ms);
    Promise.resolve(promise).then((value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    }, (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

async function stopHumanScroll(tabId) {
  if (tabId == null) return;
  try {
    await withTimeout(chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: "window.__gprScrollStop=true;if(window.__gprScrollTimer){clearTimeout(window.__gprScrollTimer);window.__gprScrollTimer=null;}",
      userGesture: false
    }), 3000);
  } catch (err) {
    // Tab có thể chưa gắn debugger.
  }
}

async function beginHumanScroll(tabId, snapshot) {
  const settings = resolveScrollSettings(snapshot);
  if (!settings || tabId == null || !alive) return;
  try {
    await stopHumanScroll(tabId);
    await chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
      expression: buildHumanScrollSource(settings),
      userGesture: false
    });
  } catch (err) {
    report(err);
  }
}

function isOurMainFrame(details) {
  if (!alive || !details || details.type !== "main_frame" || details.tabId < 0) return false;
  if (mem && mem.tabId != null && details.tabId !== mem.tabId) return false;
  return true;
}

function isProxyNetError(error) {
  const text = String(error || "");
  return /ERR_PROXY_|ERR_TUNNEL_|ERR_SOCKS_|ERR_CONNECTION_|ERR_TIMED_OUT|ERR_EMPTY_RESPONSE|ERR_ADDRESS_UNREACHABLE|ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_TOO_MANY_RETRIES|ERR_FAILED/.test(text);
}

// Chỉ những lỗi này chứng tỏ proxy chết. Lỗi mạng lẻ của tab khác không được tính.
function isFatalProxyError(error) {
  const text = String(error || "");
  return /ERR_PROXY_CONNECTION_FAILED|ERR_TUNNEL_CONNECTION_FAILED|ERR_PROXY_CERTIFICATE_INVALID|ERR_PROXY_AUTH_UNSUPPORTED|ERR_PROXY_AUTH_REQUESTED|ERR_MANDATORY_PROXY_CONFIGURATION_FAILED/.test(text);
}

function articleSkipReason(status, error) {
  const text = String(error || "");
  if (/ERR_CERT_AUTHORITY_INVALID/i.test(text)) return "ERR_CERT_AUTHORITY_INVALID";
  if (Number(status) === 403) return "HTTP 403";
  return "";
}

function isStaleNavigation(details, state) {
  if (!details || !state || !state.navStartedAt || !details.timeStamp) return false;
  return details.timeStamp < state.navStartedAt - 250;
}

function hostnameOf(raw) {
  try {
    return new URL(raw).hostname;
  } catch (err) {
    return "";
  }
}

function buildBypass(sourceUrl) {
  const hosts = ["<local>", "localhost", "127.0.0.1", "::1"];
  const raws = String(sourceUrl || "").split(/\s+/).concat([API_SOURCE, JSDELIVR_SOURCE]);
  for (const raw of raws) {
    const host = hostnameOf(raw);
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

function clearCheckTimer() {
  if (checkTimer) clearTimeout(checkTimer);
  checkTimer = null;
}

function clearLoadTimer() {
  if (loadTimer) clearTimeout(loadTimer);
  loadTimer = null;
}

function clearSwitchTimer() {
  if (switchTimer) clearTimeout(switchTimer);
  switchTimer = null;
}

function switchBudgetMs(snapshot) {
  const sec = snapshot && snapshot.proxyTimeoutSec ? snapshot.proxyTimeoutSec : 15;
  return sec * 1000;
}

function armSwitchTimer(deadline, gen) {
  clearSwitchTimer();
  switchTimer = setTimeout(() => {
    runFlow(() => onSwitchTimeout(gen)).catch(report);
  }, Math.max(0, deadline - Date.now()));
}

function clearSpoofTimer() {
  if (spoofTimer) clearTimeout(spoofTimer);
  spoofTimer = null;
}

function armSpoofTimer(deadline, gen) {
  clearSpoofTimer();
  spoofTimer = setTimeout(() => {
    runFlow(() => onSpoofTimeout(gen)).catch(report);
  }, Math.max(0, deadline - Date.now()));
}

async function armSpoofDeadline(gen) {
  const state = await getState();
  const deadline = Date.now() + switchBudgetMs(state.snapshot);
  await updateState((current) => {
    if (current.gen !== gen || current.phase !== "spoofing") return current;
    current.spoofDeadline = deadline;
    return current;
  });
  armSpoofTimer(deadline, gen);
  try {
    await chrome.alarms.create(ALARM_SPOOF, { when: deadline });
  } catch (err) {
    report(err);
  }
  return deadline;
}

async function clearSpoofDeadline() {
  clearSpoofTimer();
  try {
    await chrome.alarms.clear(ALARM_SPOOF);
  } catch (err) {
    report(err);
  }
}

function armCheckTimer(deadline, nav) {
  clearCheckTimer();
  checkTimer = setTimeout(() => {
    runFlow(() => onCheckTimeout(nav)).catch(report);
  }, Math.max(0, deadline - Date.now()));
}

function armLoadTimer(deadline, nav) {
  clearLoadTimer();
  loadTimer = setTimeout(() => {
    runFlow(() => onLoadTimeout(nav, true)).catch(report);
  }, Math.max(0, deadline - Date.now()));
}

async function loadConfig() {
  const stored = await self.sharedStore.readData();
  const cfg = Object.assign({
    proxySourceUrl: DEFAULT_SOURCE,
    proxyText: "",
    proxies: [],
    articles: [],
    waitMinSec: 100,
    waitMaxSec: 120,
    proxyTimeoutSec: 15,
    articleLoadTimeoutSec: 60,
    scrollEnabled: true,
    scrollSpeed: "normal",
    scrollDepthPercent: 95,
    loop: false
  }, stored.config || {});
  // Ưu tiên text người dùng đang lưu, rồi mới tới mảng đã parse.
  const parsed = self.parseProxySource(cfg.proxyText || "");
  const proxies = parsed.proxies.length ? parsed.proxies : (Array.isArray(cfg.proxies) ? cfg.proxies : []);
  const articles = (Array.isArray(cfg.articles) ? cfg.articles : []).map((url) => String(url).trim()).filter(isHttpUrl);
  const waitMinSec = clampSec(cfg.waitMinSec, 100);
  const waitMaxSec = clampSec(cfg.waitMaxSec, 120);
  return {
    proxies,
    articles,
    waitMinSec: Math.min(waitMinSec, waitMaxSec),
    waitMaxSec: Math.max(waitMinSec, waitMaxSec),
    proxyTimeoutSec: clampRange(cfg.proxyTimeoutSec, 5, 180, 15),
    articleLoadTimeoutSec: clampRange(cfg.articleLoadTimeoutSec, 15, 300, 60),
    scrollEnabled: cfg.scrollEnabled !== false,
    scrollSpeed: ["slow", "normal", "fast"].includes(cfg.scrollSpeed) ? cfg.scrollSpeed : "normal",
    scrollDepthPercent: clampRange(cfg.scrollDepthPercent, 50, 100, 95),
    loop: Boolean(cfg.loop),
    bypass: buildBypass(cfg.proxySourceUrl || DEFAULT_SOURCE)
  };
}

function clampSec(value, fallback) {
  return clampRange(value, 1, 3600, fallback);
}

function clampRange(value, min, max, fallback) {
  const number = Math.round(Number(value));
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

async function applyProxySettings(proxy, bypass) {
  await chrome.proxy.settings.set({
    value: {
      mode: "fixed_servers",
      rules: {
        singleProxy: {
          scheme: proxy.protocol === "socks4" || proxy.protocol === "socks5" ? proxy.protocol : "http",
          host: proxy.host,
          port: Number(proxy.port)
        },
        bypassList: bypass && bypass.length ? bypass : ["<local>"]
      }
    },
    scope: "regular"
  });
}

async function clearProxySettings() {
  currentAuth = null;
  authAttempts = 0;
  try {
    await chrome.proxy.settings.clear({ scope: "regular" });
  } catch (err) {
    report(err);
  }
}

async function clearAlarms() {
  try {
    const alarms = await chrome.alarms.getAll();
    await Promise.all(alarms.filter((alarm) => alarm.name.startsWith("gpr-")).map((alarm) => chrome.alarms.clear(alarm.name)));
  } catch (err) {
    report(err);
  }
}

async function detachQuiet() {
  const state = await getState();
  await stopHumanScroll(state.tabId);
  installedScriptKey = "";
  intentionalDetach = true;
  await updateState((current) => {
    current.debuggerAttached = false;
    return current;
  });
  if (state.tabId != null) {
    try {
      await withTimeout(chrome.debugger.detach({ tabId: state.tabId }), 3000);
    } catch (err) {
      // Tab có thể đã đóng hoặc chưa từng được gắn debugger.
    }
  }
  intentionalDetach = false;
}

function geoScript(location) {
  const lat = Number(location.lat);
  const lng = Number(location.lng);
  // Chạy trước script của trang: trả vị trí giả và coi như đã cấp quyền geolocation.
  return `(() => {
    const position = () => ({
      coords: {
        latitude: ${lat},
        longitude: ${lng},
        accuracy: 100,
        altitude: null,
        altitudeAccuracy: null,
        heading: null,
        speed: null
      },
      timestamp: Date.now()
    });
    try {
      const geo = navigator.geolocation;
      geo.getCurrentPosition = (ok) => { try { ok(position()); } catch (e) {} };
      geo.watchPosition = (ok) => { try { ok(position()); } catch (e) {} return 1; };
    } catch (e) {}
    try {
      if (navigator.permissions && navigator.permissions.query) {
        const original = navigator.permissions.query.bind(navigator.permissions);
        navigator.permissions.query = (params) => (
          params && params.name === "geolocation"
            ? Promise.resolve({ state: "granted", onchange: null })
            : original(params)
        );
      }
    } catch (e) {}
  })();`;
}

async function grantGeolocation(tabId, origin) {
  const tabTarget = { tabId };
  try {
    await chrome.debugger.sendCommand(tabTarget, "Browser.grantPermissions", {
      origin,
      permissions: ["geolocation"]
    });
    return;
  } catch (err) {
    // Một số bản Chrome chỉ nhận lệnh này trên browser target.
  }
  const targets = await chrome.debugger.getTargets();
  const browser = targets.find((target) => target.type === "browser");
  if (!browser) return;
  const browserTarget = { targetId: browser.id };
  try {
    await chrome.debugger.attach(browserTarget, "1.3");
  } catch (err) {
    if (!/already attached/i.test(String(err && err.message || err))) throw err;
  }
  try {
    await chrome.debugger.sendCommand(browserTarget, "Browser.grantPermissions", {
      origin,
      permissions: ["geolocation"]
    });
  } finally {
    if (!browser.attached) {
      try {
        await chrome.debugger.detach(browserTarget);
      } catch (err) {
        report(err);
      }
    }
  }
}

async function attachDebugger(tabId) {
  try {
    await chrome.debugger.attach({ tabId }, "1.3");
  } catch (err) {
    const message = String(err && err.message || err);
    if (!/already attached/i.test(message)) throw err;
  }
}

// Gắn debugger, ghi đè GPS + múi giờ, rồi xin quyền geolocation cho đúng origin của bài.
async function prepareLocation(tabId, location, pageUrl, installScript) {
  if (!alive) return;
  await withTimeout(attachDebugger(tabId), 8000, "Quá hạn gắn debugger");
  if (!alive) return;
  const target = { tabId };
  await withTimeout(chrome.debugger.sendCommand(target, "Emulation.setGeolocationOverride", {
    latitude: Number(location.lat),
    longitude: Number(location.lng),
    accuracy: 100
  }), 5000, "Quá hạn giả lập GPS");
  await withTimeout(chrome.debugger.sendCommand(target, "Emulation.setTimezoneOverride", {
    timezoneId: location.timezone
  }), 5000, "Quá hạn giả lập múi giờ");
  const scriptKey = tabId + ":" + location.lat + ":" + location.lng;
  if (installScript && installedScriptKey !== scriptKey) {
    try {
      await withTimeout(chrome.debugger.sendCommand(target, "Page.addScriptToEvaluateOnNewDocument", {
        source: geoScript(location)
      }), 5000, "Quá hạn chèn script vị trí");
      installedScriptKey = scriptKey;
    } catch (err) {
      await addLog("info", "Không chèn được script vị trí dự phòng.");
    }
  }
  if (!alive) return;
  if (pageUrl && isHttpUrl(pageUrl)) {
    try {
      await withTimeout(grantGeolocation(tabId, new URL(pageUrl).origin), 8000, "Quá hạn cấp geolocation");
    } catch (err) {
      await addLog("info", "Không cấp được quyền geolocation tự động, vẫn giữ toạ độ giả lập.");
    }
  }
  reattachFails = 0;
  await updateState((state) => {
    state.debuggerAttached = true;
    state.tabId = tabId;
    return state;
  });
}

async function ensureTab(url) {
  const state = await getState();
  if (state.tabId != null) {
    try {
      await chrome.tabs.get(state.tabId);
      if (url) await chrome.tabs.update(state.tabId, { url, active: true });
      return state.tabId;
    } catch (err) {
      // Tab đã bị đóng tay.
    }
  }
  const tab = await chrome.tabs.create({ url: url || "about:blank", active: true });
  await updateState((current) => {
    current.tabId = tab.id;
    return current;
  });
  return tab.id;
}

async function readEgressIp() {
  try {
    const response = await fetch(CHECK_URL + "&t=" + Date.now(), {
      cache: "no-store",
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return "";
    const data = await response.json();
    return data && data.ip ? String(data.ip) : "";
  } catch (err) {
    return "";
  }
}

async function beginRun(gen) {
  if (!still(gen)) return { ok: false, error: "Đã bị ngắt" };
  const config = await loadConfig();
  if (!still(gen)) return { ok: false, error: "Đã bị ngắt" };
  if (!config.proxies.length) throw new Error("Chưa có proxy. Mở Cài đặt để thêm proxy.");
  if (!config.articles.length) throw new Error("Chưa có link bài viết hợp lệ. Mở Cài đặt để thêm URL.");

  const snapshot = {
    proxies: config.proxies,
    articles: config.articles,
    waitMinSec: config.waitMinSec,
    waitMaxSec: config.waitMaxSec,
    proxyTimeoutSec: config.proxyTimeoutSec,
    articleLoadTimeoutSec: config.articleLoadTimeoutSec,
    scrollEnabled: config.scrollEnabled,
    scrollSpeed: config.scrollSpeed,
    scrollDepthPercent: config.scrollDepthPercent,
    loop: config.loop,
    bypass: config.bypass
  };
  doneMap = null;
  const done = await ensureDoneMap();
  if (!pendingPairExists(snapshot.proxies, snapshot.articles, done)) {
    throw new Error("Mọi proxy đã chạy hết các bài đã lưu. Vào Cài đặt và bấm Xoá lịch sử đã chạy nếu muốn chạy lại.");
  }
  await updateState((state) => {
    if (generation !== gen) return state;
    state.running = true;
    state.gen = gen;
    state.phase = "applying_proxy";
    state.proxyIndex = 0;
    state.articleIndex = 0;
    state.tabId = null;
    state.nav = 0;
    state.nextArticleAt = null;
    state.checkDeadline = null;
    state.loadDeadline = null;
    state.switchDeadline = null;
    state.spoofDeadline = null;
    state.expectedUrl = "";
    state.currentProxy = "";
    state.location = null;
    state.failedCount = 0;
    state.logs = [];
    state.proxyAuth = null;
    state.snapshot = snapshot;
    state.stopReason = "";
    state.debuggerAttached = false;
    return state;
  });
  if (!still(gen)) return { ok: false, error: "Đã bị ngắt" };
  await addLog("info", "Bắt đầu: " + snapshot.proxies.length + " proxy, " + snapshot.articles.length + " bài.");
  await chrome.alarms.create(ALARM_WATCH, { periodInMinutes: 0.5 });
  await openProxy(0, gen);
  return { ok: true };
}

async function openProxy(index, gen) {
  if (!still(gen)) return;
  if (openingProxy) return;
  openingProxy = true;
  try {
    const state = await getState();
    if (!state.running || state.gen !== gen || !state.snapshot) return;
    const proxies = state.snapshot.proxies;
    if (index >= proxies.length) {
      openingProxy = false;
      await finishProxyList(gen, state.snapshot.loop);
      return;
    }
    // Quét file lớn không được tính vào hạn chuyển proxy, kẻo đang chọn đã bị nhảy proxy.
    await enterSwitching(gen, index, 90000);
    if (!still(gen)) return;

    let picked = null;
    try {
      for (let attempt = 0; attempt < 4 && still(gen); attempt += 1) {
        picked = await takeProxy(proxies, index, state.snapshot.articles);
        if (!picked.lost) break;
      }
    } catch (err) {
      report(err);
      await addLog("error", "Không đọc được file dữ liệu, thử lại sau 20 giây.");
      await scheduleProxyRetry(gen, index);
      return;
    }
    if (!picked || picked.chosen < 0) {
      if (picked && (picked.skippedBusy || picked.lost)) {
        await addLog("info", "Proxy còn bài đang bận ở profile khác. Thử lại sau 20 giây.");
        await scheduleProxyRetry(gen, index);
        return;
      }
      await stopInternal("Không còn proxy để thử. Proxy trạng thái Không bị bỏ qua, proxy khác đã chạy hết bài.");
      return;
    }
    if (picked.skippedDead) await addLog("info", "Bỏ qua " + picked.skippedDead + " proxy trạng thái Không.");
    if (picked.skippedDone) await addLog("info", "Bỏ qua " + picked.skippedDone + " proxy đã chạy hết bài.");
    if (picked.skippedBusy) await addLog("info", "Bỏ qua " + picked.skippedBusy + " proxy đang bận ở profile khác.");

    const cursor = picked.chosen;
    const proxy = proxies[cursor];
    const label = formatProxy(proxy);
    const nav = (state.nav || 0) + 1;
    currentAuth = proxy.username ? { username: proxy.username, password: proxy.password || "" } : null;
    authAttempts = 0;
    await enterSwitching(gen, cursor);
    if (!still(gen)) return;

    await addLog("info", "Proxy " + (cursor + 1) + "/" + proxies.length + ": " + label);
    await detachQuiet();
    if (!still(gen)) return;

    try {
      await withTimeout(applyProxySettings(proxy, state.snapshot.bypass), 5000, "Quá hạn đặt proxy");
    } catch (err) {
      openingProxy = false;
      await failProxy("Không đặt được proxy: " + (err.message || err), "error", gen, true);
      return;
    }
    if (!still(gen)) return;
    const fresh = await getState();
    if (!fresh.running || fresh.gen !== gen || fresh.phase !== "switching") return;

    const deadline = Date.now() + state.snapshot.proxyTimeoutSec * 1000;
    await updateState((current) => {
      if (current.gen !== gen) return current;
      current.phase = "checking";
      current.proxyIndex = cursor;
      current.articleIndex = 0;
      current.nav = nav;
      current.currentProxy = label;
      current.location = null;
      current.expectedUrl = "";
      current.nextArticleAt = null;
      current.loadDeadline = null;
      current.articleStatus = 0;
      current.articleError = "";
      current.navStartedAt = 0;
      current.checkDeadline = deadline;
      current.switchDeadline = null;
      current.proxyAuth = currentAuth;
      current.debuggerAttached = false;
      return current;
    });
    if (!still(gen)) return;
    clearSwitchTimer();
    try {
      await chrome.alarms.clear(ALARM_SWITCH);
    } catch (err) {
      report(err);
    }
    armCheckTimer(deadline, nav);
    try {
      await chrome.alarms.create(ALARM_CHECK, { when: deadline });
    } catch (err) {
      report(err);
    }

    // Chờ Chrome áp dụng proxy trước khi mở trang kiểm tra.
    await delay(300);
    if (!still(gen)) return;

    const url = CHECK_URL + "&t=" + Date.now();
    let tabId;
    try {
      tabId = await withTimeout(ensureTab(url), 8000, "Quá hạn mở tab kiểm tra");
    } catch (err) {
      openingProxy = false;
      await failProxy("Không mở được tab kiểm tra: " + (err.message || err), "error", gen);
      return;
    }
    await updateState((current) => {
      if (current.gen !== gen || current.nav !== nav) return current;
      current.tabId = tabId;
      current.expectedUrl = url;
      return current;
    });
  } finally {
    openingProxy = false;
  }
}

async function scheduleProxyRetry(gen, index) {
  await enterSwitching(gen, index, 90000);
  try {
    await chrome.alarms.create(ALARM_BUSY, { when: Date.now() + 20000 });
  } catch (err) {
    report(err);
  }
}

async function onCheckTimeout(nav) {
  if (!alive) return;
  const state = await getState();
  if (!state.running || state.phase !== "checking" || state.nav !== nav) return;
  if (state.checkDeadline && Date.now() + 200 < state.checkDeadline) return;
  await failProxy("Timeout kết nối proxy " + state.currentProxy, "timeout", state.gen);
}

async function onCheckSuccess() {
  if (!alive) return;
  const state = await getState();
  if (!state.running || state.phase !== "checking") return;
  const gen = state.gen;
  const nav = state.nav;
  let claimed = false;
  const spoofEnd = Date.now() + switchBudgetMs(state.snapshot);
  await updateState((current) => {
    if (!current.running || current.phase !== "checking" || current.nav !== nav) return current;
    current.phase = "spoofing";
    current.checkDeadline = null;
    current.spoofDeadline = spoofEnd;
    claimed = true;
    return current;
  });
  if (!claimed || !still(gen)) return;
  clearCheckTimer();
  await chrome.alarms.clear(ALARM_CHECK);
  armSpoofTimer(spoofEnd, gen);
  try {
    await chrome.alarms.create(ALARM_SPOOF, { when: spoofEnd });
  } catch (err) {
    report(err);
  }
  await runSpoofingWork(gen, nav, 0);
}

async function runSpoofingWork(gen, nav, articleIndex) {
  const state = await getState();
  if (!state.running || state.gen !== gen || state.phase !== "spoofing") return;
  if (nav != null && state.nav !== nav) return;

  if (!state.location) {
    const ip = await readEgressIp();
    if (!still(gen)) return;
    const fresh = await getState();
    if (!fresh.running || fresh.gen !== gen || fresh.phase !== "spoofing") return;
    const activeProxy = fresh.snapshot.proxies[fresh.proxyIndex];
    if (activeProxy) {
      try {
        await setProxyHealth(activeProxy, "live", { ip, note: "Kết nối OK" });
      } catch (err) {
        report(err);
      }
    }
    await addLog("success", ip ? "Kết nối thành công. IP: " + ip : "Kết nối thành công.");

    let location;
    try {
      location = pickLocation();
    } catch (err) {
      await failProxy(err.message || "Không chọn được vị trí", "error", gen);
      return;
    }
    await updateState((current) => {
      if (current.gen !== gen || current.phase !== "spoofing") return current;
      current.location = location;
      return current;
    });
    await addLog("info", "Vị trí giả lập: " + location.name + " (" + location.timezone + ")");
  }
  if (!still(gen)) return;
  await loadArticle(articleIndex != null ? articleIndex : 0, gen);
}

async function onSpoofTimeout(gen) {
  if (!alive) return;
  const state = await getState();
  if (!state.running || state.gen !== gen || state.phase !== "spoofing") return;
  if (state.spoofDeadline && Date.now() + 200 < state.spoofDeadline) return;
  await clearSpoofDeadline();
  // Proxy đã kết nối được thì hết hạn giả lập không được nhảy sang proxy khác.
  if (state.location) {
    await addLog("info", "Giả lập vị trí chậm, vẫn mở bài với proxy hiện tại.");
    await loadArticle(state.articleIndex || 0, gen);
    return;
  }
  await failProxy("Giả lập vị trí quá hạn hoặc không hoàn thành", "timeout", gen);
}

async function loadArticle(index, gen) {
  if (!still(gen)) return;
  const state = await getState();
  if (!state.running || state.gen !== gen || !state.snapshot) return;
  await clearSpoofDeadline();
  await stopHumanScroll(state.tabId);
  const articles = state.snapshot.articles;
  const proxy = state.snapshot.proxies[state.proxyIndex];
  let done = doneMap || {};
  try {
    done = await ensureDoneMap();
  } catch (err) {
    report(err);
    await addLog("error", "Không đọc được file dữ liệu, vẫn mở bài.");
  }
  let cursor = index;
  let skipped = 0;
  while (cursor < articles.length && articleAlreadyRun(done, proxy, articles[cursor])) {
    skipped += 1;
    cursor += 1;
  }
  if (cursor >= articles.length) {
    if (skipped) await addLog("info", "Proxy này đã chạy hết bài, chuyển proxy.");
    await finishProxyArticles(gen);
    return;
  }
  if (skipped) await addLog("info", "Bỏ qua " + skipped + " bài proxy này đã chạy.");

  const url = articles[cursor];
  const nav = (state.nav || 0) + 1;
  const startedAt = Date.now();
  const deadline = startedAt + state.snapshot.articleLoadTimeoutSec * 1000;
  await updateState((current) => {
    if (current.gen !== gen) return current;
    current.phase = "loading_article";
    current.articleIndex = cursor;
    current.nav = nav;
    current.expectedUrl = url;
    current.nextArticleAt = null;
    current.loadDeadline = deadline;
    current.spoofDeadline = null;
    current.articleStatus = 0;
    current.articleError = "";
    current.navStartedAt = startedAt;
    return current;
  });
  if (!still(gen)) return;
  await clearSpoofDeadline();

  let tabId;
  try {
    tabId = await withTimeout(ensureTab(null), 8000, "Quá hạn mở tab bài viết");
  } catch (err) {
    await failProxy("Không mở được tab bài viết: " + (err.message || err), "error", gen);
    return;
  }

  const location = (await getState()).location;
  if (location) {
    const budget = Math.max(switchBudgetMs(state.snapshot), 30000);
    try {
      await withTimeout(prepareLocation(tabId, location, url, true), budget, "Quá hạn giả lập vị trí");
    } catch (err) {
      await addLog("info", "Không giả lập được vị trí, vẫn mở bài: " + (err.message || err));
    }
  } else {
    await failProxy("Thiếu vị trí giả lập", "error", gen);
    return;
  }
  if (!still(gen)) return;

  try {
    await chrome.tabs.update(tabId, { url, active: true });
  } catch (err) {
    await failProxy("Không tải được bài viết: " + (err.message || err), "error", gen);
    return;
  }
  await addLog("info", "Mở bài " + (cursor + 1) + "/" + articles.length + ": " + shortenUrl(url));
  armLoadTimer(deadline, nav);
  try {
    await chrome.alarms.create(ALARM_LOAD, { when: deadline });
  } catch (err) {
    report(err);
  }
}

async function onLoadTimeout(nav, forced) {
  if (!alive) return;
  let state = await getState();
  if (!state.running || state.phase !== "loading_article" || state.nav !== nav) return;
  if (state.loadDeadline && !forced && Date.now() + 200 < state.loadDeadline) return;
  await stopTabLoading(state.tabId);

  let tabUrl = "";
  try {
    tabUrl = (await chrome.tabs.get(state.tabId)).url || "";
  } catch (err) {
    report(err);
  }
  state = await getState();
  if (!state.running || state.phase !== "loading_article" || state.nav !== nav) return;

  const err = String(state.articleError || "");
  const status = Number(state.articleStatus) || 0;
  if (status === 407 || (err && isFatalProxyError(err))) {
    await failProxy("Mất kết nối proxy khi mở bài: " + (err || "HTTP 407"), "error", state.gen);
    return;
  }

  if (await maybeSkipBadArticle(state)) return;

  if (articleFailedToLoad(state, tabUrl)) {
    await addLog("timeout", "Hết thời gian tải bài, trang chưa tải được → chuyển bài tiếp.");
    await goNextArticle(state.gen, "Hết thời gian tải bài, không tải được → chuyển bài tiếp.");
    return;
  }

  await addLog(
    "timeout",
    forced
      ? "Trang vẫn tải chậm qua proxy, dừng spinner và bắt đầu đếm chờ bài tiếp."
      : "Bài viết tải quá thời gian, chuyển sang chờ bài tiếp."
  );
  await finishArticleLoad();
}

async function goNextArticle(gen, reason) {
  if (!still(gen)) return false;
  const state = await getState();
  if (!state.running || state.gen !== gen || !state.snapshot) return false;
  if (state.phase !== "waiting" && state.phase !== "loading_article") return false;
  const nav = state.nav;
  const index = state.articleIndex;
  let claimed = false;
  await updateState((current) => {
    if (!current.running || current.gen !== gen) return current;
    if (current.nav !== nav || current.articleIndex !== index) return current;
    if (current.phase !== "waiting" && current.phase !== "loading_article") return current;
    current.phase = "loading_article";
    current.nextArticleAt = null;
    current.loadDeadline = null;
    current.spoofDeadline = null;
    claimed = true;
    return current;
  });
  if (!claimed || !still(gen)) return false;
  clearLoadTimer();
  await chrome.alarms.clear(ALARM_LOAD);
  await chrome.alarms.clear(ALARM_NEXT);
  await clearSpoofDeadline();
  await stopHumanScroll(state.tabId);
  const outcome = articleOutcome(state, reason);
  if (!(state.phase === "waiting" && outcome.ok)) await rememberCurrentArticle(state, outcome);
  if (reason) await addLog("info", reason);
  const next = index + 1;
  if (next >= state.snapshot.articles.length) {
    await addLog("success", "Đã xem hết bài với proxy " + state.currentProxy + ".");
    await finishProxyArticles(gen);
    return true;
  }
  await loadArticle(next, gen);
  return true;
}

async function maybeSkipBadArticle(state) {
  if (!state) return false;
  if (state.phase !== "waiting" && state.phase !== "loading_article") return false;
  const reason = articleSkipReason(state.articleStatus, state.articleError);
  if (!reason) return false;
  return goNextArticle(state.gen, reason + " → bỏ qua chờ, chuyển bài tiếp.");
}

function scheduleArticleProbe(nav) {
  if (nav == null || probeScheduled.has(nav)) return;
  probeScheduled.add(nav);
  setTimeout(() => {
    probeArticle(nav).catch(report);
  }, 800);
}

function captureStatus(url) {
  return new Promise((resolve) => {
    let settled = false;
    let origin = "";
    try {
      origin = new URL(url).origin;
    } catch (err) {
      resolve(null);
      return;
    }
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      chrome.webRequest.onCompleted.removeListener(onCompleted);
      chrome.webRequest.onErrorOccurred.removeListener(onError);
      resolve(result);
    };
    const matches = (details) => {
      if (details.tabId !== -1) return false;
      try {
        return new URL(details.url).origin === origin;
      } catch (err) {
        return false;
      }
    };
    const onCompleted = (details) => {
      if (!matches(details)) return;
      const code = Number(details.statusCode) || 0;
      if (code >= 300 && code < 400) return;
      finish({ status: code, error: "" });
    };
    const onError = (details) => {
      if (!matches(details)) return;
      finish({ status: Number(details.statusCode) || 0, error: String(details.error || "") });
    };
    let timer = null;
    chrome.webRequest.onCompleted.addListener(onCompleted, { urls: ["<all_urls>"] });
    chrome.webRequest.onErrorOccurred.addListener(onError, { urls: ["<all_urls>"] });
    timer = setTimeout(() => finish(null), 12000);
    fetch(url, { cache: "no-store", redirect: "follow", signal: AbortSignal.timeout(10000) }).catch(() => {});
  });
}

async function probeArticle(nav) {
  const state = await getState();
  if (!alive || !state.running || state.nav !== nav) return;
  if (state.phase !== "waiting" && state.phase !== "loading_article") return;
  if (articleSkipReason(state.articleStatus, state.articleError)) {
    await runFlow(async () => {
      const fresh = await getState();
      if (fresh.nav === nav) await maybeSkipBadArticle(fresh);
    });
    return;
  }
  if (state.articleStatus || state.articleError || !isHttpUrl(state.expectedUrl)) return;
  const result = await captureStatus(state.expectedUrl);
  if (!result) return;
  await runFlow(async () => {
    const fresh = await getState();
    if (!fresh.running || fresh.nav !== nav) return;
    if (fresh.phase !== "waiting" && fresh.phase !== "loading_article") return;
    if (!fresh.articleStatus && !fresh.articleError) {
      await updateState((current) => {
        if (current.nav !== nav) return current;
        if (result.status) current.articleStatus = result.status;
        if (result.error) current.articleError = result.error;
        return current;
      });
    }
    await maybeSkipBadArticle(await getState());
  });
}

async function finishArticleLoad() {
  if (!alive) return;
  const state = await getState();
  if (!state.running || state.phase !== "loading_article" || !state.snapshot) return;
  if (await maybeSkipBadArticle(state)) return;
  const status = Number(state.articleStatus) || 0;
  const err = String(state.articleError || "");
  if (status === 407 || isFatalProxyError(err)) {
    await failProxy("Mất kết nối proxy khi mở bài: " + (err || "HTTP 407"), "error", state.gen);
    return;
  }
  if ((err && err !== "net::ERR_ABORTED") || status >= 400) {
    const why = err && err !== "chrome-error" ? err : (status >= 400 ? "HTTP " + status : "trang không tải được");
    await goNextArticle(state.gen, "Bài không tải được: " + why + " → chuyển bài tiếp.");
    return;
  }
  const gen = state.gen;
  const index = state.articleIndex;
  let claimed = false;
  await updateState((current) => {
    if (!current.running || current.phase !== "loading_article" || current.gen !== gen) return current;
    current.loadDeadline = null;
    claimed = true;
    return current;
  });
  if (!claimed || !still(gen)) return;
  clearLoadTimer();
  await chrome.alarms.clear(ALARM_LOAD);
  await rememberCurrentArticle(state, { ok: true });

  const total = state.snapshot.articles.length;
  const next = index + 1;
  const waitSec = pickWait(state.snapshot.waitMinSec, state.snapshot.waitMaxSec);
  const when = Date.now() + waitSec * 1000;
  await updateState((current) => {
    if (!current.running || current.gen !== gen) return current;
    current.phase = "waiting";
    current.nextArticleAt = when;
    return current;
  });
  if (!still(gen)) return;
  try {
    await chrome.alarms.create(ALARM_NEXT, { when });
  } catch (err) {
    report(err);
  }
  const fresh = await getState();
  await beginHumanScroll(fresh.tabId, fresh.snapshot);
  if (next >= total) {
    await addLog("info", "Cuộn trang + chờ " + waitSec + " giây trước khi đổi proxy.");
  } else {
    await addLog("info", "Cuộn trang + chờ " + waitSec + " giây trước bài " + (next + 1) + "/" + total + ".");
  }
  scheduleArticleProbe(state.nav);
}

async function onWaitElapsed() {
  if (!alive) return;
  const state = await getState();
  if (!state.running || state.phase !== "waiting" || !state.snapshot) return;
  if (await maybeSkipBadArticle(state)) return;
  if (state.nextArticleAt && Date.now() + 500 < state.nextArticleAt) return;
  await goNextArticle(state.gen, "");
}

async function enterSwitching(gen, proxyIndex, budgetMs) {
  const state = await getState();
  const deadline = Date.now() + (budgetMs || switchBudgetMs(state.snapshot));
  await updateState((current) => {
    if (current.gen !== gen) return current;
    current.phase = "switching";
    if (proxyIndex != null) current.proxyIndex = proxyIndex;
    current.switchDeadline = deadline;
    current.spoofDeadline = null;
    current.checkDeadline = null;
    current.loadDeadline = null;
    current.nextArticleAt = null;
    current.debuggerAttached = false;
    return current;
  });
  clearSpoofTimer();
  try {
    await chrome.alarms.clear(ALARM_SPOOF);
  } catch (err) {
    report(err);
  }
  armSwitchTimer(deadline, gen);
  try {
    await chrome.alarms.create(ALARM_SWITCH, { when: deadline });
  } catch (err) {
    report(err);
  }
}

async function onSwitchTimeout(gen) {
  if (!alive || openingProxy) return;
  const state = await getState();
  if (!state.running || state.gen !== gen || state.phase !== "switching") return;
  if (state.switchDeadline && Date.now() + 200 < state.switchDeadline) return;
  clearSwitchTimer();
  await addLog("timeout", "Chuyển proxy quá hạn, tiếp tục proxy kế.");
  await openProxy(state.proxyIndex, gen);
}

async function finishProxyArticles(gen) {
  if (!still(gen)) return;
  await releaseHeld();
  const state = await getState();
  if (!state.snapshot) return;
  const next = state.proxyIndex + 1;
  const loop = state.snapshot.loop;
  const total = state.snapshot.proxies.length;
  if (next >= total) {
    await finishProxyList(gen, loop);
    return;
  }
  await enterSwitching(gen, next);
  if (!still(gen)) return;
  try {
    await detachQuiet();
  } catch (err) {
    report(err);
  }
  if (!still(gen)) return;
  const fresh = await getState();
  if (!fresh.running || fresh.gen !== gen || fresh.phase !== "switching") return;
  await openProxy(next, gen);
}

async function finishProxyList(gen, loop) {
  if (!still(gen)) return;
  if (loop) {
    const state = await getState();
    const map = await ensureDoneMap();
    if (state.snapshot && !pendingPairExists(state.snapshot.proxies, state.snapshot.articles, map)) {
      await stopInternal("Mọi proxy đã chạy hết bài đã lưu.");
      return;
    }
    await addLog("info", "Hết danh sách proxy, lặp lại từ đầu.");
    await openProxy(0, gen);
    return;
  }
  await stopInternal("Đã hết danh sách proxy.");
}

async function failProxy(message, level, gen, force) {
  if (!still(gen)) return;
  const state = await getState();
  if (!state.running || !state.snapshot || state.gen !== gen) return;
  if (state.phase === "idle" || (!force && state.phase === "switching")) return;

  const index = state.proxyIndex;
  const total = state.snapshot.proxies.length;
  const loop = state.snapshot.loop;
  const next = index + 1;
  const deadline = Date.now() + switchBudgetMs(state.snapshot);
  let claimed = false;
  await updateState((current) => {
    if (!current.running || current.gen !== gen || current.phase === "idle") return current;
    if (!force && current.phase === "switching") return current;
    current.phase = "switching";
    current.failedCount += 1;
    current.proxyIndex = next >= total ? index : next;
    current.checkDeadline = null;
    current.loadDeadline = null;
    current.nextArticleAt = null;
    current.spoofDeadline = null;
    current.switchDeadline = deadline;
    claimed = true;
    return current;
  });
  if (!claimed || !still(gen)) return;

  clearCheckTimer();
  clearLoadTimer();
  await clearSpoofDeadline();
  armSwitchTimer(deadline, gen);
  try {
    await chrome.alarms.clear(ALARM_CHECK);
    await chrome.alarms.clear(ALARM_LOAD);
    await chrome.alarms.clear(ALARM_NEXT);
    await chrome.alarms.create(ALARM_SWITCH, { when: deadline });
  } catch (err) {
    report(err);
  }
  const failedProxy = state.snapshot.proxies[index];
  try {
    await addLog(level || "error", message);
    if (failedProxy) await setProxyHealth(failedProxy, "dead", { note: message });
  } catch (err) {
    report(err);
  }
  if (failedProxy) await releaseKey(proxyStorageKey(failedProxy));
  try {
    await detachQuiet();
  } catch (err) {
    report(err);
  }
  if (!still(gen)) return;
  const fresh = await getState();
  if (!fresh.running || fresh.gen !== gen || fresh.phase !== "switching") return;

  if (next >= total) {
    clearSwitchTimer();
    try { await chrome.alarms.clear(ALARM_SWITCH); } catch (err) { report(err); }
    await finishProxyList(gen, loop);
    return;
  }
  await openProxy(next, gen);
}

async function stopInternal(reason) {
  const state = await getState();
  const wasRunning = Boolean(state.running || alive);
  alive = false;
  openingProxy = false;
  if (wasRunning) {
    try {
      if (!heldKey && state.snapshot && state.snapshot.proxies) {
        const proxy = state.snapshot.proxies[state.proxyIndex];
        if (proxy) heldKey = proxyStorageKey(proxy);
      }
      await releaseHeld();
    } catch (err) {
      report(err);
    }
  }
  generation += 1;
  currentAuth = null;
  authAttempts = 0;
  clearCheckTimer();
  clearLoadTimer();
  clearSwitchTimer();
  clearSpoofTimer();
  await stopHumanScroll(state.tabId);
  intentionalDetach = true;
  if (state.tabId != null) {
    try {
      await chrome.debugger.detach({ tabId: state.tabId });
    } catch (err) {
      // Không còn debugger để gỡ.
    }
  }
  intentionalDetach = false;
  await clearAlarms();
  await clearProxySettings();
  await updateState((current) => {
    current.running = false;
    current.phase = "idle";
    current.gen = generation;
    current.stopReason = reason;
    current.nextArticleAt = null;
    current.checkDeadline = null;
    current.loadDeadline = null;
    current.switchDeadline = null;
    current.spoofDeadline = null;
    current.proxyAuth = null;
    current.debuggerAttached = false;
    return current;
  });
  if (wasRunning) await addLog("info", reason);
}

async function reattachIfNeeded(sourceTabId) {
  if (intentionalDetach || !alive) return;
  installedScriptKey = "";
  const state = await getState();
  if (!state.running || !state.debuggerAttached || state.tabId == null) return;
  if (sourceTabId != null && sourceTabId !== state.tabId) return;
  if (!state.location) return;
  if (reattachFails >= 3) return;
  try {
    await prepareLocation(state.tabId, state.location, state.expectedUrl || state.snapshot?.articles?.[state.articleIndex], false);
    await addLog("info", "Debugger bị ngắt, đã gắn lại.");
  } catch (err) {
    reattachFails += 1;
    await addLog("error", "Không gắn lại được debugger: " + (err.message || err));
  }
}

async function onTabRemoved(tabId) {
  if (!alive) return;
  const state = await getState();
  if (!state.running || state.tabId !== tabId) return;
  await updateState((current) => {
    current.tabId = null;
    current.debuggerAttached = false;
    return current;
  });
  await addLog("info", "Tab làm việc bị đóng, đang mở lại.");
  if (!alive) return;
  if (state.phase === "checking" && state.expectedUrl) {
    try {
      const id = await ensureTab(state.expectedUrl);
      await updateState((current) => {
        current.tabId = id;
        return current;
      });
    } catch (err) {
      await failProxy("Không mở lại được tab kiểm tra", "error", state.gen);
    }
    return;
  }
  if (state.phase === "loading_article") {
    await loadArticle(state.articleIndex, state.gen);
    return;
  }
  if ((state.phase === "waiting" || state.phase === "spoofing") && state.snapshot) {
    const url = state.snapshot.articles[state.articleIndex];
    if (!url) return;
    try {
      const id = await ensureTab(null);
      if (state.location) await prepareLocation(id, state.location, url, true);
      await chrome.tabs.update(id, { url, active: true });
    } catch (err) {
      await addLog("error", "Không mở lại được bài viết.");
    }
  }
}

async function handleMainFrame(details, ok) {
  if (!alive || details.type !== "main_frame") return;
  const state = await getState();
  if (!state.running || details.tabId !== state.tabId) return;

  if (state.phase === "checking") {
    if (!ok) {
      if (details.error === "net::ERR_ABORTED") return;
      const level = /TIMED_OUT|ERR_TIMED/.test(String(details.error || "")) ? "timeout" : "error";
      await failProxy("Proxy lỗi khi kiểm tra: " + (details.error || "không tải được trang"), level, state.gen);
      return;
    }
    let host = "";
    try {
      host = new URL(details.url || "").hostname;
    } catch (err) {
      host = "";
    }
    if (host !== CHECK_HOST) return;
    if (details.statusCode && (details.statusCode < 200 || details.statusCode >= 400)) {
      await failProxy("Trang kiểm tra IP trả HTTP " + details.statusCode, "error", state.gen);
      return;
    }
    await onCheckSuccess();
    return;
  }

  if (state.phase === "loading_article" || state.phase === "waiting") {
    if (isStaleNavigation(details, state)) return;
    if (isOtherListedArticle(details.url, state.expectedUrl, state.snapshot && state.snapshot.articles)) return;
    const errorText = String(details.error || "");
    const isCertError = /ERR_CERT_AUTHORITY_INVALID/i.test(errorText);
    const isGenericChromeError = errorText === "chrome-error";
    if (state.phase === "loading_article" && !isArticlePageUrl(details.url) && !isCertError && !isGenericChromeError) return;
    if (state.phase === "waiting" && details.url && !isArticlePageUrl(details.url) && !isCertError && !isGenericChromeError) return;

    if (errorText === "net::ERR_ABORTED") return;
    const statusCode = Number(details.statusCode) || 0;
    const netError = errorText && !isGenericChromeError ? errorText : "";
    if (statusCode || netError) {
      await updateState((current) => {
        if (!current.running || current.nav !== state.nav) return current;
        if (current.phase !== "loading_article" && current.phase !== "waiting") return current;
        if (statusCode) current.articleStatus = statusCode;
        if (netError) current.articleError = netError;
        return current;
      });
    }

    const fresh = await getState();
    if (fresh.nav !== state.nav) return;
    if (await maybeSkipBadArticle(fresh)) return;
    if (fresh.phase === "waiting" && (!ok || isGenericChromeError)) {
      const waitingError = fresh.articleError || (isGenericChromeError ? "" : errorText);
      if (statusCode === 407 || isFatalProxyError(waitingError)) {
        await failProxy("Mất kết nối proxy khi mở bài: " + (waitingError || "HTTP 407"), "error", state.gen);
        return;
      }
      if (waitingError && waitingError !== "net::ERR_ABORTED" && waitingError !== "chrome-error") {
        await goNextArticle(fresh.gen, "Bài không tải được: " + waitingError + " → chuyển bài tiếp.");
      }
      return;
    }
    if (fresh.phase !== "loading_article") return;

    if (!ok || isGenericChromeError) {
      const storedError = fresh.articleError || (isGenericChromeError ? "" : errorText);
      if (statusCode === 407 || isFatalProxyError(storedError)) {
        await failProxy("Mất kết nối proxy khi mở bài: " + (storedError || "HTTP 407"), "error", state.gen);
        return;
      }
      const why = storedError && storedError !== "chrome-error"
        ? storedError
        : (statusCode >= 400 ? "HTTP " + statusCode : "trang không tải được");
      await goNextArticle(fresh.gen, "Bài không tải được: " + why + " → chuyển bài tiếp.");
      return;
    }
    if (statusCode === 403) {
      await goNextArticle(fresh.gen, "HTTP 403 → chuyển bài tiếp.");
      return;
    }
    await addLog("success", "Trang bài đã tải xong (có thể đã redirect).");
    await finishArticleLoad();
  }
}

async function onWatch() {
  const state = await getState();
  if (state.running) touchHeld().catch(report);
  if (!state.running) {
    alive = false;
    await chrome.alarms.clear(ALARM_WATCH);
    if (!state.proxyAuth) await clearProxySettings();
    return;
  }
  alive = true;
  generation = state.gen || generation;
  currentAuth = state.proxyAuth || null;
  const now = Date.now();
  if (state.phase === "switching") {
    if (openingProxy) return;
    if (!state.switchDeadline || now >= state.switchDeadline) await onSwitchTimeout(state.gen);
    else armSwitchTimer(state.switchDeadline, state.gen);
    return;
  }
  if (state.phase === "spoofing") {
    if (!state.spoofDeadline || now >= state.spoofDeadline) await onSpoofTimeout(state.gen);
    else armSpoofTimer(state.spoofDeadline, state.gen);
    return;
  }
  if (state.phase === "checking" && state.checkDeadline && now >= state.checkDeadline) {
    await onCheckTimeout(state.nav);
    return;
  }
  if (state.phase === "loading_article" && state.loadDeadline && now >= state.loadDeadline) {
    await onLoadTimeout(state.nav, true);
    return;
  }
  if (state.phase === "waiting") {
    if (await maybeSkipBadArticle(state)) return;
    if (state.nextArticleAt && now + 1500 < state.nextArticleAt) scheduleArticleProbe(state.nav);
    if (state.nextArticleAt && now >= state.nextArticleAt) await onWaitElapsed();
  }
}

async function resume() {
  const state = await getState();
  generation = state.gen || 0;
  currentAuth = state.proxyAuth || null;
  if (!state.running) {
    alive = false;
    // Proxy của extension có thể còn sót sau khi trình duyệt hoặc service worker khởi động lại.
    await clearProxySettings();
    return;
  }
  alive = true;
  try {
    await chrome.alarms.create(ALARM_WATCH, { periodInMinutes: 0.5 });
  } catch (err) {
    report(err);
  }
  await reclaimIfRunning();
  if (state.phase === "checking") {
    if (state.checkDeadline && Date.now() >= state.checkDeadline) await onCheckTimeout(state.nav);
    else if (state.checkDeadline) armCheckTimer(state.checkDeadline, state.nav);
    return;
  }
  if (state.phase === "loading_article") {
    if (state.loadDeadline && Date.now() >= state.loadDeadline) await onLoadTimeout(state.nav, true);
    else if (state.loadDeadline) armLoadTimer(state.loadDeadline, state.nav);
    if (state.location && state.tabId != null) {
      try {
        await prepareLocation(state.tabId, state.location, state.expectedUrl, true);
      } catch (err) {
        report(err);
      }
    }
    return;
  }
  if (state.phase === "waiting") {
    if (await maybeSkipBadArticle(state)) return;
    if (state.nextArticleAt && Date.now() + 1500 < state.nextArticleAt) scheduleArticleProbe(state.nav);
    if (!state.nextArticleAt || Date.now() >= state.nextArticleAt) await onWaitElapsed();
    else {
      await chrome.alarms.create(ALARM_NEXT, { when: state.nextArticleAt });
      await beginHumanScroll(state.tabId, state.snapshot);
    }
    return;
  }
  if (state.phase === "spoofing") {
    if (!state.spoofDeadline) await armSpoofDeadline(state.gen);
    else if (Date.now() >= state.spoofDeadline) {
      await onSpoofTimeout(state.gen);
      return;
    } else armSpoofTimer(state.spoofDeadline, state.gen);
    if (state.location) await loadArticle(state.articleIndex || 0, state.gen);
    else await runSpoofingWork(state.gen, state.nav, state.articleIndex || 0);
    return;
  }
  if (state.phase === "switching") {
    if (!state.switchDeadline || Date.now() >= state.switchDeadline) await onSwitchTimeout(state.gen);
    else armSwitchTimer(state.switchDeadline, state.gen);
    return;
  }
  if (state.phase === "applying_proxy") {
    await openProxy(state.proxyIndex, state.gen);
  }
}

async function reclaimIfRunning() {
  const state = await getState();
  if (!state.running || !state.snapshot) return;
  if (!["checking", "spoofing", "loading_article", "waiting"].includes(state.phase)) return;
  const proxy = state.snapshot.proxies[state.proxyIndex];
  if (!proxy) return;
  const owner = await profileId();
  const key = proxyStorageKey(proxy);
  try {
    const saved = await self.sharedStore.update(function (data) {
      if (!data.proxyLease || typeof data.proxyLease !== "object" || Array.isArray(data.proxyLease)) data.proxyLease = {};
      const lease = data.proxyLease[key];
      if (lease && lease.owner !== owner && self.sharedStore.leaseFresh(lease)) return data;
      data.proxyLease[key] = { owner: owner, claimedAt: Date.now() };
      return data;
    });
    const lease = saved.proxyLease && saved.proxyLease[key];
    if (lease && lease.owner === owner) {
      heldKey = key;
      heldTouchAt = Date.now();
    }
  } catch (err) {
    report(err);
  }
}

function publicStatus(state) {
  const totalProxy = state.snapshot?.proxies?.length || 0;
  const totalArticle = state.snapshot?.articles?.length || 0;
  const showArticle = state.running && ["spoofing", "loading_article", "waiting"].includes(state.phase);
  const articleUrl = showArticle ? (state.snapshot?.articles?.[state.articleIndex] || "") : "";
  const secondsLeft = state.running && state.phase === "waiting" && state.nextArticleAt
    ? Math.max(0, Math.ceil((state.nextArticleAt - Date.now()) / 1000))
    : null;
  const loadSecondsLeft = state.running && state.phase === "loading_article" && state.loadDeadline
    ? Math.max(0, Math.ceil((state.loadDeadline - Date.now()) / 1000))
    : null;
  const switchSecondsLeft = state.running && state.phase === "switching" && state.switchDeadline
    ? Math.max(0, Math.ceil((state.switchDeadline - Date.now()) / 1000))
    : null;
  const checkSecondsLeft = state.running && state.phase === "checking" && state.checkDeadline
    ? Math.max(0, Math.ceil((state.checkDeadline - Date.now()) / 1000))
    : null;
  const spoofSecondsLeft = state.running && state.phase === "spoofing" && state.spoofDeadline
    ? Math.max(0, Math.ceil((state.spoofDeadline - Date.now()) / 1000))
    : null;
  let phaseLabel = PHASE_LABEL[state.phase] || "Sẵn sàng";
  if (!state.running) phaseLabel = state.stopReason || "Sẵn sàng";
  return {
    ok: true,
    running: Boolean(state.running),
    phase: state.phase,
    phaseLabel,
    proxyLabel: state.currentProxy || "—",
    proxyIndex: totalProxy ? state.proxyIndex + 1 : 0,
    proxyTotal: totalProxy,
    locationLabel: state.location?.name || "—",
    articleLabel: articleUrl ? shortenUrl(articleUrl) : "—",
    articleUrl,
    articleIndex: showArticle ? state.articleIndex + 1 : 0,
    articleTotal: totalArticle,
    secondsLeft,
    loadSecondsLeft,
    loadDeadline: state.phase === "loading_article" ? state.loadDeadline : null,
    switchDeadline: state.phase === "switching" ? state.switchDeadline : null,
    checkDeadline: state.phase === "checking" ? state.checkDeadline : null,
    spoofDeadline: state.phase === "spoofing" ? state.spoofDeadline : null,
    switchSecondsLeft,
    checkSecondsLeft,
    spoofSecondsLeft,
    nextArticleAt: state.phase === "waiting" ? state.nextArticleAt : null,
    failedCount: state.failedCount || 0,
    logs: state.logs || []
  };
}

chrome.webRequest.onAuthRequired.addListener((details, callback) => {
  // Chỉ điền user/pass cho proxy. Đăng nhập của trang web vẫn do Chrome xử lý.
  const ready = mem ? Promise.resolve() : getState().then((state) => {
    currentAuth = state.proxyAuth || currentAuth;
  });
  ready.then(() => {
    if (details.isProxy && currentAuth && currentAuth.username && alive) {
      const ours = !mem || mem.tabId == null || details.tabId === mem.tabId || details.tabId === -1;
      if (ours) authAttempts += 1;
      if (ours && authAttempts > 4) {
        callback({ cancel: false });
        runFlow(() => failProxy("Proxy từ chối thông tin đăng nhập", "error", generation)).catch(report);
        return;
      }
      callback({
        authCredentials: {
          username: currentAuth.username,
          password: currentAuth.password || ""
        }
      });
      return;
    }
    callback({ cancel: false });
  }).catch(() => callback({ cancel: false }));
}, { urls: ["<all_urls>"] }, ["asyncBlocking"]);

chrome.webRequest.onErrorOccurred.addListener((details) => {
  if (!isOurMainFrame(details)) return;
  runFlow(() => handleMainFrame(details, false)).catch(report);
}, { urls: ["<all_urls>"] });

chrome.webRequest.onCompleted.addListener((details) => {
  if (!isOurMainFrame(details)) return;
  runFlow(() => handleMainFrame(details, true)).catch(report);
}, { urls: ["<all_urls>"] });

chrome.proxy.onProxyError.addListener((details) => {
  runFlow(async () => {
    if (!alive) return;
    const state = await getState();
    if (!state.running) return;
    // Mọi tab trong profile đều đi qua proxy. Chỉ lỗi proxy thật lúc đang kiểm tra mới được tính.
    if (state.phase !== "checking") return;
    const message = details.error || details.details || "proxy error";
    if (!details.fatal && !isFatalProxyError(message)) return;
    await failProxy("Proxy báo lỗi: " + message, "error", state.gen);
  }).catch(report);
});

chrome.tabs.onRemoved.addListener((tabId) => {
  runFlow(() => onTabRemoved(tabId)).catch(report);
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.status !== "complete" || !alive) return;
  if (mem && mem.tabId != null && tabId !== mem.tabId) return;
  const seenAt = Date.now();
  runFlow(async () => {
    let state = await getState();
    if (!alive || !state.running || tabId !== state.tabId) return;
    const url = tab.url || "";
    if (url.startsWith("chrome-error://")) {
      await handleMainFrame({ tabId, type: "main_frame", url, error: "chrome-error", timeStamp: seenAt }, false);
      return;
    }
    if (state.phase === "checking") {
      await handleMainFrame({ tabId, type: "main_frame", url, statusCode: 200 }, true);
      return;
    }
    // Một số trang qua proxy chậm không bao giờ "complete" hết tài nguyên; vẫn coi tab complete là đủ.
    // Không nhận complete của bài vừa rời, kẻo bài mới bị tính là tải xong.
    if (state.phase === "loading_article" && isArticlePageUrl(url)) {
      if (isOtherListedArticle(url, state.expectedUrl, state.snapshot && state.snapshot.articles)) return;
      const reason = articleSkipReason(state.articleStatus, state.articleError);
      if (reason) {
        if (await maybeSkipBadArticle(state)) return;
        await goNextArticle(state.gen, reason + " → chuyển bài tiếp.");
        return;
      }
      await addLog("success", "Tab báo tải xong: " + shortenUrl(url));
      await finishArticleLoad();
    }
  }).catch(report);
});

chrome.debugger.onDetach.addListener((source) => {
  runFlow(() => reattachIfNeeded(source.tabId)).catch(report);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  runFlow(async () => {
    if (alarm.name === ALARM_NEXT) await onWaitElapsed();
    else if (alarm.name === ALARM_CHECK) {
      const state = await getState();
      await onCheckTimeout(state.nav);
    }     else if (alarm.name === ALARM_LOAD) {
      const state = await getState();
      await onLoadTimeout(state.nav, true);
    } else if (alarm.name === ALARM_BUSY) {
      const state = await getState();
      if (!state.running || state.phase !== "switching") return;
      await openProxy(state.proxyIndex || 0, state.gen);
    } else if (alarm.name === ALARM_SWITCH) {
      const state = await getState();
      await onSwitchTimeout(state.gen);
    } else if (alarm.name === ALARM_SPOOF) {
      const state = await getState();
      await onSpoofTimeout(state.gen);
    } else if (alarm.name === ALARM_WATCH) await onWatch();
  }).catch(report);
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || typeof message.type !== "string") return false;
  if (!["START", "STOP", "STATUS", "NEXT"].includes(message.type)) return false;
  (async () => {
    if (message.type === "STATUS") return publicStatus(await getState());
    if (message.type === "NEXT") {
      return runFlow(async () => {
        const state = await getState();
        if (!state.running) throw new Error("Rotator chưa chạy.");
        if (state.phase !== "waiting" && state.phase !== "loading_article") {
          throw new Error("Chỉ next được khi đang mở hoặc đang chờ bài.");
        }
        const moved = await goNextArticle(state.gen, "Next tự động: chuyển bài tiếp.");
        if (!moved) throw new Error("Không chuyển được bài lúc này.");
        return publicStatus(await getState());
      });
    }
    if (message.type === "STOP") {
      alive = false;
      generation += 1;
      await runFlow(() => stopInternal("Đã dừng theo yêu cầu."));
      return publicStatus(await getState());
    }
    if (alive || (await getState()).running) throw new Error("Rotator đang chạy. Bấm Dừng trước khi bắt đầu lại.");
    generation += 1;
    const gen = generation;
    alive = true;
    try {
      await runFlow(() => beginRun(gen));
    } catch (err) {
      if (generation === gen) alive = false;
      throw err;
    }
    return publicStatus(await getState());
  })().then(sendResponse).catch((err) => sendResponse({ ok: false, error: err.message || String(err) }));
  return true;
});

runFlow(() => resume()).catch(report);
