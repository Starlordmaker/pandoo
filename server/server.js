/**
 * stranger-video-chat — signaling + matchmaking server
 *
 * What it does:
 *  - Serves the web client from ../client
 *  - WebSocket endpoint /ws for signaling (SDP / ICE relay between peers)
 *  - Random 1-on-1 matchmaking with filters (gender, region, interests)
 *  - Text chat relay with rate limiting (spam protection)
 *  - Skip / Next / Report handling, presence (online count), heartbeats
 *
 * Run:  npm install && npm start   (or: node server/server.js)
 * Env:  PORT (default 3000)
 *       GOOGLE_CLIENT_ID (optional — enables Google login; get one at
 *       https://console.cloud.google.com/apis/credentials -> OAuth client ID.
 *       Add http://localhost:3000 as an authorized JavaScript origin.)
 *
 * NOTE: This is signaling only. Media goes peer-to-peer via WebRTC.
 * For users behind strict NATs, add a TURN server and point the client
 * at it (see client/app.js CONFIG.iceServers and README).
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');

const PORT = Number(process.env.PORT || 3000);
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const REPORT_LOG = path.join(__dirname, '..', 'reports.log');

// ---- tiny static file server ------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.json': 'application/json',
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/health') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, online: clients.size }));
  }
  if (urlPath === '/' ) urlPath = '/index.html';
  const file = path.normalize(path.join(CLIENT_DIR, urlPath));
  if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'content-type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(handleRequest);
const wss = new WebSocketServer({ server, path: '/ws' });

// ---- Google login (optional) ------------------------------------------------
let OAuth2Client = null;
try { OAuth2Client = require('google-auth-library').OAuth2Client; } catch (e) { /* google login disabled */ }
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID || '';
const FACEBOOK_APP_ID = process.env.FACEBOOK_APP_ID || '';
const FACEBOOK_APP_SECRET = process.env.FACEBOOK_APP_SECRET || '';
const sessions = new Map(); // sid -> { name, email, picture, sub, createdAt }

function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach(p => {
    const i = p.indexOf('=');
    if (i > 0) out[p.slice(0, i).trim()] = decodeURIComponent(p.slice(i + 1).trim());
  });
  return out;
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', c => { b += c; if (b.length > 1e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}
function json(res, code, obj, headers) {
  res.writeHead(code, Object.assign({ 'content-type': 'application/json' }, headers || {}));
  res.end(JSON.stringify(obj));
}

