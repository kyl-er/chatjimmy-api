// chatjimmy-api — session/chat layer over chatjimmy.ai's demo endpoint.
//
// Reverse-engineered from the site's Next.js bundle (Vercel AI SDK useChat):
//   POST https://chatjimmy.ai/api/chat
//     body: {chatOptions: {selectedModel: "llama3.1-8B", systemPrompt, topK, …},
//            messages: [{role: "user"|"assistant", content: string}]}
//     resp: plain-text stream (streamMode:"text") ending with a metrics
//           sentinel: <reply><|stats|>{json}<|/stats|>
//   GET  https://chatjimmy.ai/api/models -> OpenAI-style model list
// If the wire format ever breaks, re-fetch /_next/static/chunks/* and grep
// for `"api/chat"`, `chatOptions`, and `<|stats|>` to re-derive it.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const PORT = process.env.PORT || 8787;
const UPSTREAM = process.env.CHATJIMMY_URL || "https://chatjimmy.ai";
const DEFAULT_MODEL = process.env.CHATJIMMY_MODEL || "llama3.1-8B";
const TIMEOUT_MS = Number(process.env.CHATJIMMY_TIMEOUT_MS || 120000);
const RETRIES = Number(process.env.CHATJIMMY_RETRIES || 2);
const DATA_FILE = path.join(__dirname, "data", "chats.json");
const PUBLIC_DIR = path.join(__dirname, "public");

const chats = new Map();
function loadChats() {
  try {
    const arr = JSON.parse(fs.readFileSync(DATA_FILE, "utf8"));
    for (const c of arr) chats.set(c.id, c);
  } catch {}
}
let saveTimer = null;
function saveChats() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.writeFileSync(DATA_FILE, JSON.stringify([...chats.values()], null, 2));
    } catch (e) {
      console.error("save failed:", e.message);
    }
  }, 200);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class UpstreamError extends Error {
  constructor(message, status = 0, empty = false) {
    super(message);
    this.status = status;
    this.empty = empty;
  }
}

function extractStats(raw) {
  const m = raw.match(/<\|stats\|>([\s\S]+?)<\|\/stats\|>\s*$/);
  if (!m) return { content: raw.trim(), stats: null };
  let stats = null;
  try {
    stats = JSON.parse(m[1]);
  } catch {}
  return { content: raw.slice(0, m.index).trim(), stats };
}

