const $ = (id) => document.getElementById(id);

const API_SOURCE = "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=US&ssl=all&anonymity=all";
const JSDELIVR_SOURCE = "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/countries/us/data.json";
const LEGACY_SOURCE = API_SOURCE + "\n" + JSDELIVR_SOURCE;
const DEFAULT_SOURCE = self.DEFAULT_PROXY_SOURCES || LEGACY_SOURCE;

function normalizeSources(text) {
  const trimmed = String(text || "").trim();
  if (!trimmed || trimmed === API_SOURCE || trimmed === LEGACY_SOURCE) return DEFAULT_SOURCE;
  return trimmed;
}

async function fillProxySources() {
  const text = await self.readProxySources();
  if (!formDirty && !formFocused()) $("sourceUrl").value = text;
  return text;
}

function parseSourceLine(raw) {
  const text = String(raw || "").trim();
  let urlText = text;
  let forceProtocol = "";
  const splitAt = text.lastIndexOf("|");
  if (splitAt > 0) {
    const tag = text.slice(splitAt + 1).trim().toLowerCase();
    if (tag === "socks4" || tag === "socks5") {
      urlText = text.slice(0, splitAt).trim();
      forceProtocol = tag;
    }
  }
  let url;
  try {
    url = new URL(urlText);
  } catch (err) {
    throw new Error("URL nguồn không hợp lệ: " + text);
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("URL nguồn phải là http hoặc https: " + text);
  }
  return { url: url.href, forceProtocol };
}

function formatSourceLine(source) {
  return source.forceProtocol ? source.url + "|" + source.forceProtocol : source.url;
}

function sourceEntries(text) {
  const entries = [];
  const seen = new Set();
  for (const line of normalizeSources(text).split(/\r?\n/)) {
    const raw = line.trim();
    if (!raw) continue;
    const entry = parseSourceLine(raw);
    const key = entry.url + "|" + entry.forceProtocol;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  if (!entries.length) throw new Error("Chưa có URL nguồn proxy.");
  return entries;
}

function mergeProxyBatches(batches) {
  const merged = [];
  const seen = new Set();
  for (const batch of batches) {
    const items = batch.some((proxy) => Number.isFinite(proxy.uptime))
      ? [...batch].sort((a, b) => (b.uptime || 0) - (a.uptime || 0))
      : batch;
    for (const proxy of items) {
      const key = self.proxyKey(proxy);
      if (seen.has(key)) continue;
      seen.add(key);
      merged.push(proxy);
    }
  }
  return merged;
}

function sourceLabel(url) {
  if (url.includes("cdn.jsdelivr.net")) return "jsDelivr";
  if (url.includes("api.proxyscrape.com")) return "ProxyScrape API";
  try {
    return new URL(url).hostname;
  } catch (err) {
    return url;
  }
}

let formDirty = false;

function summarizeDone(map) {
  const stat = { total: 0, ok: 0, bad: 0, unknown: 0, notes: {} };
  if (!map || typeof map !== "object") return stat;
  for (const list of Object.values(map)) {
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      stat.total += 1;
      if (entry && typeof entry === "object" && entry.ok === true) stat.ok += 1;
      else if (entry && typeof entry === "object" && entry.ok === false) {
        stat.bad += 1;
        const note = String(entry.note || "Không tải được").slice(0, 80);
        stat.notes[note] = (stat.notes[note] || 0) + 1;
      } else stat.unknown += 1;
    }
  }
  return stat;
}

function countDonePairs(map) {
  return summarizeDone(map).total;
}