async function handleApi(req, res) {
  const urlPath = req.url.split('?')[0];
  if (urlPath === '/api/config' && req.method === 'GET') {
    json(res, 200, { googleClientId: GOOGLE_CLIENT_ID || null, facebookAppId: FACEBOOK_APP_ID || null });
    return true;
  }
  if (urlPath === '/api/auth/me' && req.method === 'GET') {
    const s = sessions.get(parseCookies(req).pandoo_sid);
    if (!s) { json(res, 401, { error: 'not logged in' }); return true; }
    json(res, 200, { name: s.name, email: s.email, picture: s.picture });
    return true;
  }
  if (urlPath === '/api/auth/logout' && req.method === 'POST') {
    sessions.delete(parseCookies(req).pandoo_sid);
    json(res, 200, { ok: true }, { 'set-cookie': 'pandoo_sid=; HttpOnly; Path=/; Max-Age=0; SameSite=Lax' });
    return true;
  }
  if (urlPath === '/api/auth/google' && req.method === 'POST') {
    if (!GOOGLE_CLIENT_ID || !OAuth2Client) { json(res, 501, { error: 'google login not configured' }); return true; }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { json(res, 400, { error: 'bad json' }); return true; }
    if (!body.credential) { json(res, 400, { error: 'missing credential' }); return true; }
    try {
      const ticket = await new OAuth2Client(GOOGLE_CLIENT_ID).verifyIdToken({ idToken: body.credential, audience: GOOGLE_CLIENT_ID });
      const p = ticket.getPayload();
      const sid = crypto.randomUUID();
      sessions.set(sid, { name: p.name, email: p.email, picture: p.picture, sub: p.sub, createdAt: Date.now() });
      if (sessions.size % 50 === 0) { const t = Date.now(); for (const [k, v] of sessions) if (t - v.createdAt > 30 * 864e5) sessions.delete(k); }
      json(res, 200, { name: p.name, email: p.email, picture: p.picture },
        { 'set-cookie': 'pandoo_sid=' + sid + '; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax' });
    } catch (e) {
      json(res, 401, { error: 'invalid google credential' });
    }
    return true;
  }
  if (urlPath === '/api/auth/facebook' && req.method === 'POST') {
    if (!FACEBOOK_APP_ID) { json(res, 501, { error: 'facebook login not configured' }); return true; }
    let body;
    try { body = JSON.parse(await readBody(req)); } catch (e) { json(res, 400, { error: 'bad json' }); return true; }
    if (!body.accessToken) { json(res, 400, { error: 'missing accessToken' }); return true; }
    try {
      const token = body.accessToken;
      // verify the token really belongs to our app (when app secret is set)
      if (FACEBOOK_APP_SECRET) {
        const dbg = await (await fetch('https://graph.facebook.com/debug_token?input_token='
          + encodeURIComponent(token) + '&access_token=' + encodeURIComponent(FACEBOOK_APP_ID + '|' + FACEBOOK_APP_SECRET))).json();
        if (!dbg.data || !dbg.data.is_valid || String(dbg.data.app_id) !== String(FACEBOOK_APP_ID)) throw 0;
      }
      const me = await (await fetch('https://graph.facebook.com/me?fields=id,name,picture.type(large)&access_token='
        + encodeURIComponent(token))).json();
      if (!me.id) throw 0;
      const pic = me.picture && me.picture.data && me.picture.data.url;
      const sid = crypto.randomUUID();
      sessions.set(sid, { name: me.name, email: '', picture: pic || '', sub: 'fb:' + me.id, createdAt: Date.now() });
      if (sessions.size % 50 === 0) { const t = Date.now(); for (const [k, v] of sessions) if (t - v.createdAt > 30 * 864e5) sessions.delete(k); }
      json(res, 200, { name: me.name, email: '', picture: pic || '' },
        { 'set-cookie': 'pandoo_sid=' + sid + '; HttpOnly; Path=/; Max-Age=2592000; SameSite=Lax' });
    } catch (e) {
      json(res, 401, { error: 'invalid facebook token' });
    }
    return true;
  }
  return false;
}

async function handleRequest(req, res) {
  try {
    if (await handleApi(req, res)) return;
  } catch (e) { json(res, 500, { error: 'server error' }); return; }
  serveStatic(req, res);
}

// ---- state ------------------------------------------------------------------
const clients = new Map();   // ws -> { id, profile, roomId, chatTimes:[], lastPartnerId, lastPartnerAt }
const waiting = [];          // [{ ws }]  matchmaking queue (FIFO)
const rooms = new Map();     // roomId -> { a: ws, b: ws, startedAt }

const now = () => Date.now();
const rid = () => crypto.randomUUID();
const onlineCount = () => clients.size;

function send(ws, msg) {
  if (ws.readyState === 1) ws.send(JSON.stringify(msg));
}

function broadcastStats() {
  const msg = JSON.stringify({ type: 'stats', online: onlineCount() });
  for (const ws of clients.keys()) if (ws.readyState === 1) ws.send(msg);
}
setInterval(broadcastStats, 10000);

// ---- profiles & matching ----------------------------------------------------
function cleanProfile(p) {
  p = (p && typeof p === 'object') ? p : {};
  const str = (v, d) => (typeof v === 'string' && v.trim() ? v.trim().slice(0, 40) : d);
  const gender = ['male', 'female', 'other'].includes(p.gender) ? p.gender : 'other';
  const lookingFor = ['any', 'male', 'female'].includes(p.lookingFor) ? p.lookingFor : 'any';
  const region = str(p.region, 'any').toLowerCase();
  const interests = Array.isArray(p.interests)
    ? [...new Set(p.interests.filter(i => typeof i === 'string').map(i => i.trim().toLowerCase()).filter(Boolean))].slice(0, 8)
    : [];
  return { gender, lookingFor, region, interests, lang: str(p.lang, 'en').slice(0, 8) };
}

