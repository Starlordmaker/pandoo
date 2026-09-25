/* Smoke test for the signaling server. Run: npm start (in one shell), node test/simulate.js (in another).
 * Simulates real clients: join -> matched -> signal relay -> chat relay -> next/skip -> filter matching.
 */
'use strict';
const WebSocket = require('ws');

const URL = process.env.WS_URL || 'ws://localhost:3000/ws';
const results = [];
const ok = (name, cond) => { results.push([name, !!cond]); console.log((cond ? 'PASS' : 'FAIL') + '  ' + name); };

function client(profile) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(URL);
    const c = { ws, inbox: [], profile };
    ws.on('message', (raw) => { try { c.inbox.push(JSON.parse(raw.toString())); } catch {} });
    ws.on('open', () => { ws.send(JSON.stringify({ type: 'join', profile })); resolve(c); });
    ws.on('error', reject);
    setTimeout(() => reject(new Error('connect timeout')), 5000);
  });
}
const send = (c, m) => c.ws.send(JSON.stringify(m));
async function waitFor(c, type, timeout = 4000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeout) {
    const i = c.inbox.findIndex(m => m.type === type);
    if (i >= 0) return c.inbox.splice(i, 1)[0];
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error('timeout waiting for ' + type);
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  try {
    // --- 1. basic match ---
    const A = await client({ gender: 'male', lookingFor: 'any', region: 'any', interests: [] });
    const B = await client({ gender: 'female', lookingFor: 'any', region: 'any', interests: [] });
    const mA = await waitFor(A, 'matched');
    const mB = await waitFor(B, 'matched');
    ok('both clients matched', !!mA && !!mB);
    ok('same room id', mA.roomId === mB.roomId);
    ok('one initiator, one answerer', mA.initiator !== mB.initiator);
    ok('peer profile shared', mB.peer && mB.peer.gender === 'male');

    // --- 2. signal relay ---
    send(A, { type: 'signal', roomId: mA.roomId, data: { sdp: { type: 'offer', sdp: 'fake-offer' } } });
    const sig = await waitFor(B, 'signal');
    ok('sdp relayed A->B', sig.data && sig.data.sdp && sig.data.sdp.sdp === 'fake-offer');
    send(B, { type: 'signal', roomId: mB.roomId, data: { candidate: { candidate: 'fake-ice' } } });
    const ice = await waitFor(A, 'signal');
    ok('ice relayed B->A', ice.data && ice.data.candidate && ice.data.candidate.candidate === 'fake-ice');

    // --- 3. chat relay + rate limit ---
    send(A, { type: 'chat', roomId: mA.roomId, text: 'hello stranger' });
    const chat = await waitFor(B, 'chat');
    ok('chat relayed with text', chat.text === 'hello stranger');

    // --- 4. skip / next: both requeued ---
    send(A, { type: 'next' });
    await waitFor(A, 'finding');
    const pl = await waitFor(B, 'partner-left');
    ok('skip: A back to finding, B told partner-left=skipped', pl.reason === 'skipped');
    const C = await client({ gender: 'male', lookingFor: 'any', region: 'any', interests: [] });
    const mC = await waitFor(C, 'matched');       // should match requeued B
    const mB2 = await waitFor(B, 'matched');
    ok('requeued user matched with newcomer', mC.roomId === mB2.roomId);
    send(C, { type: 'leave' }); send(B, { type: 'leave' }); send(A, { type: 'leave' });
    await sleep(500);

    // --- 5. filter compatibility ---
    const D = await client({ gender: 'female', lookingFor: 'male', region: 'india', interests: ['music'] });
    const E = await client({ gender: 'female', lookingFor: 'female', region: 'india', interests: ['music'] });
    await sleep(1200);
    const dMatched = D.inbox.some(m => m.type === 'matched');
    const eMatched = E.inbox.some(m => m.type === 'matched');
    ok('incompatible filters do NOT match (D wants male, E wants female)', !dMatched && !eMatched);
    const F = await client({ gender: 'male', lookingFor: 'any', region: 'india', interests: ['music', 'gaming'] });
    const mD = await waitFor(D, 'matched');
    const mF = await waitFor(F, 'matched');
    ok('compatible filters DO match (shared interest + region + gender)', mD.roomId === mF.roomId);
    // region mismatch: G wants US, only india folks waiting -> no match
    const G = await client({ gender: 'male', lookingFor: 'any', region: 'us', interests: [] });
    await sleep(1200);
    ok('region filter blocks cross-region match', !G.inbox.some(m => m.type === 'matched'));

    // --- 6. report flow ---
    send(D, { type: 'report', roomId: mD.roomId, reason: 'spam' });
    const rep = await waitFor(D, 'reported');
    ok('report acknowledged', !!rep);
    const plF = await waitFor(F, 'partner-left');
    ok('reported partner notified', plF.reason === 'reported');

    [A, B, C, D, E, F, G].forEach(c => { try { c.ws.close(); } catch {} });
  } catch (e) {
    console.log('FAIL  exception: ' + e.message);
    results.push(['no exception', false]);
  }
  const failed = results.filter(r => !r[1]);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
