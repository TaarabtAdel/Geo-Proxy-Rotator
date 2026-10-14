// Parser dùng chung cho trang options và service worker.
// Dòng hợp lệ: ip:port, ip:port:user:pass, hoặc scheme://ip:port (http, socks4, socks5).
(function (root) {
  function isIPv4(host) {
    const parts = host.split(".");
    if (parts.length !== 4) return false;
    return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
  }

  function isHostname(host) {
    return /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i.test(host);
  }

  function normalizeProtocol(value) {
    const protocol = String(value || "http").toLowerCase();
    // List miễn phí ghi "https" cho proxy HTTP có CONNECT, Chrome vẫn đặt scheme http.
    if (protocol === "https" || protocol === "http") return "http";
    if (protocol === "socks4" || protocol === "socks5") return protocol;
    return "";
  }

  function parseProxyLine(line) {
    let raw = String(line || "").trim();
    if (!raw || raw.startsWith("#")) return null;
    let protocol = "http";
    const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i);
    if (scheme) {
      protocol = normalizeProtocol(scheme[1]);
      if (!protocol) return null;
      raw = raw.slice(scheme[0].length);
    }
    raw = raw.split("/")[0].trim();
    const parts = raw.split(":");
    if (parts.length !== 2 && parts.length < 4) return null;
    const host = parts[0].trim();
    const port = Number(parts[1]);
    if ((!isIPv4(host) && !isHostname(host)) || !Number.isInteger(port) || port < 1 || port > 65535) {
      return null;
    }
    const proxy = { host, port, protocol };
    if (parts.length >= 4) {
      proxy.username = parts[2];
      proxy.password = parts.slice(3).join(":");
      if (!proxy.username) return null;
    }
    return proxy;
  }

  function proxyKey(proxy) {
    const protocol = normalizeProtocol(proxy.protocol) || "http";
    const base = proxy.host + ":" + proxy.port;
    return protocol === "http" ? base : protocol + "://" + base;
  }

  function proxyToLine(proxy) {
    const protocol = normalizeProtocol(proxy.protocol) || "http";
    const auth = proxy.username ? ":" + proxy.username + ":" + (proxy.password || "") : "";
    const base = proxy.host + ":" + proxy.port + auth;
    return protocol === "http" ? base : protocol + "://" + base;
  }

  function fromJsonItem(item) {
    if (typeof item === "string") return parseProxyLine(item);
    if (!item || typeof item !== "object") return null;
    const protocol = normalizeProtocol(item.protocol || "http");
    if (!protocol) return null;
    const host = item.ip || item.host;
    if (!host || item.port == null || item.port === "") return null;
    const proxy = parseProxyLine((protocol === "http" ? "" : protocol + "://") + host + ":" + item.port);
    if (!proxy) return null;
    const uptime = Number(item.uptime_percent);
    if (Number.isFinite(uptime)) proxy.uptime = uptime;
    return proxy;
  }

  // Nhận text ip:port hoặc JSON (ip/port/protocol, kể cả socks) từ API.
  function parseProxySource(input) {
    const text = String(input || "").trim();
    let entries = [];
    if (text.startsWith("[") || text.startsWith("{")) {
      try {
        const data = JSON.parse(text);
        const list = Array.isArray(data) ? data : (data.data || data.proxies || []);
        entries = Array.isArray(list) ? list.map(fromJsonItem) : [];
      } catch (err) {
        entries = text.split(/\r?\n/).filter((line) => String(line || "").trim() && !String(line).trim().startsWith("#")).map(parseProxyLine);
      }
    } else {
      entries = text.split(/\r?\n/).filter((line) => String(line || "").trim() && !String(line).trim().startsWith("#")).map(parseProxyLine);
    }

    const proxies = [];
    const seen = new Set();
    let skipped = 0;
    for (const proxy of entries) {
      if (!proxy) {
        skipped += 1;
        continue;
      }
      const key = proxyKey(proxy);
      if (seen.has(key)) continue;
      seen.add(key);
      proxies.push(proxy);
    }
    return { proxies, skipped };
  }

  root.parseProxyLine = parseProxyLine;
  root.parseProxySource = parseProxySource;
  root.proxyToLine = proxyToLine;
  root.proxyKey = proxyKey;
})(typeof self !== "undefined" ? self : globalThis);