function genderOk(a, b) {
  return (a.lookingFor === 'any' || a.lookingFor === b.gender) &&
         (b.lookingFor === 'any' || b.lookingFor === a.gender);
}

function compatible(a, b, aMeta, bMeta) {
  if (aMeta.id === bMeta.id) return false;
  // avoid instantly re-matching the same person right after a skip
  if (aMeta.lastPartnerId === bMeta.id && now() - aMeta.lastPartnerAt < 5 * 60 * 1000) return false;
  if (bMeta.lastPartnerId === aMeta.id && now() - bMeta.lastPartnerAt < 5 * 60 * 1000) return false;
  if (!genderOk(a, b)) return false;
  if (a.region !== 'any' && b.region !== 'any' && a.region !== b.region) return false;
  if (a.interests.length && b.interests.length &&
      !a.interests.some(i => b.interests.includes(i))) return false;
  return true;
}

function enqueue(ws) {
  if (!waiting.some(e => e.ws === ws)) waiting.push({ ws, at: now() });
  send(ws, { type: 'finding' });
  tryMatch();
}

function dequeue(ws) {
  const i = waiting.findIndex(e => e.ws === ws);
  if (i >= 0) waiting.splice(i, 1);
}

function tryMatch() {
  for (let i = 0; i < waiting.length; i++) {
    const A = waiting[i];
    const aMeta = clients.get(A.ws);
    if (!aMeta) { waiting.splice(i, 1); i--; continue; }
    for (let j = i + 1; j < waiting.length; j++) {
      const B = waiting[j];
      const bMeta = clients.get(B.ws);
      if (!bMeta) { waiting.splice(j, 1); j--; continue; }
      if (compatible(aMeta.profile, bMeta.profile, aMeta, bMeta)) {
        waiting.splice(j, 1);
        waiting.splice(i, 1);
        return pairUp(A.ws, B.ws);
      }
    }
  }
}

function publicProfile(meta) {
  return {
    gender: meta.profile.gender,
    region: meta.profile.region,
    interests: meta.profile.interests,
    lang: meta.profile.lang,
  };
}

function pairUp(wsA, wsB) {
  const roomId = rid();
  rooms.set(roomId, { a: wsA, b: wsB, startedAt: now() });
  const mA = clients.get(wsA), mB = clients.get(wsB);
  mA.roomId = roomId; mB.roomId = roomId;
  mA.lastPartnerId = mB.id; mA.lastPartnerAt = now();
  mB.lastPartnerId = mA.id; mB.lastPartnerAt = now();
  // initiator creates the WebRTC offer
  send(wsA, { type: 'matched', roomId, initiator: true, peer: publicProfile(mB), online: onlineCount() });
  send(wsB, { type: 'matched', roomId, initiator: false, peer: publicProfile(mA), online: onlineCount() });
  console.log(`[${new Date().toISOString()}] matched ${mA.id} <-> ${mB.id} (${roomId.slice(0, 8)})`);
}

function partnerOf(ws) {
  const meta = clients.get(ws);
  if (!meta || !meta.roomId) return null;
  const room = rooms.get(meta.roomId);
  if (!room) return null;
  return room.a === ws ? room.b : room.a;
}

function endRoom(ws, reason) {
  const meta = clients.get(ws);
  if (!meta || !meta.roomId) return;
  const roomId = meta.roomId;
  const room = rooms.get(roomId);
  rooms.delete(roomId);
  meta.roomId = null;
  if (!room) return;
  const other = room.a === ws ? room.b : room.a;
  const oMeta = clients.get(other);
  if (oMeta) {
    oMeta.roomId = null;
    send(other, { type: 'partner-left', reason: reason || 'left' });
  }
}