function renderDoneCount(map) {
  const stat = summarizeDone(map);
  if (!stat.total) {
    $("doneHint").textContent = "Chưa có cặp proxy–bài đã chạy.";
    return;
  }
  const lines = [
    "Đã lưu " + stat.total + " cặp. Lần chạy sau sẽ bỏ qua.",
    "Chạy được " + stat.ok + " · Không được " + stat.bad
  ];
  if (stat.unknown) lines.push("Chưa rõ " + stat.unknown + " (lưu từ trước, chưa ghi kết quả).");
  const reasons = Object.keys(stat.notes)
    .map((note) => ({ note: note, count: stat.notes[note] }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 3);
  if (reasons.length) {
    lines.push("Lỗi hay gặp: " + reasons.map((item) => item.note + " (" + item.count + ")").join(", ") + ".");
  }
  $("doneHint").textContent = lines.join("\n");
}

function renderPlace(place) {
  $("locationHint").textContent = place && place.label ? place.label : "Chưa chọn nơi lưu.";
  $("grantAccess").disabled = !place || !place.kind;
}

function applyConfig(config, options) {
  const data = config || {};
  if (!options || !options.keepSource) {
    $("sourceUrl").value = normalizeSources(data.proxySourceUrl || DEFAULT_SOURCE);
  }
  $("proxyText").value = data.proxyText || "";
  $("articleText").value = data.articleText || "";
  $("waitMin").value = String(data.waitMinSec ?? 100);
  $("waitMax").value = String(data.waitMaxSec ?? 120);
  $("timeout").value = String(data.proxyTimeoutSec ?? 15);
  $("articleTimeout").value = String(data.articleLoadTimeoutSec ?? 60);
  $("scrollEnabled").checked = data.scrollEnabled !== false;
  $("scrollSpeed").value = ["slow", "normal", "fast"].includes(data.scrollSpeed) ? data.scrollSpeed : "normal";
  $("scrollDepth").value = String(data.scrollDepthPercent ?? 95);
  $("loop").checked = Boolean(data.loop);
}

function formFocused() {
  const el = document.activeElement;
  return Boolean(el && ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName));
}

function setStatus(text, isError) {
  const node = $("status");
  node.textContent = text || "";
  node.className = isError ? "error" : "";
}

let proxyHealth = {};
let proxyLease = {};
let localProfileId = "";
let proxyStamp = null;
let statusFilter = "";

async function ensureProfileId() {
  const stored = await chrome.storage.local.get("profileId");
  if (stored.profileId) return String(stored.profileId);
  const id = crypto.randomUUID();
  await chrome.storage.local.set({ profileId: id });
  return id;
}

function proxyRowKey(proxy) {
  return self.proxyKey(proxy);
}

function healthView(proxy) {
  const key = proxyRowKey(proxy);
  const entry = proxyHealth[key];
  const lease = proxyLease[key];
  if (self.sharedStore.leaseFresh(lease)) {
    const mine = Boolean(localProfileId && lease.owner === localProfileId);
    const ip = entry && entry.ip ? " · IP " + entry.ip : "";
    return {
      text: mine ? "Đang dùng" : "Bận",
      className: "status-busy",
      title: (mine ? "Profile này đang mở proxy" : "Profile khác đang dùng, profile này tạm bỏ qua") + ip
    };
  }
  if (!entry || !entry.status || entry.status === "unknown") {
    return { text: "Chưa thử", className: "status-unknown", title: "" };
  }
  if (entry.status === "live") {
    const ip = entry.ip ? "IP: " + entry.ip : "Kết nối thành công";
    return { text: "Live", className: "status-live", title: ip };
  }
  if (entry.status === "pending") {
    return { text: "Đang thử", className: "status-pending", title: "Đang kiểm tra proxy" };
  }
  return { text: "Không", className: "status-dead", title: entry.note || "Proxy lỗi" };
}

function articleLines(text) {
  return String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
}

function validateArticles(text) {
  const urls = [];
  const seen = new Set();
  const errors = [];
  articleLines(text).forEach((line, index) => {
    try {
      const url = new URL(line);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        errors.push("Dòng " + (index + 1) + " phải là URL http hoặc https.");
        return;
      }
      const canon = self.sharedStore.articlePairKey(url.href) || url.href;
      if (seen.has(canon)) return;
      seen.add(canon);
      urls.push(canon);
    } catch (err) {
      errors.push("Dòng " + (index + 1) + " không phải URL hợp lệ.");
    }
  });
  return { urls, errors };
}

function currentProxies() {
  return self.parseProxySource($("proxyText").value);
}

