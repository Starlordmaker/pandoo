/* Pandoo client — random 1-on-1 video chat.
 * Signaling over WebSocket (/ws), media peer-to-peer via WebRTC.
 * Chat translation via MyMemory free API (graceful fallback to original text).
 */
'use strict';

/* ---------------- CONFIG ---------------- */
const CONFIG = {
  signalUrl: (location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '/ws',
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // For users behind strict NATs add your TURN server here, e.g.:
    // { urls: 'turn:your-turn-host:3478', username: 'user', credential: 'pass' },
  ],
  translateEndpoint: 'https://api.mymemory.translated.net/get',
};

const INTERESTS = ['Music','Gaming','Movies','Sports','Travel','Tech','Food','Art','Study','Fitness','Memes','Languages'];
const REGION_LABEL = { any:'🌍 Anywhere', india:'🇮🇳 India', us:'🇺🇸 USA', uk:'🇬🇧 UK', europe:'🇪🇺 Europe', apac:'🌏 Asia-Pacific', latam:'🌎 Latin America', mena:'🕌 Middle East', africa:'🌍 Africa' };
const GENDER_EMOJI = { male:'👨', female:'👩', other:'🧑' };

/* ---------------- state ---------------- */
let ws = null, pc = null, roomId = null, isInitiator = false;
let localStream = null, facingMode = 'user';
let pendingCandidates = [];
let filters = loadFilters();
let userLang = (navigator.language || 'en').slice(0, 2);
let translateOn = true;
let findingTimer = null;
let callTimerInt = null;

const $ = (id) => document.getElementById(id);
const screens = ['screen-home','screen-filters','screen-finding','screen-call','screen-ended'];
function show(id) {
  screens.forEach(s => $(s).classList.toggle('active', s === id));
}
function toast(msg, ms = 2200) {
  const t = $('toast');
  t.textContent = msg; t.classList.remove('hidden');
  clearTimeout(t._h); t._h = setTimeout(() => t.classList.add('hidden'), ms);
}

/* ---------------- filters ---------------- */
function loadFilters() {
  try {
    const f = JSON.parse(localStorage.getItem('pandoo-filters') || '{}');
    return { gender: f.gender || 'other', lookingFor: f.lookingFor || 'any', region: f.region || 'any', interests: f.interests || [] };
  } catch { return { gender: 'other', lookingFor: 'any', region: 'any', interests: [] }; }
}
function saveFilters() { localStorage.setItem('pandoo-filters', JSON.stringify(filters)); }
function segInit(id, key) {
  const el = $(id);
  el.querySelectorAll('button').forEach(b => {
    b.classList.toggle('on', b.dataset.v === filters[key]);
    b.onclick = () => { filters[key] = b.dataset.v; el.querySelectorAll('button').forEach(x => x.classList.toggle('on', x === b)); refreshSummary(); };
  });
}
function chipsInit() {
  const box = $('chips-interests'); box.innerHTML = '';
  INTERESTS.forEach(name => {
    const b = document.createElement('button');
    b.textContent = name;
    const key = name.toLowerCase();
    if (filters.interests.includes(key)) b.classList.add('on');
    b.onclick = () => {
      const i = filters.interests.indexOf(key);
      if (i >= 0) { filters.interests.splice(i, 1); b.classList.remove('on'); }
      else if (filters.interests.length < 8) { filters.interests.push(key); b.classList.add('on'); }
      refreshSummary();
    };
    box.appendChild(b);
  });
}
function refreshSummary() {
  const g = filters.lookingFor === 'any' ? 'Anyone' : filters.lookingFor[0].toUpperCase() + filters.lookingFor.slice(1);
  const fs = $('filters-summary'); if (fs) fs.textContent = g;
}
function filtersInit() {
  segInit('seg-gender', 'gender');
  segInit('seg-looking', 'lookingFor');
  $('sel-region').value = filters.region;
  $('sel-region').onchange = (e) => { filters.region = e.target.value; refreshSummary(); };
  chipsInit(); refreshSummary();
  $('btn-filters-back').onclick = () => { saveFilters(); goHome(); };
  $('btn-filters-save').onclick = () => { saveFilters(); startFlow(); };
}