// ---- chat spam protection ----------------------------------------------------
const CHAT_WINDOW_MS = 5000;
const CHAT_MAX_PER_WINDOW = 6;
const CHAT_MAX_LEN = 500;

function chatAllowed(meta) {
  const t = now();
  meta.chatTimes = meta.chatTimes.filter(x => t - x < CHAT_WINDOW_MS);
  if (meta.chatTimes.length >= CHAT_MAX_PER_WINDOW) return false;
  meta.chatTimes.push(t);
  return true;
}

// ---- reports -----------------------------------------------------------------
function logReport(meta, reason, roomId) {
  const line = JSON.stringify({
    at: new Date().toISOString(),
    reporter: meta.id,
    reason: String(reason || 'unspecified').slice(0, 80),
    roomId,
    profile: publicProfile(meta),
  }) + '\n';
  fs.appendFile(REPORT_LOG, line, () => {});
  console.log('[report]', line.trim());
}

// ---- connection handling ------------------------------------------------------
wss.on('connection', (ws) => {
  const meta = {
    id: rid(),
    profile: cleanProfile({}),
    roomId: null,
    chatTimes: [],
    lastPartnerId: null,
    lastPartnerAt: 0,
    alive: true,
  };
  clients.set(ws, meta);
  send(ws, { type: 'hello', id: meta.id, online: onlineCount() });

  ws.on('pong', () => { meta.alive = true; });

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return send(ws, { type: 'error', message: 'bad json' }); }
    if (!msg || typeof msg.type !== 'string') return;

    switch (msg.type) {
      case 'join': {
        meta.profile = cleanProfile(msg.profile);
        endRoom(ws, 'rejoin');
        dequeue(ws);
        enqueue(ws);
        break;
      }
      case 'signal': {
        const other = partnerOf(ws);
        if (!other || msg.roomId !== meta.roomId) return send(ws, { type: 'error', message: 'no peer' });
        send(other, { type: 'signal', roomId: msg.roomId, data: msg.data });
        break;
      }
      case 'chat': {
        const other = partnerOf(ws);
        if (!other || msg.roomId !== meta.roomId) return send(ws, { type: 'error', message: 'no peer' });
        if (!chatAllowed(meta)) return send(ws, { type: 'error', message: 'slow down' });
        const text = String(msg.text || '').slice(0, CHAT_MAX_LEN).trim();
        if (!text) return;
        send(other, { type: 'chat', roomId: msg.roomId, text, at: now() });
        break;
      }
      case 'next': {
        // skip: both go back to finding (skipper first for snappier UX)
        const other = partnerOf(ws);
        const roomId = meta.roomId;
        endRoom(ws, 'skipped');
        if (other && clients.get(other)) enqueue(other);
        dequeue(ws);
        enqueue(ws);
        break;
      }
      case 'leave': {
        endRoom(ws, 'left');
        dequeue(ws);
        send(ws, { type: 'left' });
        break;
      }
      case 'report': {
        const other = partnerOf(ws);
        const roomId = meta.roomId;
        logReport(meta, msg.reason, roomId);
        endRoom(ws, 'reported');
        if (other && clients.get(other)) enqueue(other); // reporter can keep chatting with someone new
        dequeue(ws);
        send(ws, { type: 'reported' });
        break;
      }
      case 'ping':
        send(ws, { type: 'pong' });
        break;
      default:
        send(ws, { type: 'error', message: 'unknown type' });
    }
  });

  ws.on('close', () => {
    dequeue(ws);
    endRoom(ws, 'disconnected');
    clients.delete(ws);
  });

  ws.on('error', () => { /* ignore; close follows */ });
});

// heartbeat: drop dead sockets
setInterval(() => {
  for (const [ws, meta] of clients) {
    if (!meta.alive) { try { ws.terminate(); } catch {} continue; }
    meta.alive = false;
    try { ws.ping(); } catch {}
  }
}, 25000);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${PORT} is already in use. Stop the other server or set PORT env var.`);
    process.exit(1);
  }
  console.error('server error:', err);
});

server.listen(PORT, () => {
  console.log(`pandoo listening on http://localhost:${PORT}`);
});
