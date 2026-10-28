// Сервер без зависимостей: раздаёт сайт и хранит общую ленту посланий.
const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, "data");
const DATA_FILE = path.join(DATA_DIR, "messages.json");
const MAX_STORED = 500;
const MIME = {
  ".html": "text/html; charset=utf-8", ".png": "image/png", ".jpg": "image/jpeg",
  ".svg": "image/svg+xml", ".css": "text/css; charset=utf-8", ".js": "text/javascript; charset=utf-8",
  ".ico": "image/x-icon", ".txt": "text/plain; charset=utf-8"
};

fs.mkdirSync(DATA_DIR, { recursive: true });
let messages = [];
try { messages = JSON.parse(fs.readFileSync(DATA_FILE, "utf8")); } catch { messages = []; }
if (!Array.isArray(messages)) messages = [];

function save() {
  const tmp = DATA_FILE + ".tmp";
  fs.writeFile(tmp, JSON.stringify(messages), (err) => {
    if (!err) fs.rename(tmp, DATA_FILE, () => {});
  });
}

const clients = new Set();
function broadcast(entry) {
  const chunk = "data: " + JSON.stringify(entry) + "\n\n";
  for (const res of clients) res.write(chunk);
}
setInterval(() => { for (const res of clients) res.write(": ping\n\n"); }, 25000).unref();

// Ограничение частоты: не чаще 1 письма в 8 секунд и 30 в час с одного адреса
const hits = new Map();
function allowed(ip) {
  const now = Date.now();
  const list = (hits.get(ip) || []).filter((t) => now - t < 3600000);
  if (list.length >= 30 || (list.length && now - list[list.length - 1] < 8000)) { hits.set(ip, list); return false; }
  list.push(now); hits.set(ip, list); return true;
}
setInterval(() => { const now = Date.now(); for (const [ip, l] of hits) if (!l.some((t) => now - t < 3600000)) hits.delete(ip); }, 600000).unref();

function send(res, status, body, type = "application/json; charset=utf-8") {
  res.writeHead(status, { "Content-Type": type, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

function clientIp(req) {
  return (req.headers["x-forwarded-for"] || "").split(",")[0].trim() || req.socket.remoteAddress || "unknown";
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on("data", (c) => { size += c.length; if (size > 4096) { reject(new Error("too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/events" && req.method === "GET") {
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    clients.add(res);
    req.on("close", () => clients.delete(res));
    return;
  }

  if (url.pathname === "/api/messages" && req.method === "GET") {
    const limit = Math.min(Math.max(parseInt(url.searchParams.get("limit"), 10) || 20, 1), 50);
    return send(res, 200, { messages: messages.slice(-limit) });
  }

  if (url.pathname === "/api/messages" && req.method === "POST") {
    if (!allowed(clientIp(req))) return send(res, 429, { error: "Слишком часто. Подожди немного и отправь снова." });
    let data;
    try { data = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: "Не удалось прочитать послание." }); }
    const text = String((data && data.text) || "").trim().slice(0, 240);
    const name = String((data && data.name) || "").trim().slice(0, 28) || "Аноним";
    if (!text) return send(res, 400, { error: "Послание пустое." });
    const entry = { id: crypto.randomUUID(), name, text, at: new Date().toISOString() };
    messages.push(entry);
    if (messages.length > MAX_STORED) messages = messages.slice(-MAX_STORED);
    save();
    broadcast(entry);
    return send(res, 201, { message: entry });
  }

  if (req.method !== "GET" && req.method !== "HEAD") return send(res, 405, { error: "Method not allowed" });

  // Статические файлы
  let rel = decodeURIComponent(url.pathname);
  if (rel === "/") rel = "/index.html";
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC + path.sep)) return send(res, 403, "Forbidden", "text/plain");
  fs.readFile(file, (err, buf) => {
    if (err) return send(res, 404, "Не найдено", "text/plain; charset=utf-8");
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(file)] || "application/octet-stream",
      "Cache-Control": path.extname(file) === ".html" ? "no-cache" : "public, max-age=86400",
      "X-Content-Type-Options": "nosniff"
    });
    res.end(req.method === "HEAD" ? undefined : buf);
  });
});

server.listen(PORT, () => console.log("Сайт запущен: http://localhost:" + PORT));