/* ---------------- media ---------------- */
async function ensureMedia() {
  if (localStream) {
    const vt = localStream.getVideoTracks()[0];
    if (vt && vt.getSettings().facingMode !== facingMode) { /* will be replaced on flip */ }
    else return localStream;
  }
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode, width: { ideal: 720 }, height: { ideal: 1280 } },
    audio: { echoCancellation: true, noiseSuppression: true },
  });
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  localStream = stream;
  $('local-video').srcObject = stream;
  const fp = $('finding-preview'); if (fp) fp.srcObject = stream;
  return stream;
}
async function flipCamera() {
  facingMode = facingMode === 'user' ? 'environment' : 'user';
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode, width: { ideal: 720 }, height: { ideal: 1280 } },
      audio: false,
    });
    const newTrack = stream.getVideoTracks()[0];
    const sender = pc && pc.getSenders().find(s => s.track && s.track.kind === 'video');
    if (sender) await sender.replaceTrack(newTrack);
    const oldTrack = localStream.getVideoTracks()[0];
    if (oldTrack) { localStream.removeTrack(oldTrack); oldTrack.stop(); }
    localStream.addTrack(newTrack);
    $('local-video').srcObject = localStream;
    toast(facingMode === 'user' ? '🤳 Front camera' : '📷 Back camera');
  } catch { toast('Could not switch camera'); facingMode = facingMode === 'user' ? 'environment' : 'user'; }
}
function stopMedia() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  $('local-video').srcObject = null; $('remote-video').srcObject = null;
  const hp = $('hero-preview'); if (hp) hp.srcObject = null;
}
function goHome() {
  show('screen-home');
  initHeroCamera(); /* re-attach live camera (fixes blank preview after cancel/end) */
}

/* ---------------- websocket ---------------- */
function connect() {
  return new Promise((resolve, reject) => {
    if (ws && ws.readyState === WebSocket.OPEN) return resolve();
    ws = new WebSocket(CONFIG.signalUrl);
    const to = setTimeout(() => { try { ws.close(); } catch {} reject(new Error('timeout')); }, 8000);
    ws.onopen = () => { clearTimeout(to); resolve(); };
    ws.onerror = () => { clearTimeout(to); reject(new Error('connect failed')); };
    ws.onclose = onWsClose;
    ws.onmessage = onWsMessage;
  });
}
function sendMsg(m) { if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m)); }
setInterval(() => sendMsg({ type: 'ping' }), 20000);

function onWsClose() {
  const inSession = $('screen-call').classList.contains('active') || $('screen-finding').classList.contains('active');
  cleanupCall();
  if (inSession) endScreen('Connection lost', 'Trying to reconnect… tap below to retry.');
}

async function onWsMessage(ev) {
  let msg; try { msg = JSON.parse(ev.data); } catch { return; }
  switch (msg.type) {
    case 'hello':
    case 'stats':
      document.querySelectorAll('.online-count').forEach(el => el.textContent = msg.online ?? 0);
      break;
    case 'finding':
      showFinding();
      break;
    case 'matched':
      roomId = msg.roomId; isInitiator = msg.initiator;
      showCall(msg.peer);
      await startPeerConnection();
      break;
    case 'signal':
      await handleSignal(msg.data);
      break;
    case 'chat':
      addChatMessage(msg.text, 'peer');
      break;
    case 'partner-left':
      handlePartnerLeft(msg.reason);
      break;
    case 'reported':
      toast('🚩 Reported. Finding someone new…');
      break;
    case 'left':
      break;
    case 'error':
      if (msg.message === 'slow down') toast('Slow down a little ✋');
      break;
  }
}

