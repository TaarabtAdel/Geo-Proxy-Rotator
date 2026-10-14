const $ = (id) => document.getElementById(id);

let snapshot = null;
let busy = false;
let logStamp = "";

function call(type) {
  return chrome.runtime.sendMessage({ type });
}

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString("vi-VN", { hour12: false });
}

function secondsLeft() {
  if (!snapshot || !snapshot.running) return null;
  if (snapshot.phase === "waiting" && snapshot.nextArticleAt) {
    return Math.max(0, Math.ceil((snapshot.nextArticleAt - Date.now()) / 1000));
  }
  if (snapshot.phase === "loading_article" && snapshot.loadDeadline) {
    return Math.max(0, Math.ceil((snapshot.loadDeadline - Date.now()) / 1000));
  }
  if (snapshot.phase === "switching" && snapshot.switchDeadline) {
    return Math.max(0, Math.ceil((snapshot.switchDeadline - Date.now()) / 1000));
  }
  if (snapshot.phase === "checking" && snapshot.checkDeadline) {
    return Math.max(0, Math.ceil((snapshot.checkDeadline - Date.now()) / 1000));
  }
  if (snapshot.phase === "spoofing" && snapshot.spoofDeadline) {
    return Math.max(0, Math.ceil((snapshot.spoofDeadline - Date.now()) / 1000));
  }
  return null;
}

function renderLogs(logs) {
  const list = $("logs");
  list.replaceChildren();
  for (const entry of logs || []) {
    const item = document.createElement("li");
    const time = document.createElement("time");
    time.dateTime = new Date(entry.ts).toISOString();
    time.textContent = formatClock(entry.ts);
    const text = document.createElement("span");
    text.className = entry.level || "info";
    text.textContent = " " + (entry.message || "");
    item.append(time, text);
    list.append(item);
  }
}

function render() {
  if (!snapshot) return;
  const running = Boolean(snapshot.running);
  $("phase").textContent = snapshot.phaseLabel || (running ? "Đang chạy" : "Sẵn sàng");
  $("phase").className = "phase" + (running ? " on" : snapshot.phaseLabel && snapshot.phaseLabel !== "Sẵn sàng" ? " bad" : " idle");
  $("start").disabled = busy || running;
  $("stop").disabled = busy || !running;
  const canNext = running && (snapshot.phase === "waiting" || snapshot.phase === "loading_article");
  $("nextAuto").disabled = busy || !canNext;

  const proxy = snapshot.proxyTotal
    ? snapshot.proxyIndex + "/" + snapshot.proxyTotal + " · " + snapshot.proxyLabel
    : (snapshot.proxyLabel || "—");
  $("proxy").textContent = snapshot.proxyLabel && snapshot.proxyLabel !== "—" ? proxy : "—";
  $("location").textContent = snapshot.locationLabel || "—";

  const article = $("article");
  if (snapshot.articleIndex && snapshot.articleTotal) {
    article.textContent = snapshot.articleIndex + "/" + snapshot.articleTotal + " · " + (snapshot.articleLabel || "—");
    article.title = snapshot.articleUrl || "";
  } else {
    article.textContent = "—";
    article.title = "";
  }

  const left = secondsLeft();
  const label = $("countdownLabel");
  if (left == null) {
    $("countdown").textContent = "—";
    if (label) label.textContent = "Còn lại tới bài tiếp";
  } else if (snapshot.phase === "loading_article") {
    if (label) label.textContent = "Còn lại tải bài";
    $("countdown").textContent = left + " giây (tối đa tải bài)";
  } else if (snapshot.phase === "switching") {
    if (label) label.textContent = "Còn lại chuyển proxy";
    $("countdown").textContent = left + " giây chuyển proxy";
  } else if (snapshot.phase === "checking") {
    if (label) label.textContent = "Còn lại kiểm tra proxy";
    $("countdown").textContent = left + " giây kiểm tra proxy";
  } else if (snapshot.phase === "spoofing") {
    if (label) label.textContent = "Còn lại giả lập vị trí";
    $("countdown").textContent = left + " giây giả lập vị trí";
  } else {
    if (label) label.textContent = "Còn lại tới bài tiếp";
    $("countdown").textContent = left + " giây tới bài tiếp";
  }
  $("failed").textContent = String(snapshot.failedCount || 0);
  const stamp = JSON.stringify(snapshot.logs || []);
  if (stamp !== logStamp) {
    logStamp = stamp;
    renderLogs(snapshot.logs);
  }
}

async function refresh() {
  try {
    const response = await call("STATUS");
    if (!response || !response.ok) {
      $("message").textContent = response?.error || "Không đọc được trạng thái.";
      return;
    }
    snapshot = response;
    $("message").textContent = "";
    render();
  } catch (err) {
    $("message").textContent = err.message || "Mất kết nối với service worker.";
  }
}

async function run(type) {
  busy = true;
  render();
  const pending = { START: "Đang bắt đầu...", STOP: "Đang dừng...", NEXT: "Đang chuyển bài..." };
  $("message").textContent = pending[type] || "";
  try {
    const response = await call(type);
    if (!response || !response.ok) throw new Error(response?.error || "Lệnh thất bại");
    snapshot = response;
    $("message").textContent = "";
  } catch (err) {
    $("message").textContent = err.message || "Lệnh thất bại";
  } finally {
    busy = false;
    render();
  }
}

$("start").addEventListener("click", () => run("START"));
$("nextAuto").addEventListener("click", () => run("NEXT"));
$("stop").addEventListener("click", () => run("STOP"));
$("openOptions").addEventListener("click", () => chrome.runtime.openOptionsPage());

refresh();
setInterval(refresh, 1000);
setInterval(render, 250);
