// Nơi lưu chung cho mọi profile Chrome.
// Quyền truy cập file nằm trong IndexedDB của từng profile.
// Nội dung dữ liệu nằm trên file JSON mà người dùng chọn, nên các profile đọc/ghi cùng một chỗ.
(function (root) {
  const FILE_NAME = "geo-proxy-data.json";
  const DB_NAME = "gpr-shared";
  const DB_STORE = "handles";
  const DB_KEY = "location";

  const FILE_IO_MS = 12000;
  // Proxy đang được một profile dùng. Hết hạn nếu profile đó không gia hạn (service worker chết).
  const LEASE_MS = 180000;
  let queue = Promise.resolve();
  let cacheText = null;
  let cacheData = null;

  function withTimeout(promise, ms) {
    return new Promise(function (resolve, reject) {
      let settled = false;
      const timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        reject(new Error("Quá hạn đọc/ghi file dữ liệu"));
      }, ms);
      Promise.resolve(promise).then(function (value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }, function (err) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
    });
  }

  function enqueue(task) {
    const job = queue.then(function () {
      return withTimeout(Promise.resolve().then(task), 45000);
    }, function () {
      return withTimeout(Promise.resolve().then(task), 45000);
    });
    queue = job.then(function () {}, function () {});
    return job;
  }

  function emptyData() {
    return {
      version: 1,
      savedAt: 0,
      config: {},
      proxyHealth: {},
      proxyArticleDone: {},
      proxyLease: {}
    };
  }

  // Copy nông: file có hàng nghìn proxy, JSON clone cả cục sẽ làm service worker khựng.
  function shell(data) {
    const src = data || emptyData();
    return {
      version: 1,
      savedAt: Number(src.savedAt) || 0,
      config: Object.assign({}, src.config || {}),
      proxyHealth: Object.assign({}, src.proxyHealth || {}),
      proxyArticleDone: Object.assign({}, src.proxyArticleDone || {}),
      proxyLease: Object.assign({}, src.proxyLease || {})
    };
  }

  function openDb() {
    return new Promise(function (resolve, reject) {
      const request = indexedDB.open(DB_NAME, 1);
      request.onupgradeneeded = function () {
        if (!request.result.objectStoreNames.contains(DB_STORE)) {
          request.result.createObjectStore(DB_STORE);
        }
      };
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function requestResult(request) {
    return new Promise(function (resolve, reject) {
      request.onsuccess = function () { resolve(request.result); };
      request.onerror = function () { reject(request.error); };
    });
  }

  function transactionDone(tx) {
    return new Promise(function (resolve, reject) {
      tx.oncomplete = function () { resolve(); };
      tx.onerror = function () { reject(tx.error); };
      tx.onabort = function () { reject(tx.error || new Error("Không lưu được quyền truy cập file.")); };
    });
  }

  async function loadRecord() {
    const db = await openDb();
    const tx = db.transaction(DB_STORE, "readonly");
    const done = transactionDone(tx);
    const value = await requestResult(tx.objectStore(DB_STORE).get(DB_KEY));
    await done;
    db.close();
    return value || null;
  }

  async function saveRecord(record) {
    const db = await openDb();
    const tx = db.transaction(DB_STORE, "readwrite");
    const done = transactionDone(tx);
    await requestResult(tx.objectStore(DB_STORE).put(record, DB_KEY));
    await done;
    db.close();
  }

  function permissionError() {
    return new Error("Profile này chưa có quyền đọc/ghi dữ liệu chung. Mở Cài đặt và bấm Cấp quyền lại.");
  }

  function missingLocationError() {
    return new Error("Chưa chọn file hoặc thư mục dữ liệu. Mở Cài đặt và chọn nơi lưu chung.");
  }

  async function fileHandle(record, create) {
    if (!record || !record.handle) throw missingLocationError();
    let permission = "prompt";
    try {
      permission = await record.handle.queryPermission({ mode: "readwrite" });
    } catch (err) {
      permission = "prompt";
    }
    if (permission !== "granted") throw permissionError();
    if (record.kind === "directory") {
      try {
        return await record.handle.getFileHandle(FILE_NAME, { create: Boolean(create) });
      } catch (err) {
        if (err && err.name === "NotFoundError") return null;
        throw err;
      }
    }
    return record.handle;
  }

  async function clearRecord() {
    const db = await openDb();
    const tx = db.transaction(DB_STORE, "readwrite");
    const done = transactionDone(tx);
    await requestResult(tx.objectStore(DB_STORE).delete(DB_KEY));
    await done;
    db.close();
  }

  function looksLikeStore(raw) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return false;
    if (!Object.keys(raw).length) return true;
    return raw.version === 1 || Object.prototype.hasOwnProperty.call(raw, "config") || Object.prototype.hasOwnProperty.call(raw, "proxyHealth") || Object.prototype.hasOwnProperty.call(raw, "proxyArticleDone") || Object.prototype.hasOwnProperty.call(raw, "proxyLease");
  }

  function normalize(raw) {
    const data = emptyData();
    if (!raw || typeof raw !== "object") return data;
    data.version = 1;
    data.savedAt = Number(raw.savedAt) || 0;
    data.config = raw.config && typeof raw.config === "object" ? raw.config : {};
    data.proxyHealth = raw.proxyHealth && typeof raw.proxyHealth === "object" && !Array.isArray(raw.proxyHealth) ? raw.proxyHealth : {};
    data.proxyArticleDone = raw.proxyArticleDone && typeof raw.proxyArticleDone === "object" && !Array.isArray(raw.proxyArticleDone) ? raw.proxyArticleDone : {};
    data.proxyLease = raw.proxyLease && typeof raw.proxyLease === "object" && !Array.isArray(raw.proxyLease) ? raw.proxyLease : {};
    return data;
  }

  function isBlank(data) {
    const config = data.config || {};
    const hasProxy = String(config.proxyText || "").trim() || (Array.isArray(config.proxies) && config.proxies.length);
    const hasArticle = String(config.articleText || "").trim() || (Array.isArray(config.articles) && config.articles.length);
    return !hasProxy && !hasArticle && !Object.keys(data.proxyHealth || {}).length && !Object.keys(data.proxyArticleDone || {}).length && !Object.keys(data.proxyLease || {}).length;
  }

  async function readLegacy() {
    const stored = await chrome.storage.local.get(null);
    return normalize({
      config: {
        proxySourceUrl: stored.proxySourceUrl || "",
        proxyText: stored.proxyText || "",
        proxies: stored.proxies || [],
        articleText: stored.articleText || "",
        articles: stored.articles || [],
        waitMinSec: stored.waitMinSec,
        waitMaxSec: stored.waitMaxSec,
        proxyTimeoutSec: stored.proxyTimeoutSec,
        articleLoadTimeoutSec: stored.articleLoadTimeoutSec,
        scrollEnabled: stored.scrollEnabled,
        scrollSpeed: stored.scrollSpeed,
        scrollDepthPercent: stored.scrollDepthPercent,
        loop: stored.loop
      },
      proxyHealth: stored.proxyHealth || {},
      proxyArticleDone: stored.proxyArticleDone || {}
    });
  }

  async function readData() {
    const record = await loadRecord();
    if (!record) throw missingLocationError();
    const handle = await fileHandle(record, false);
    if (!handle) return emptyData();
    const file = await withTimeout(handle.getFile(), FILE_IO_MS);
    const text = await withTimeout(file.text(), FILE_IO_MS);
    if (text === cacheText && cacheData) return cacheData;
    if (!String(text || "").trim()) {
      cacheText = text;
      cacheData = emptyData();
      return cacheData;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (err) {
      throw new Error("File dữ liệu không phải JSON hợp lệ.");
    }
    if (!looksLikeStore(parsed)) {
      throw new Error("File này không phải dữ liệu Geo Proxy. Chọn file trống hoặc để thư mục tự tạo geo-proxy-data.json.");
    }
    cacheText = text;
    cacheData = normalize(parsed);
    return cacheData;
  }

  async function writeData(data) {
    const record = await loadRecord();
    if (!record) throw missingLocationError();
    const handle = await fileHandle(record, true);
    if (!handle) throw new Error("Không tạo được file " + FILE_NAME + " trong thư mục đã chọn.");
    const payload = normalize(data);
    payload.savedAt = Date.now();
    const body = JSON.stringify(payload, null, 2);
    const writable = await withTimeout(handle.createWritable(), FILE_IO_MS);
    try {
      await withTimeout(writable.write(body), FILE_IO_MS);
      await withTimeout(writable.close(), FILE_IO_MS);
    } catch (err) {
      try { await writable.abort(); } catch (abortErr) { /* bỏ khóa ghi nếu còn. */ }
      throw err;
    }
    cacheText = body;
    cacheData = payload;
    return payload;
  }

  function pairUrl(entry) {
    if (typeof entry === "string") return entry;
    if (entry && typeof entry.url === "string") return entry.url;
    return "";
  }

  // Bỏ fbclid (và vài mã click tracking) để so / lưu theo link gốc.
  function articlePairKey(raw) {
    return String(raw || "").trim();
  }

  function pairOk(entry) {
    if (!entry || typeof entry !== "object" || typeof entry.ok !== "boolean") return null;
    return entry.ok;
  }

  // Thành công giữ lại. Lỗi chỉ ghi khi chưa từng chạy được. Chuỗi cũ là cặp chưa rõ kết quả.
  function mergePair(prev, next) {
    const url = articlePairKey(pairUrl(next) || pairUrl(prev));
    if (!url) return null;
    const prevOk = pairOk(prev);
    const nextOk = pairOk(next);
    if (prevOk === true || nextOk === true) return { url: url, ok: true, at: Date.now() };
    if (prevOk === false || nextOk === false) {
      const source = nextOk === false ? next : prev;
      const note = String((source && source.note) || "").slice(0, 160);
      const item = { url: url, ok: false, at: Number(source && source.at) || Date.now() };
      if (note) item.note = note;
      return item;
    }
    return url;
  }

  function unionDone(left, right) {
    const out = {};
    const keys = new Set(Object.keys(left || {}).concat(Object.keys(right || {})));
    keys.forEach(function (key) {
      const byUrl = new Map();
      []
        .concat(Array.isArray(left[key]) ? left[key] : [])
        .concat(Array.isArray(right[key]) ? right[key] : [])
        .forEach(function (entry) {
          const url = articlePairKey(pairUrl(entry));
          if (!url) return;
          byUrl.set(url, mergePair(byUrl.get(url), entry));
        });
      const items = Array.from(byUrl.values()).filter(Boolean);
      if (items.length) out[key] = items;
    });
    return out;
  }

  function leaseFresh(lease, now) {
    if (!lease || !lease.owner) return false;
    return (Number(now) || Date.now()) - Number(lease.claimedAt || 0) < LEASE_MS;
  }

  // Bản ghi mới hơn thắng. Profile khác không được ghi đè proxy đang có người giữ.
  function mergeHealth(latestHealth, mutatedHealth, leaseMap, now) {
    const out = Object.assign({}, latestHealth || {});
    Object.keys(mutatedHealth || {}).forEach(function (key) {
      const prev = out[key];
      const next = mutatedHealth[key];
      if (!next || !next.status) return;
      const lease = leaseMap && leaseMap[key];
      if (leaseFresh(lease, now) && next.owner && next.owner !== lease.owner) return;
      if (!prev) {
        out[key] = next;
        return;
      }
      const nextAt = Number(next.updatedAt) || 0;
      const prevAt = Number(prev.updatedAt) || 0;
      if (next.status === "pending" && prev.status !== "pending" && nextAt <= prevAt) return;
      if (nextAt >= prevAt) out[key] = next;
    });
    return out;
  }

  function mergeLease(latest, before, after, now) {
    const out = {};
    const keys = {};
    [latest, before, after].forEach(function (map) {
      Object.keys(map || {}).forEach(function (key) { keys[key] = true; });
    });
    Object.keys(keys).forEach(function (key) {
      const disk = latest && latest[key];
      const prev = before && before[key];
      const next = after && after[key];
      const changed = JSON.stringify(prev || null) !== JSON.stringify(next || null);
      let pick = disk || null;
      if (changed) {
        if (!next) {
          const sameHeld = disk && prev && disk.owner === prev.owner && Number(disk.claimedAt) <= Number(prev.claimedAt) + 2000;
          pick = sameHeld ? null : (disk || null);
        } else if (!disk || !leaseFresh(disk, now) || disk.owner === next.owner) {
          if (disk && disk.owner === next.owner && Number(disk.claimedAt) > Number(next.claimedAt)) pick = disk;
          else pick = next;
        } else {
          pick = disk;
        }
      }
      if (leaseFresh(pick, now)) out[key] = { owner: String(pick.owner), claimedAt: Number(pick.claimedAt) || now };
    });
    return out;
  }

  function changedFields(before, after) {
    const patch = {};
    const keys = new Set(Object.keys(before || {}).concat(Object.keys(after || {})));
    keys.forEach(function (key) {
      const left = before ? before[key] : undefined;
      const right = after ? after[key] : undefined;
      if (left === right) return;
      if (left && right && typeof left === "object" && typeof right === "object") {
        if (JSON.stringify(left) !== JSON.stringify(right)) patch[key] = right;
        return;
      }
      patch[key] = right;
    });
    return patch;
  }

  function update(mutator, flags) {
    const mode = flags || {};
    return enqueue(async function () {
      const current = await readData();
      const draft = shell(current);
      const mutated = (await mutator(draft)) || draft;
      const latest = await readData();
      const now = Date.now();
      const next = shell(latest);
      next.proxyArticleDone = mode.replaceDone
        ? (mutated.proxyArticleDone || {})
        : unionDone(latest.proxyArticleDone, mutated.proxyArticleDone);
      next.proxyLease = mode.replaceLease
        ? (mutated.proxyLease || {})
        : mergeLease(latest.proxyLease, current.proxyLease, mutated.proxyLease, now);
      next.proxyHealth = mode.replaceHealth
        ? (mutated.proxyHealth || {})
        : mergeHealth(latest.proxyHealth, mutated.proxyHealth, next.proxyLease, now);
      next.config = Object.assign({}, latest.config || {}, changedFields(current.config, mutated.config));
      return writeData(next);
    });
  }

  function adoptBlank() {
    return enqueue(async function () {
      const data = await readData();
      if (!isBlank(data)) return data;
      const legacy = await readLegacy();
      if (!isBlank(legacy)) return writeData(legacy);
      return writeData(data);
    });
  }

  async function bindRecord(record) {
    await saveRecord(record);
    try {
      return await adoptBlank();
    } catch (err) {
      await clearRecord();
      throw err;
    }
  }
  async function chooseFile() {
    if (typeof showOpenFilePicker !== "function") {
      throw new Error("Chrome này không chọn được file dữ liệu.");
    }
    const picked = await showOpenFilePicker({
      id: "gpr-data-file",
      multiple: false,
      types: [{ description: "JSON", accept: { "application/json": [".json"] } }]
    });
    const handle = picked && picked[0];
    if (!handle) throw new Error("Chưa chọn file.");
    const permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") throw permissionError();
    return bindRecord({ kind: "file", handle: handle });
  }

  async function chooseDirectory() {
    if (typeof showDirectoryPicker !== "function") {
      throw new Error("Chrome này không chọn được thư mục dữ liệu.");
    }
    const handle = await showDirectoryPicker({ id: "gpr-data-dir", mode: "readwrite" });
    const permission = await handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") throw permissionError();
    return bindRecord({ kind: "directory", handle: handle });
  }

  async function requestAccess() {
    const record = await loadRecord();
    if (!record || !record.handle) throw missingLocationError();
    const permission = await record.handle.requestPermission({ mode: "readwrite" });
    if (permission !== "granted") throw permissionError();
    return describe();
  }

  async function describe() {
    const record = await loadRecord();
    if (!record || !record.handle) {
      return {
        connected: false,
        kind: "",
        permission: "",
        label: "Chưa chọn nơi lưu. Mỗi profile Chrome hãy chọn cùng một file hoặc cùng một thư mục."
      };
    }
    let permission = "prompt";
    try {
      permission = await record.handle.queryPermission({ mode: "readwrite" });
    } catch (err) {
      permission = "prompt";
    }
    const name = record.kind === "directory" ? record.handle.name + "/" + FILE_NAME : record.handle.name;
    const connected = permission === "granted";
    let label = (record.kind === "directory" ? "Thư mục: " : "File: ") + name;
    if (!connected) label += permission === "denied" ? " — quyền bị chặn." : " — bấm Cấp quyền lại.";
    return { connected: connected, kind: record.kind || "file", permission: permission, label: label };
  }

  root.sharedStore = {
    FILE_NAME: FILE_NAME,
    emptyData: emptyData,
    LEASE_MS: LEASE_MS,
    leaseFresh: leaseFresh,
    pairUrl: pairUrl,
    articlePairKey: articlePairKey,
    mergePair: mergePair,
    describe: describe,
    chooseFile: chooseFile,
    chooseDirectory: chooseDirectory,
    requestAccess: requestAccess,
    readData: readData,
    update: update
  };
})(typeof self !== "undefined" ? self : globalThis);
