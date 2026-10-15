// Danh sách nguồn proxy USA. Trang cài đặt đọc list-proxy.txt; chuỗi này dùng khi file không đọc được.
(function (root) {
  const DEFAULT_PROXY_SOURCES = [
    "https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/us/http.txt",
    "https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/us/socks4.txt|socks4",
    "https://raw.githubusercontent.com/databay-labs/free-proxy-list/master/by-country/us/socks5.txt|socks5",
    "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/countries/US/data.txt",
    "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/countries/US/data.txt",
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=US&ssl=all&anonymity=all",
    "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/countries/us/data.json",
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=US&ssl=all&anonymity=all|socks5",
    "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=10000&country=US&ssl=all&anonymity=all|socks4",
    "https://api.proxyscrape.com/v4/free-proxy-list/get?request=display_proxies&proxy_format=protocolipport&format=text&country=us"
  ].join("\n");

  async function readProxySources() {
    try {
      const response = await fetch(root.chrome.runtime.getURL("list-proxy.txt"), { cache: "no-store" });
      if (!response.ok) throw new Error("HTTP " + response.status);
      const text = String(await response.text() || "").trim();
      if (text) return text;
    } catch (err) {
      // File không có trong gói extension hoặc trình duyệt chặn đọc.
    }
    return DEFAULT_PROXY_SOURCES;
  }

  root.DEFAULT_PROXY_SOURCES = DEFAULT_PROXY_SOURCES;
  root.readProxySources = readProxySources;
})(typeof self !== "undefined" ? self : globalThis);