/* ---------------- flow ---------------- */
async function startFlow() {
  try { await ensureMedia(); }
  catch { toast('📷 Camera/mic permission needed'); return; }
  try { await connect(); }
  catch { toast('Could not reach server. Try again.'); return; }
  sendMsg({ type: 'join', profile: Object.assign({ ...filters, lang: userLang }, authProfileExtra()) });
  showFinding();
}
function showFinding() {
  clearTimeout(findingTimer);
  show('screen-finding');
  const hints = ['Matching your filters', 'Say hi when connected 👋', 'Be kind, no spam 🚫'];
  let i = 0;
  $('finding-hint').textContent = hints[0];
  findingTimer = setInterval(() => { i = (i + 1) % hints.length; $('finding-hint').textContent = hints[i]; }, 3500);
}
function cancelFind() {
  clearInterval(findingTimer);
  sendMsg({ type: 'leave' });
  cleanupCall();
  goHome();
}
function endScreen(title, sub) {
  clearInterval(findingTimer);
  $('ended-title').textContent = title;
  $('ended-sub').textContent = sub;
  show('screen-ended');
}
function handlePartnerLeft(reason) {
  cleanupCall();
  if (reason === 'skipped') { showFinding(); return; } // server already re-queued us
  const msgs = { left: 'The stranger left the chat.', disconnected: 'Stranger disconnected.', reported: 'Chat ended.' };
  endScreen('Chat ended', msgs[reason] || 'The stranger left the chat.');
}

/* ---------------- webrtc ---------------- */
async function startPeerConnection() {
  closePeerConnection();
  pc = new RTCPeerConnection({ iceServers: CONFIG.iceServers });
  localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
  pc.onicecandidate = (e) => { if (e.candidate) sendMsg({ type: 'signal', roomId, data: { candidate: e.candidate } }); };
  pc.ontrack = (e) => {
    $('remote-video').srcObject = e.streams[0];
    $('remote-placeholder').style.display = 'none';
  };
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') { toast('Connection failed — trying next…'); doNext(); }
  };
  if (isInitiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    sendMsg({ type: 'signal', roomId, data: { sdp: pc.localDescription } });
  }
}
async function handleSignal(data) {
  if (!pc || !data) return;
  try {
    if (data.sdp) {
      await pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
      for (const c of pendingCandidates) await pc.addIceCandidate(new RTCIceCandidate(c));
      pendingCandidates = [];
      if (data.sdp.type === 'offer') {
        const ans = await pc.createAnswer();
        await pc.setLocalDescription(ans);
        sendMsg({ type: 'signal', roomId, data: { sdp: pc.localDescription } });
      }
    } else if (data.candidate) {
      if (pc.remoteDescription) await pc.addIceCandidate(new RTCIceCandidate(data.candidate));
      else pendingCandidates.push(data.candidate);
    }
  } catch (e) { console.warn('signal error', e); }
}
function closePeerConnection() {
  if (pc) { try { pc.close(); } catch {} pc = null; }
  pendingCandidates = [];
  $('remote-video').srcObject = null;
  $('remote-placeholder').style.display = 'flex';
}
function cleanupCall() {
  closePeerConnection();
  roomId = null;
  clearInterval(callTimerInt);
  $('chat-msgs').innerHTML = '';
  $('chat-overlay').innerHTML = '';
  $('chat-sheet').classList.add('hidden');
}

/* ---------------- call screen ---------------- */
function showCall(peer) {
  show('screen-call');
  const chips = [];
  if (peer.gender) chips.push(`${GENDER_EMOJI[peer.gender] || '🧑'} ${peer.gender}`);
  if (peer.region && peer.region !== 'any') chips.push(REGION_LABEL[peer.region] || peer.region);
  (peer.interests || []).slice(0, 3).forEach(i => chips.push('🏷️ ' + i));
  $('peer-chips').innerHTML = chips.map(c => `<span class="chip">${c}</span>`).join('');
  $('chat-sheet').classList.add('hidden');
  $('btn-chat').classList.remove('off');
  // hay-style call timer
  const t0 = Date.now();
  clearInterval(callTimerInt);
  const tick = () => {
    const s = Math.floor((Date.now() - t0) / 1000);
    $('call-timer').textContent = String(Math.floor(s / 60)).padStart(2, '0') + ':' + String(s % 60).padStart(2, '0');
  };
  tick();
  callTimerInt = setInterval(tick, 1000);
}
function doNext() {
  if (!roomId && !$('screen-call').classList.contains('active')) return;
  cleanupCall();
  sendMsg({ type: 'next' });
  showFinding();
}
function doEnd() {
  sendMsg({ type: 'leave' });
  cleanupCall(); stopMedia();
  endScreen('You ended the chat', 'Tap below to meet someone new.');
}

