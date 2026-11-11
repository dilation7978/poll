'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const QRCode = require('qrcode');

const PORT = Number(process.env.PORT) || 3000;
const ADMIN_KEY = process.env.ADMIN_KEY || 'changeme';
const PUBLIC_URL = (process.env.PUBLIC_URL || '').trim().replace(/\/+$/, '');
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'polls.json');
const PUBLIC_DIR = path.join(__dirname, 'public');

const MAX_TEXT_LEN = 100;
const MAX_TEXTS_PER_VOTER = 3;
const MAX_OPTIONS = 10;

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- storage ----------
// Everything lives in memory and is mirrored to a single JSON file.

let db = { polls: [], activeId: null, responses: {} };

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    db = {
      polls: parsed.polls || [],
      activeId: parsed.activeId || null,
      responses: parsed.responses || {},
    };
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Could not read data file:', err.message);
  }
}

function writeNow() {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const tmp = DATA_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db));
    fs.renameSync(tmp, DATA_FILE);
  } catch (err) {
    console.error('Could not save data:', err.message);
  }
}

let saveTimer = null;
function save() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeNow();
  }, 250);
}

function flush() {
  if (!saveTimer) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  writeNow();
}

function getPoll(id) {
  return db.polls.find((p) => p.id === id);
}

function bucket(id) {
  return db.responses[id] || (db.responses[id] = { votes: {}, texts: [] });
}

function publicPoll(p) {
  return p ? { id: p.id, question: p.question, type: p.type, options: p.options } : null;
}

function results(p) {
  const b = bucket(p.id);
  if (p.type === 'choice') {
    const counts = p.options.map(() => 0);
    for (const v of Object.values(b.votes)) if (counts[v] !== undefined) counts[v]++;
    return { type: 'choice', counts, total: Object.keys(b.votes).length };
  }
  // Group identical answers (ignoring case/spacing) so popular ones grow in the cloud.
  const groups = new Map();
  for (const t of b.texts) {
    const key = t.value.toLowerCase();
    const g = groups.get(key);
    if (g) g.count++;
    else groups.set(key, { text: t.value, count: 1 });
  }
  const words = [...groups.values()].sort((a, b) => b.count - a.count).slice(0, 60);
  return { type: 'text', words, total: b.texts.length };
}

function responseCount(p) {
  const b = db.responses[p.id];
  if (!b) return 0;
  return p.type === 'choice' ? Object.keys(b.votes).length : b.texts.length;
}

// ---------- live updates (Server-Sent Events) ----------

const audience = new Set();
const displays = new Map(); // pollId -> Set<res>

function openStream(res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no', // stops Synology's nginx reverse proxy from buffering
  });
  res.write('retry: 2000\n\n');
}

function emit(res, event, data) {
  res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
}

setInterval(() => {
  for (const res of audience) res.write(': ping\n\n');
  for (const set of displays.values()) for (const res of set) res.write(': ping\n\n');
}, 20000);

function broadcastActive() {
  const poll = publicPoll(getPoll(db.activeId));
  for (const res of audience) emit(res, 'active', poll);
  for (const [id, set] of displays) {
    for (const res of set) emit(res, 'status', { active: db.activeId === id });
  }
}

function broadcastPoll(id) {
  const p = getPoll(id);
  const set = displays.get(id);
  if (set) {
    for (const res of set) {
      emit(res, 'poll', publicPoll(p));
      if (p) emit(res, 'results', results(p));
    }
  }
  if (p && db.activeId === id) for (const res of audience) emit(res, 'active', publicPoll(p));
}

// Votes can arrive in bursts; push results to the screen at most ~5 times a second.
const pendingResults = new Map();
function broadcastResults(id) {
  if (pendingResults.has(id)) return;
  pendingResults.set(id, setTimeout(() => {
    pendingResults.delete(id);
    const set = displays.get(id);
    const p = getPoll(id);
    if (!set || !p) return;
    const r = results(p);
    for (const res of set) emit(res, 'results', r);
  }, 200));
}

// ---------- helpers ----------