async function callUpstream(messages, chatOptions) {
  const res = await fetch(`${UPSTREAM}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chatOptions: { selectedModel: DEFAULT_MODEL, ...chatOptions },
      messages,
    }),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new UpstreamError(`upstream HTTP ${res.status}`, res.status);
  const { content, stats } = extractStats(await res.text());
  if (!content) throw new UpstreamError("empty response from upstream", 0, true);
  return { content, stats };
}

async function sendWithRetry(messages, chatOptions, retries = RETRIES) {
  let lastErr;
  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const { content, stats } = await callUpstream(messages, chatOptions);
      return { content, stats, attempts: attempt };
    } catch (e) {
      lastErr = e;
      if (attempt <= retries) await sleep(500 * attempt);
    }
  }
  throw Object.assign(lastErr, { attempts: retries + 1 });
}

function newChat() {
  const id = "chat_" + crypto.randomUUID();
  const chat = { id, title: "New chat", createdAt: Date.now(), updatedAt: Date.now(), messages: [], lastError: null };
  chats.set(id, chat);
  saveChats();
  return chat;
}

function summarize(c) {
  const { id, title, createdAt, updatedAt, lastError } = c;
  return { id, title, createdAt, updatedAt, lastError, messageCount: c.messages.length };
}

async function sendMessage(chat, content, chatOptions) {
  chat.messages.push({ id: crypto.randomUUID(), role: "user", content, createdAt: Date.now() });
  if (chat.title === "New chat") chat.title = content.slice(0, 60);
  chat.updatedAt = Date.now();
  chat.lastError = null;
  saveChats();
  const history = chat.messages.filter((m) => m.role !== "error").map(({ role, content }) => ({ role, content }));
  try {
    const { content: reply, stats, attempts } = await sendWithRetry(history, chatOptions);
    const assistant = { id: crypto.randomUUID(), role: "assistant", content: reply, stats, attempts, createdAt: Date.now() };
    chat.messages.push(assistant);
    chat.updatedAt = Date.now();
    saveChats();
    return assistant;
  } catch (e) {
    chat.lastError = { message: e.message, attempts: e.attempts || 1, failedAt: Date.now() };
    saveChats();
    throw e;
  }
}

function json(res, status, obj) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS",
  });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 2e6) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (e) {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

loadChats();

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  try {
    if (req.method === "OPTIONS") return json(res, 204, {});

    if (req.method === "GET" && p === "/api/models") {
      const r = await fetch(`${UPSTREAM}/api/models`, { signal: AbortSignal.timeout(15000) });
      return json(res, r.status, await r.json());
    }

    if (req.method === "GET" && p === "/api/chats") return json(res, 200, { chats: [...chats.values()].map(summarize).sort((a, b) => b.updatedAt - a.updatedAt) });

    const chatMatch = p.match(/^\/api\/chats\/([\w-]+)(\/(messages|retry))?$/);
    if (chatMatch) {
      const chat = chats.get(chatMatch[1]);
      if (!chat) return json(res, 404, { error: "chat not found" });
      const sub = chatMatch[3];

      if (req.method === "GET" && !sub) return json(res, 200, { chat });

      if (req.method === "DELETE" && !sub) {
        chats.delete(chat.id);
        saveChats();
        return json(res, 200, { deleted: chat.id });
      }

      if (req.method === "POST" && (sub === "messages" || sub === "retry")) {
        const body = await readBody(req);
        let content = (body.content || body.message || "").toString().trim();
        if (sub === "retry") {
          const lastUser = [...chat.messages].reverse().find((m) => m.role === "user");
          if (!lastUser) return json(res, 400, { error: "nothing to retry" });
          content = lastUser.content;
          chat.messages = chat.messages.slice(0, chat.messages.indexOf(lastUser));
        }
        if (!content) return json(res, 400, { error: "content required" });
        const assistant = await sendMessage(chat, content, body.chatOptions);
        return json(res, 200, { chat: summarize(chat), reply: assistant.content, stats: assistant.stats, attempts: assistant.attempts });
      }
    }

    if (req.method === "POST" && (p === "/api/chats" || p === "/api/chat")) {
      const body = await readBody(req);
      const chat = newChat();
      const prompt = (body.content || body.prompt || body.message || "").toString().trim();
      if (!prompt) return json(res, 200, { chat: summarize(chat) });
      try {
        const assistant = await sendMessage(chat, prompt, body.chatOptions);
        return json(res, 200, { chat: summarize(chat), reply: assistant.content, stats: assistant.stats, attempts: assistant.attempts });
      } catch (e) {
        return json(res, 502, {
          error: e.message,
          attempts: e.attempts || 1,
          chatId: chat.id,
          hint: `POST /api/chats/${chat.id}/retry to retry the first prompt`,
        });
      }
    }

    if (req.method === "GET") {
      const file = p === "/" ? "index.html" : p.replace(/^\/+/, "");
      const full = path.join(PUBLIC_DIR, path.normalize(file));
      if (full.startsWith(PUBLIC_DIR) && fs.existsSync(full) && fs.statSync(full).isFile()) {
        const ext = path.extname(full);
        res.writeHead(200, { "Content-Type": { ".html": "text/html", ".js": "text/javascript", ".css": "text/css" }[ext] || "application/octet-stream" });
        return fs.createReadStream(full).pipe(res);
      }
    }

    json(res, 404, { error: "not found" });
  } catch (e) {
    console.error(`${req.method} ${p} ->`, e.message);
    json(res, e.attempts ? 502 : 500, { error: e.message, attempts: e.attempts });
  }
});

server.listen(PORT, () => console.log(`chatjimmy-api on http://localhost:${PORT} (upstream ${UPSTREAM}, retries ${RETRIES})`));