/* ---------------- chat + translation ---------------- */
/* Hay-style: message goes to the history sheet AND a floating bubble over video.
 * Peer messages show live translation under the original (tap bubble to swap). */
function addChatMessage(text, who) {
  const box = $('chat-msgs');
  const div = document.createElement('div');
  div.className = 'msg ' + who;

  const renderOverlay = (main, sub) => {
    const ov = $('chat-overlay');
    const b = document.createElement('div');
    b.className = 'bubble ' + who;
    b.textContent = main;
    if (sub) {
      const s = document.createElement('div');
      s.style.cssText = 'font-size:11px;opacity:.75;margin-top:3px;font-weight:700';
      s.textContent = sub;
      b.appendChild(s);
    }
    ov.appendChild(b);
    while (ov.children.length > 3) ov.removeChild(ov.firstChild);
    setTimeout(() => { if (b.parentNode) b.parentNode.removeChild(b); }, 8000);
  };

  if (who === 'peer' && translateOn) {
    div.textContent = text;
    renderOverlay(text);
    translateText(text).then(t => {
      if (t && t !== text) {
        div.innerHTML = '';
        div.appendChild(document.createTextNode(t));
        const tr = document.createElement('div');
        tr.className = 'tr';
        tr.textContent = text;
        div.appendChild(tr);
        const tag = document.createElement('span');
        tag.className = 'tr-tag';
        tag.textContent = '🔤 auto-translated';
        div.appendChild(tag);
        renderOverlay(t, text);
      }
    });
  } else {
    div.textContent = text;
    renderOverlay(text);
  }
  box.appendChild(div);
  box.scrollTop = box.scrollHeight;
}
async function translateText(text) {
  try {
    const url = `${CONFIG.translateEndpoint}?q=${encodeURIComponent(text)}&langpair=auto|${encodeURIComponent(userLang)}`;
    const r = await fetch(url);
    const j = await r.json();
    const t = j && j.responseData && j.responseData.translatedText;
    if (t && t.trim() && !/MYMEMORY WARNING/i.test(t)) return t.trim();
  } catch {}
  return text;
}
function sendChat() {
  const inp = $('msg-input');
  const text = inp.value.trim();
  if (!text || !roomId) return;
  sendMsg({ type: 'chat', roomId, text });
  addChatMessage(text, 'me');
  inp.value = '';
}

/* ---------------- report ---------------- */
function openReport() { $('report-modal').classList.remove('hidden'); }
function closeReport() { $('report-modal').classList.add('hidden'); }
function submitReport(reason) {
  sendMsg({ type: 'report', roomId, reason });
  closeReport();
  cleanupCall();
  showFinding();
  sendMsg({ type: 'join', profile: Object.assign({ ...filters, lang: userLang }, authProfileExtra()) });
}