function send(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

function sendPage(res, name) {
  fs.readFile(path.join(PUBLIC_DIR, name), (err, buf) => {
    if (err) return send(res, 404, { error: 'Not found' });
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > 20000) {
        reject(new HttpError(413, 'Request too large'));
        req.destroy();
      } else {
        chunks.push(c);
      }
    });
    req.on('end', () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
      } catch {
        reject(new HttpError(400, 'Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

function isAdmin(req, url) {
  const given = String(req.headers['x-admin-key'] || url.searchParams.get('key') || '');
  const a = crypto.createHash('sha256').update(given).digest();
  const b = crypto.createHash('sha256').update(ADMIN_KEY).digest();
  return crypto.timingSafeEqual(a, b);
}

function joinUrl(req) {
  if (PUBLIC_URL) return PUBLIC_URL + '/';
  const proto = String(req.headers['x-forwarded-proto'] || 'http').split(',')[0].trim();
  const host = String(req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`).split(',')[0].trim();
  return `${proto}://${host}/`;
}

const qrCache = new Map();
async function qrSvg(text) {
  if (!qrCache.has(text)) {
    if (qrCache.size > 20) qrCache.clear();
    qrCache.set(text, await QRCode.toString(text, { type: 'svg', margin: 1, errorCorrectionLevel: 'M' }));
  }
  return qrCache.get(text);
}

function parsePollInput(body) {
  const question = String(body.question || '').trim().slice(0, 300);
  const type = body.type === 'text' ? 'text' : 'choice';
  let options = [];
  if (!question) throw new HttpError(400, 'Please enter a question');
  if (type === 'choice') {
    options = (Array.isArray(body.options) ? body.options : [])
      .map((o) => String(o).trim().slice(0, 120))
      .filter(Boolean)
      .slice(0, MAX_OPTIONS);
    if (options.length < 2) throw new HttpError(400, 'Add at least two options');
  }
  return { question, type, options };
}

// ---------- handlers ----------

async function vote(req, res) {
  const body = await readBody(req);
  const voter = String(body.voter || '');
  const p = getPoll(String(body.pollId || ''));
  if (!/^[\w-]{8,64}$/.test(voter)) throw new HttpError(400, 'Missing voter id');
  if (!p || db.activeId !== p.id) throw new HttpError(409, 'This question is closed');
  const b = bucket(p.id);

  if (p.type === 'choice') {
    const idx = Number(body.value);
    if (!Number.isInteger(idx) || idx < 0 || idx >= p.options.length) throw new HttpError(400, 'Invalid option');
    b.votes[voter] = idx; // one vote per phone; voting again changes it
    save();
    broadcastResults(p.id);
    return send(res, 200, { ok: true });
  }

  const value = String(body.value || '').replace(/\s+/g, ' ').trim().slice(0, MAX_TEXT_LEN);
  if (!value) throw new HttpError(400, 'Please type a response');
  const mine = b.texts.filter((t) => t.voter === voter).length;
  if (mine >= MAX_TEXTS_PER_VOTER) throw new HttpError(429, `You can send up to ${MAX_TEXTS_PER_VOTER} responses`);
  b.texts.push({ voter, value, at: Date.now() });
  save();
  broadcastResults(p.id);
  send(res, 200, { ok: true, remaining: MAX_TEXTS_PER_VOTER - mine - 1 });
}

async function admin(req, res, method, sub) {
  if (method === 'GET' && sub === '/polls') {
    return send(res, 200, {
      joinUrl: joinUrl(req),
      activeId: db.activeId,
      polls: db.polls.map((p) => ({ ...publicPoll(p), responses: responseCount(p), active: db.activeId === p.id })),
    });
  }

  if (method === 'POST' && sub === '/polls') {
    const poll = { id: crypto.randomBytes(4).toString('hex'), ...parsePollInput(await readBody(req)), createdAt: Date.now() };
    db.polls.push(poll);
    save();
    return send(res, 200, { poll: publicPoll(poll) });
  }

  if (method === 'POST' && sub === '/deactivate') {
    db.activeId = null;
    save();
    broadcastActive();
    return send(res, 200, { ok: true });
  }

  const m = sub.match(/^\/polls\/([\w-]+)(\/activate|\/reset)?$/);
  const p = m && getPoll(m[1]);
  if (!p) throw new HttpError(404, 'Poll not found');
  const action = m[2];

  if (method === 'PUT' && !action) {
    const input = parsePollInput(await readBody(req));
    if (input.type !== p.type) delete db.responses[p.id];
    Object.assign(p, input);
    save();
    broadcastPoll(p.id);
    return send(res, 200, { poll: publicPoll(p) });
  }

  if (method === 'DELETE' && !action) {
    db.polls = db.polls.filter((x) => x.id !== p.id);
    delete db.responses[p.id];
    broadcastPoll(p.id);
    if (db.activeId === p.id) {
      db.activeId = null;
      broadcastActive();
    }
    save();
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && action === '/activate') {
    if (db.activeId !== p.id) {
      db.activeId = p.id;
      save();
      broadcastActive();
    }
    return send(res, 200, { ok: true });
  }

  if (method === 'POST' && action === '/reset') {
    delete db.responses[p.id];
    save();
    broadcastPoll(p.id);
    for (const r of audience) emit(r, 'reset', p.id);
    return send(res, 200, { ok: true });
  }

  throw new HttpError(404, 'Not found');
}

async function route(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;
  let m;

  if (method === 'GET' && (p === '/' || p === '/vote')) return sendPage(res, 'vote.html');
  if (method === 'GET' && p === '/admin') return sendPage(res, 'admin.html');
  if (method === 'GET' && /^\/display\/[\w-]+\/?$/.test(p)) return sendPage(res, 'display.html');
  if (method === 'GET' && p === '/healthz') return send(res, 200, { ok: true });

  if (method === 'GET' && p === '/api/info') return send(res, 200, { joinUrl: joinUrl(req) });

  if (method === 'GET' && p === '/api/qr.svg') {
    const svg = await qrSvg(joinUrl(req));
    res.writeHead(200, { 'Content-Type': 'image/svg+xml', 'Cache-Control': 'no-cache' });
    return res.end(svg);
  }

  if (method === 'GET' && p === '/api/events') {
    openStream(res);
    emit(res, 'active', publicPoll(getPoll(db.activeId)));
    audience.add(res);
    req.on('close', () => audience.delete(res));
    return;
  }

  if (method === 'POST' && p === '/api/vote') return vote(req, res);

  if (method === 'GET' && (m = p.match(/^\/api\/polls\/([\w-]+)\/stream$/))) {
    const poll = getPoll(m[1]);
    if (!poll) return send(res, 404, { error: 'Poll not found' });
    openStream(res);
    emit(res, 'poll', publicPoll(poll));
    emit(res, 'status', { active: db.activeId === poll.id });
    emit(res, 'results', results(poll));
    if (!displays.has(poll.id)) displays.set(poll.id, new Set());
    displays.get(poll.id).add(res);
    req.on('close', () => {
      const set = displays.get(poll.id);
      if (!set) return;
      set.delete(res);
      if (!set.size) displays.delete(poll.id);
    });
    return;
  }

  if (p.startsWith('/api/admin/')) {
    if (!isAdmin(req, url)) return send(res, 401, { error: 'Wrong admin key' });
    return admin(req, res, method, p.slice('/api/admin'.length));
  }

  send(res, 404, { error: 'Not found' });
}

// ---------- start ----------

load();

const server = http.createServer(async (req, res) => {
  try {
    await route(req, res);
  } catch (err) {
    if (!(err instanceof HttpError)) console.error(err);
    if (!res.headersSent) send(res, err.status || 500, { error: err instanceof HttpError ? err.message : 'Server error' });
  }
});

server.listen(PORT, () => {
  console.log(`Live poll running on port ${PORT}`);
  if (ADMIN_KEY === 'changeme') console.warn('WARNING: ADMIN_KEY is not set - using "changeme". Set it before using this for real.');
});

for (const sig of ['SIGTERM', 'SIGINT']) {
  process.on(sig, () => {
    flush();
    process.exit(0);
  });
}