function renderProxyTable() {
  const { proxies, skipped } = currentProxies();
  const hints = [];
  if (skipped) hints.push("Bỏ qua " + skipped + " dòng không đúng định dạng.");
  $("proxyHint").textContent = hints.join(" ");

  const views = proxies.map((proxy) => healthView(proxy));
  const counts = { "Chưa thử": 0, "Không": 0, "Bận": 0, "Đang dùng": 0, "Live": 0 };
  views.forEach((health) => {
    if (Object.prototype.hasOwnProperty.call(counts, health.text)) counts[health.text] += 1;
  });
  document.querySelectorAll("#proxyFilters button").forEach((button) => {
    const status = button.dataset.status;
    button.classList.toggle("on", status === statusFilter);
    const count = status ? (counts[status] || 0) : proxies.length;
    button.textContent = button.dataset.label + " " + count;
  });
  const shown = statusFilter ? (counts[statusFilter] || 0) : proxies.length;
  $("copyProxies").disabled = shown === 0;
  $("proxyCount").textContent = statusFilter
    ? shown + " / " + proxies.length + " proxy"
    : proxies.length + " proxy hợp lệ";

  const body = $("proxyTable");
  const stamp = statusFilter + "\n" + proxies.length + "\n" + views.map((health) => health.text + "\t" + health.title).join("\n");
  if (stamp === proxyStamp) return;
  proxyStamp = stamp;
  const rows = [];
  proxies.forEach((proxy, index) => {
    const health = views[index];
    if (statusFilter && health.text !== statusFilter) return;
    const row = document.createElement("tr");
    const cells = [
      String(index + 1),
      proxy.host,
      String(proxy.port),
      (proxy.protocol || "http").toUpperCase(),
      proxy.username ? "Có" : "Không"
    ];
    for (const value of cells) {
      const cell = document.createElement("td");
      cell.textContent = value;
      row.append(cell);
    }
    const healthCell = document.createElement("td");
    const badge = document.createElement("span");
    badge.className = "status-badge " + health.className;
    badge.textContent = health.text;
    if (health.title) badge.title = health.title;
    healthCell.append(badge);
    row.append(healthCell);
    const action = document.createElement("td");
    const button = document.createElement("button");
    button.type = "button";
    button.className = "link";
    button.textContent = "Xoá";
    button.dataset.index = String(index);
    action.append(button);
    row.append(action);
    rows.push(row);
  });
  body.replaceChildren();
  rows.forEach((row) => body.append(row));
  if (!rows.length) {
    const row = document.createElement("tr");
    const cell = document.createElement("td");
    cell.colSpan = 7;
    cell.textContent = proxies.length ? "Không có proxy ở trạng thái này." : "Chưa có proxy hợp lệ.";
    row.append(cell);
    body.append(row);
  }
}

function renderArticleHint() {
  const { urls, errors } = validateArticles($("articleText").value);
  if (errors.length) {
    $("articleHint").textContent = errors.slice(0, 3).join(" ");
    return;
  }
  $("articleHint").textContent = urls.length ? urls.length + " URL hợp lệ." : "Chưa có bài viết.";
}

function readForm() {
  const articles = validateArticles($("articleText").value);
  if (articles.errors.length) {
    throw new Error(articles.errors[0]);
  }
  const parsed = currentProxies();
  const rawLines = articleLines($("proxyText").value).filter((line) => !line.startsWith("#"));
  if (rawLines.length && !parsed.proxies.length) {
    throw new Error("Không có dòng proxy hợp lệ. Dùng ip:port, ip:port:user:pass hoặc socks5://ip:port.");
  }
  let waitMin = Math.round(Number($("waitMin").value));
  let waitMax = Math.round(Number($("waitMax").value));
  const timeout = Math.round(Number($("timeout").value));
  const articleTimeout = Math.round(Number($("articleTimeout").value));
  if (!Number.isInteger(waitMin) || !Number.isInteger(waitMax) || waitMin < 1 || waitMax < 1 || waitMin > 3600 || waitMax > 3600) {
    throw new Error("Thời gian chờ phải từ 1 đến 3600 giây.");
  }
  if (waitMin > waitMax) {
    const swap = waitMin;
    waitMin = waitMax;
    waitMax = swap;
    $("waitMin").value = String(waitMin);
    $("waitMax").value = String(waitMax);
  }
  if (!Number.isInteger(timeout) || timeout < 5 || timeout > 180) {
    throw new Error("Timeout proxy phải từ 5 đến 180 giây.");
  }
  if (!Number.isInteger(articleTimeout) || articleTimeout < 15 || articleTimeout > 300) {
    throw new Error("Timeout tải bài phải từ 15 đến 300 giây.");
  }
  const scrollDepth = Math.round(Number($("scrollDepth").value));
  if (!Number.isInteger(scrollDepth) || scrollDepth < 50 || scrollDepth > 100) {
    throw new Error("Độ sâu cuộn phải từ 50 đến 100%.");
  }
  const sourceUrl = sourceEntries($("sourceUrl").value).map(formatSourceLine).join("\n");
  return {
    proxySourceUrl: sourceUrl,
    proxyText: parsed.proxies.map((proxy) => self.proxyToLine(proxy)).join("\n"),
    proxies: parsed.proxies,
    articleText: articles.urls.join("\n"),
    articles: articles.urls,
    waitMinSec: waitMin,
    waitMaxSec: waitMax,
    proxyTimeoutSec: timeout,
    articleLoadTimeoutSec: articleTimeout,
    scrollEnabled: $("scrollEnabled").checked,
    scrollSpeed: $("scrollSpeed").value,
    scrollDepthPercent: Math.round(Number($("scrollDepth").value)),
    loop: $("loop").checked
  };
}