/* ---------------- google login ---------------- */
let googleUser = null;
let authUser = null; // { name, email, picture, provider }
function authProfileExtra() {
  return googleUser ? { name: googleUser.name, avatar: googleUser.picture } : {};
}
async function initHeroCamera() {
  const v = $('hero-preview');
  if (!v) return;
  try {
    const stream = await ensureMedia();
    v.srcObject = stream;
  } catch (e) {
    v.style.display = 'none';
    const off = document.querySelector('.ap-camera-off');
    if (off) off.classList.remove('hidden');
  }
}
function initLoginModal() {
  const m = $('login-modal');
  if (!m) return;
  const open = () => m.classList.remove('hidden');
  const close = () => m.classList.add('hidden');
  const b = $('btn-login'); if (b) b.onclick = open;
  const c = $('btn-login-close'); if (c) c.onclick = close;
  m.addEventListener('click', e => { if (e.target === m) close(); });
}
async function initGoogleLogin() {
  let cfg = {};
  try { cfg = await (await fetch('/api/config')).json(); } catch (e) {}
  try {
    const r = await fetch('/api/auth/me');
    if (r.ok) { authUser = await r.json(); renderAuthUser(); }
  } catch (e) {}
  const wrap = $('google-btn-wrap'), hint = $('login-hint');
  if (!cfg.googleClientId) {
    if (wrap) wrap.style.display = 'none';
    updateLoginHint();
    return;
  }
  if (hint) hint.style.display = 'none';
  let tries = 0;
  const tick = () => {
    if (window.google && window.google.accounts) {
      try {
        google.accounts.id.initialize({ client_id: cfg.googleClientId, callback: onGoogleCredential, auto_select: false });
        google.accounts.id.renderButton(wrap, { theme: 'outline', size: 'large', width: 260, text: 'continue_with' });
      } catch (e) { if (hint) { hint.textContent = 'Google login unavailable'; hint.style.display = 'block'; } }
    } else if (++tries < 20) setTimeout(tick, 300);
    else if (hint) { hint.textContent = 'Google login unavailable'; hint.style.display = 'block'; }
  };
  tick();
}
async function onGoogleCredential(resp) {
  try {
    const r = await fetch('/api/auth/google', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ credential: resp.credential }) });
    if (!r.ok) throw 0;
    authUser = Object.assign(await r.json(), { provider: 'google' });
    renderAuthUser();
    const m = $('login-modal'); if (m) m.classList.add('hidden');
    toast('👋 Welcome, ' + (authUser.name || 'friend') + '!');
  } catch (e) { toast('Google login failed. Try again.'); }
}
function renderAuthUser() {
  const wrap = $('google-btn-wrap'), chip = $('user-chip'), btn = $('btn-login');
  if (authUser) {
    if (wrap) wrap.style.display = 'none';
    const fb = $('fb-login-btn'); if (fb) fb.style.display = 'none';
    if (btn) btn.style.display = 'none';
    chip.style.display = 'flex';
    $('user-avatar').src = authUser.picture || '';
    $('user-name').textContent = authUser.name || 'Friend';
  } else {
    if (wrap) wrap.style.display = 'flex';
    if (btn) btn.style.display = '';
    chip.style.display = 'none';
    initFacebookLogin();
  }
}
/* ---------------- facebook login ---------------- */
let fbAppId = null, fbSdkLoading = false;
function initFacebookLogin() {
  const btn = $('fb-login-btn');
  if (!btn) return;
  fetch('/api/config').then(r => r.json()).then(cfg => {
    fbAppId = cfg.facebookAppId || null;
    if (!fbAppId) { btn.style.display = 'none'; updateLoginHint(); return; }
    if (authUser) { btn.style.display = 'none'; return; }
    btn.style.display = '';
    updateLoginHint();
    if (window.FB) return;
    if (fbSdkLoading) return;
    fbSdkLoading = true;
    const sc = document.createElement('script');
    sc.src = 'https://connect.facebook.net/en_US/sdk.js';
    sc.async = true; sc.defer = true; sc.crossOrigin = 'anonymous';
    sc.onload = () => { try { FB.init({ appId: fbAppId, cookie: false, xfbml: false, version: 'v21.0' }); } catch (e) {} };
    document.head.appendChild(sc);
  }).catch(() => {});
  btn.onclick = onFacebookClick;
}
function updateLoginHint() {
  const hint = $('login-hint');
  if (!hint) return;
  fetch('/api/config').then(r => r.json()).then(cfg => {
    if (!cfg.googleClientId && !cfg.facebookAppId) {
      hint.textContent = '🔑 Logins coming soon';
      hint.style.display = 'block';
    } else hint.style.display = 'none';
  }).catch(() => {});
}
function onFacebookClick() {
  if (!window.FB || !fbAppId) { toast('Facebook login unavailable'); return; }
  try { FB.init({ appId: fbAppId, cookie: false, xfbml: false, version: 'v21.0' }); } catch (e) {}
  FB.login(async resp => {
    if (!resp || !resp.authResponse || !resp.authResponse.accessToken) return;
    try {
      const r = await fetch('/api/auth/facebook', { method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: resp.authResponse.accessToken }) });
      if (!r.ok) throw 0;
      authUser = Object.assign(await r.json(), { provider: 'facebook' });
      renderAuthUser();
      const m = $('login-modal'); if (m) m.classList.add('hidden');
      toast('👋 Welcome, ' + (authUser.name || 'friend') + '!');
    } catch (e) { toast('Facebook login failed. Try again.'); }
  }, { scope: 'public_profile' });
}
async function authLogout() {
  try { await fetch('/api/auth/logout', { method: 'POST' }); } catch (e) {}
  try { google.accounts.id.disableAutoSelect(); } catch (e) {}
  try { if (window.FB) FB.logout(); } catch (e) {}
  authUser = null;
  renderAuthUser();
}