async function save() {
  const data = readForm();
  await self.sharedStore.update(function (store) {
    store.config = data;
    return store;
  });
  $("proxyText").value = data.proxyText;
  $("articleText").value = data.articleText;
  $("sourceUrl").value = data.proxySourceUrl;
  formDirty = false;
  renderProxyTable();
  renderArticleHint();
  const note = data.proxies.length + " proxy, " + data.articles.length + " bài.";
  setStatus("Đã lưu vào file chung lúc " + new Date().toLocaleTimeString("vi-VN", { hour12: false }) + " · " + note, false);
}

async function load() {
  await fillProxySources();
  const place = await self.sharedStore.describe();
  renderPlace(place);
  if (!place.connected) {
    setStatus(place.label, true);
    renderProxyTable();
    renderArticleHint();
    renderDoneCount(null);
    return;
  }
  const data = await self.sharedStore.readData();
  applyConfig(data.config, { keepSource: true });
  localProfileId = await ensureProfileId();
  proxyHealth = data.proxyHealth && typeof data.proxyHealth === "object" ? data.proxyHealth : {};
  proxyLease = data.proxyLease && typeof data.proxyLease === "object" ? data.proxyLease : {};
  formDirty = false;
  renderProxyTable();
  renderArticleHint();
  renderDoneCount(data.proxyArticleDone);
  setStatus("", false);
}

async function fetchProxies() {
  const button = $("fetchProxies");
  button.disabled = true;
  setStatus("Đang tải danh sách proxy...", false);
  try {
    const sources = sourceEntries($("sourceUrl").value);
    $("sourceUrl").value = sources.map(formatSourceLine).join("\n");
    const batches = [];
    const notes = [];
    const errors = [];
    for (const source of sources) {
      const label = sourceLabel(source.url) + (source.forceProtocol ? " " + source.forceProtocol : "");
      try {
        const response = await fetch(source.url, { cache: "no-store", signal: AbortSignal.timeout(20000) });
        if (!response.ok) throw new Error("HTTP " + response.status);
        const parsed = self.parseProxySource(await response.text());
        if (source.forceProtocol) {
          for (const proxy of parsed.proxies) proxy.protocol = source.forceProtocol;
        }
        batches.push(parsed.proxies);
        notes.push(label + " " + parsed.proxies.length);
      } catch (err) {
        errors.push(label + ": " + (err.message || "không tải được"));
      }
    }
    const merged = mergeProxyBatches(batches);
    if (!merged.length) throw new Error(errors.join(" · ") || "Không tìm thấy proxy trong các nguồn.");
    $("proxyText").value = merged.map((proxy) => self.proxyToLine(proxy)).join("\n");
    renderProxyTable();
    await save();
    const extra = errors.length ? " Nguồn lỗi: " + errors.join(" · ") + "." : "";
    setStatus("Đã gộp " + merged.length + " proxy (" + notes.join(", ") + ")." + extra, false);
  } catch (err) {
    setStatus(err.message || "Không tải được proxy. Nếu rotator đang chạy, hãy bấm Dừng rồi thử lại.", true);
  } finally {
    button.disabled = false;
  }
}

$("proxyText").addEventListener("input", () => {
  formDirty = true;
  renderProxyTable();
});
$("articleText").addEventListener("input", () => {
  formDirty = true;
  renderArticleHint();
});
for (const id of ["sourceUrl", "waitMin", "waitMax", "timeout", "articleTimeout", "scrollDepth"]) {
  $(id).addEventListener("input", () => { formDirty = true; });
}
for (const id of ["scrollEnabled", "scrollSpeed", "loop"]) {
  $(id).addEventListener("change", () => { formDirty = true; });
}
function filteredProxyLines() {
  const { proxies } = currentProxies();
  return proxies
    .filter((proxy) => !statusFilter || healthView(proxy).text === statusFilter)
    .map((proxy) => self.proxyToLine(proxy));
}