/* ---------------- wire up ---------------- */
function init() {
  initHeroCamera();
  initLoginModal();
  filtersInit();
  $('btn-start').onclick = startFlow;
  $('btn-start2').onclick = startFlow;
  $('tab-squad').onclick = () => toast('Squad mode coming soon!');
  $('tab-solo').onclick = () => { $('tab-solo').classList.add('on'); $('tab-squad').classList.remove('on'); };
  $('tab-squad').addEventListener('click', () => { $('tab-squad').classList.add('on'); $('tab-solo').classList.remove('on'); });
  $('btn-filters').onclick = () => show('screen-filters');
  const bf2 = $('btn-filters2'); if (bf2) bf2.onclick = () => show('screen-filters');
  $('btn-cancel-find').onclick = cancelFind;
  $('btn-next').onclick = doNext;
  $('btn-end').onclick = doEnd;
  $('btn-end-top').onclick = doEnd;
  $('btn-flip').onclick = flipCamera;
  $('btn-mic').onclick = (e) => {
    const btn = e.currentTarget;
    const track = localStream && localStream.getAudioTracks()[0];
    if (!track) return;
    track.enabled = !track.enabled;
    btn.classList.toggle('off', !track.enabled);
    btn.innerHTML = track.enabled ? '🎙<small>Mute</small>' : '🔇<small>Unmute</small>';
  };
  $('btn-chat').onclick = (e) => {
    const p = $('chat-sheet');
    p.classList.toggle('hidden');
    e.currentTarget.classList.toggle('off', !p.classList.contains('hidden'));
  };
  $('btn-chat-close').onclick = () => $('chat-sheet').classList.add('hidden');
  $('btn-msg-send').onclick = sendChat;
  $('msg-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  $('chk-translate').onchange = (e) => { translateOn = e.target.checked; };
  $('btn-report').onclick = openReport;
  $('btn-report-cancel').onclick = closeReport;
  document.querySelectorAll('.report-reasons button').forEach(b => b.onclick = () => submitReport(b.dataset.r));
  $('btn-find-new').onclick = startFlow;
  $('btn-logout').onclick = authLogout;
  initGoogleLogin();
  initFacebookLogin();
  $('btn-home').onclick = () => { stopMedia(); goHome(); };
  // scroll-reveal animations
  try {
    const io = new IntersectionObserver(es => es.forEach(e => { if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); } }), { threshold: .15 });
    document.querySelectorAll('.reveal').forEach(el => io.observe(el));
  } catch (e) {}
  // idle online-count fetch (before first socket opens)
  fetch('/health').then(r => r.json()).then(j => { document.querySelectorAll('.online-count').forEach(el => el.textContent = j.online ?? 0); }).catch(() => {});
}
document.addEventListener('DOMContentLoaded', init);