$("copyProxies").addEventListener("click", () => {
  const lines = filteredProxyLines();
  if (!lines.length) {
    setStatus("Không có proxy để copy.", true);
    return;
  }
  const text = lines.join("\n");
  navigator.clipboard.writeText(text).then(() => {
    const label = statusFilter || "Tất cả";
    setStatus("Đã copy " + lines.length + " proxy (" + label + "), mỗi dòng một proxy.", false);
  }).catch(() => {
    setStatus("Không copy được danh sách.", true);
  });
});
$("proxyFilters").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-status]");
  if (!button) return;
  statusFilter = button.dataset.status;
  renderProxyTable();
});
$("proxyTable").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-index]");
  if (!button) return;
  const index = Number(button.dataset.index);
  const parsed = currentProxies();
  parsed.proxies.splice(index, 1);
  $("proxyText").value = parsed.proxies.map((proxy) => self.proxyToLine(proxy)).join("\n");
  formDirty = true;
  renderProxyTable();
});
$("clearHealth").addEventListener("click", async () => {
  if (!window.confirm("Xoá trạng thái Live / Không của mọi proxy? Proxy đang bận vẫn bị profile khác giữ.")) return;
  proxyHealth = {};
  proxyStamp = null;
  renderProxyTable();
  try {
    await self.sharedStore.update(function (store) {
      store.proxyHealth = {};
      return store;
    }, { replaceHealth: true });
    setStatus("Đã xoá trạng thái proxy trong file chung.", false);
  } catch (err) {
    setStatus(err.message || "Không xoá được trạng thái.", true);
  }
});
$("clearProxies").addEventListener("click", async () => {
  if ($("proxyText").value.trim() && !window.confirm("Xoá toàn bộ danh sách proxy trên trang này?")) return;
  $("proxyText").value = "";
  proxyHealth = {};
  proxyLease = {};
  proxyStamp = null;
  renderProxyTable();
  try {
    await self.sharedStore.update(function (store) {
      store.config.proxyText = "";
      store.config.proxies = [];
      store.proxyHealth = {};
      store.proxyLease = {};
      return store;
    }, { replaceHealth: true, replaceLease: true });
    formDirty = true;
    setStatus("Đã xoá danh sách proxy trong file chung.", false);
  } catch (err) {
    formDirty = true;
    setStatus(err.message || "Không xoá được proxy trong file chung.", true);
  }
});
$("clearDone").addEventListener("click", async () => {
  try {
    const data = await self.sharedStore.readData();
    const total = countDonePairs(data.proxyArticleDone);
    if (!total) {
      renderDoneCount(data.proxyArticleDone);
      return;
    }
    if (!window.confirm("Xoá lịch sử proxy đã chạy cho từng bài? Lần sau sẽ chạy lại những cặp này.")) return;
    const next = await self.sharedStore.update(function (store) {
      store.proxyArticleDone = {};
      return store;
    }, { replaceDone: true });
    renderDoneCount(next.proxyArticleDone);
    setStatus("Đã xoá lịch sử đã chạy trong file chung.", false);
  } catch (err) {
    setStatus(err.message || "Không xoá được lịch sử.", true);
  }
});
async function bindPlace(task) {
  try {
    await task();
    await load();
    setStatus("Đã gắn nơi lưu chung. Dữ liệu đọc và ghi từ đây.", false);
  } catch (err) {
    if (err && err.name === "AbortError") return;
    setStatus(err.message || "Không chọn được nơi lưu.", true);
  }
}
$("pickFile").addEventListener("click", () => bindPlace(() => self.sharedStore.chooseFile()));
$("pickFolder").addEventListener("click", () => bindPlace(() => self.sharedStore.chooseDirectory()));
$("grantAccess").addEventListener("click", () => bindPlace(() => self.sharedStore.requestAccess()));
$("fetchProxies").addEventListener("click", () => fetchProxies());
$("save").addEventListener("click", () => {
  save().catch((err) => setStatus(err.message || "Không lưu được.", true));
});

async function refreshShared() {
  try {
    const place = await self.sharedStore.describe();
    renderPlace(place);
    if (!place.connected) return;
    const data = await self.sharedStore.readData();
    proxyHealth = data.proxyHealth && typeof data.proxyHealth === "object" ? data.proxyHealth : {};
    proxyLease = data.proxyLease && typeof data.proxyLease === "object" ? data.proxyLease : {};
    if (!localProfileId) localProfileId = await ensureProfileId();
    renderProxyTable();
    renderDoneCount(data.proxyArticleDone);
    if (!formDirty && !formFocused()) applyConfig(data.config, { keepSource: true });
  } catch (err) {
    $("locationHint").textContent = err.message || "Không đọc được file dữ liệu.";
  }
}

load().catch((err) => setStatus(err.message || "Không đọc được cấu hình.", true));
setInterval(() => { refreshShared().catch(() => {}); }, 4000);
