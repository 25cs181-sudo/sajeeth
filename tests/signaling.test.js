'use strict';
const http = require('http');
const { Server } = require('socket.io');
const { io: Client } = require('socket.io-client');
const { registerSignaling } = require('../signaling');
const { validateOffer, validateIce } = require('../signaling/validators');

const USERS = {
  alice: { userId: 'alice', officeId: 'A' },
  bob: { userId: 'bob', officeId: 'A' },
  carol: { userId: 'carol', officeId: 'B' },
  dave: { userId: 'dave', officeId: 'A' },
};
const far = new Set(['dave']); // users currently out of range
const SDP = (type) => ({ type, sdp: 'v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\n' });
let server, io, sig, port;
const clients = [];

beforeAll((done) => {
  server = http.createServer();
  io = new Server(server);
  sig = registerSignaling(io, {
    authenticate: (h) => USERS[h.auth && h.auth.token] || null,
    isInProximity: (a, b) => !far.has(a.userId) && !far.has(b.userId),
    ttlMs: 60000,
  });
  server.listen(0, () => { port = server.address().port; done(); });
});
afterAll((done) => { sig.stop(); io.close(); server.close(done); });
afterEach(() => { while (clients.length) clients.pop().close(); far.clear(); far.add('dave'); });

function connect(token) {
  return new Promise((resolve, reject) => {
    const c = Client(`http://localhost:${port}`, { auth: { token }, reconnection: false, forceNew: true });
    clients.push(c);
    c.on('connect', () => resolve(c));
    c.on('connect_error', reject);
  });
}
const once = (c, ev) => new Promise((r) => c.once(ev, r));
const call = (c, ev, p) => new Promise((r) => c.emit(ev, p, r));
const offer = (to, id) => ({ negotiationId: id, targetUserId: to, sdp: SDP('offer') });

describe('authentication', () => {
  test('rejects missing / unknown credentials', async () => {
    await expect(connect(undefined)).rejects.toThrow('UNAUTHENTICATED');
    await expect(connect('mallory')).rejects.toThrow('UNAUTHENTICATED');
  });
});

describe('happy path', () => {
  test('offer -> answer -> ice -> hangup', async () => {
    const a = await connect('alice'); const b = await connect('bob');
    const gotOffer = once(b, 'webrtc:offer');
    expect(await call(a, 'webrtc:offer', offer('bob', 'neg-00000001'))).toEqual({ ok: true });
    const o = await gotOffer;
    expect(o.fromUserId).toBe('alice'); // sender comes from the server, not the client
    const gotAnswer = once(a, 'webrtc:answer');
    expect((await call(b, 'webrtc:answer', { negotiationId: 'neg-00000001', sdp: SDP('answer') })).ok).toBe(true);
    expect((await gotAnswer).fromUserId).toBe('bob');
    const gotIce = once(a, 'webrtc:ice-candidate');
    await call(b, 'webrtc:ice-candidate', { negotiationId: 'neg-00000001', candidate: { candidate: 'candidate:1 1 udp 1 1.1.1.1 1 typ host', sdpMid: '0', sdpMLineIndex: 0 } });
    expect((await gotIce).candidate.sdpMid).toBe('0');
    const gotHangup = once(b, 'webrtc:hangup');
    await call(a, 'webrtc:hangup', { negotiationId: 'neg-00000001' });
    await gotHangup;
  });
});

describe('authorization', () => {
  test('cross-office is rejected', async () => {
    const a = await connect('alice'); await connect('carol');
    expect((await call(a, 'webrtc:offer', offer('carol', 'neg-00000002'))).code).toBe('CROSS_OFFICE');
  });
  test('out-of-range is rejected', async () => {
    const a = await connect('alice'); await connect('dave');
    expect((await call(a, 'webrtc:offer', offer('dave', 'neg-00000003'))).code).toBe('OUT_OF_RANGE');
  });
  test('offline peer and self-call are rejected', async () => {
    const a = await connect('alice');
    expect((await call(a, 'webrtc:offer', offer('bob', 'neg-00000004'))).code).toBe('PEER_OFFLINE');
    expect((await call(a, 'webrtc:offer', offer('alice', 'neg-00000005'))).code).toBe('SELF_CALL');
  });
  test('proximity check failing closes the door', async () => {
    const a = await connect('alice'); await connect('bob');
    far.add('bob');
    expect((await call(a, 'webrtc:offer', offer('bob', 'neg-00000006'))).code).toBe('OUT_OF_RANGE');
  });
  test('a third party cannot answer or send ICE for someone else\'s negotiation', async () => {
    const a = await connect('alice'); const b = await connect('bob');
    const x = await connect('dave'); far.clear();
    await call(a, 'webrtc:offer', offer('bob', 'neg-00000007'));
    expect((await call(x, 'webrtc:answer', { negotiationId: 'neg-00000007', sdp: SDP('answer') })).code).toBe('NOT_PARTICIPANT');
    expect((await call(x, 'webrtc:ice-candidate', { negotiationId: 'neg-00000007', candidate: { candidate: 'c' } })).code).toBe('NOT_PARTICIPANT');
    expect((await call(a, 'webrtc:answer', { negotiationId: 'neg-00000007', sdp: SDP('answer') })).code).toBe('NOT_PARTICIPANT'); // caller can't answer
    void b;
  });
});

describe('payload validation', () => {
  test.each([
    [null], ['str'], [{}],
    [{ negotiationId: 'x', targetUserId: 'bob', sdp: SDP('offer') }],
    [{ negotiationId: 'neg-00000008', targetUserId: 'bob', sdp: SDP('answer') }],
    [{ negotiationId: 'neg-00000008', targetUserId: 'bob', sdp: { type: 'offer', sdp: 'x'.repeat(200000) } }],
    [{ negotiationId: 'neg-00000008', targetUserId: { $ne: 1 }, sdp: SDP('offer') }],
  ])('rejects bad offer %#', async (p) => {
    const a = await connect('alice');
    expect((await call(a, 'webrtc:offer', p)).code).toBe('INVALID_PAYLOAD');
  });
  test('strips unexpected fields', () => {
    const out = validateOffer({ ...offer('bob', 'neg-00000009'), officeId: 'evil', fromUserId: 'x' });
    expect(out).not.toHaveProperty('officeId');
    expect(out).not.toHaveProperty('fromUserId');
  });
  test('bad ICE rejected', () => {
    expect(() => validateIce({ negotiationId: 'neg-00000009', candidate: { candidate: 1 } })).toThrow();
  });
});

describe('stale negotiation ids', () => {
  test('unknown id, reused id, answer twice, after hangup', async () => {
    const a = await connect('alice'); const b = await connect('bob');
    expect((await call(b, 'webrtc:answer', { negotiationId: 'neg-unknown1', sdp: SDP('answer') })).code).toBe('STALE_NEGOTIATION');
    await call(a, 'webrtc:offer', offer('bob', 'neg-00000010'));
    await call(b, 'webrtc:answer', { negotiationId: 'neg-00000010', sdp: SDP('answer') });
    expect((await call(b, 'webrtc:answer', { negotiationId: 'neg-00000010', sdp: SDP('answer') })).code).toBe('STALE_NEGOTIATION');
    await call(a, 'webrtc:hangup', { negotiationId: 'neg-00000010' });
    expect((await call(a, 'webrtc:ice-candidate', { negotiationId: 'neg-00000010', candidate: { candidate: 'c' } })).code).toBe('STALE_NEGOTIATION');
  });
  test('expired negotiation is stale', () => {
    const { NegotiationStore } = require('../signaling/negotiationStore');
    let t = 0; const s = new NegotiationStore({ ttlMs: 100, now: () => t });
    s.create({ id: 'neg-00000011', caller: 'a', callee: 'b' });
    t = 101;
    expect(s.get('neg-00000011')).toBeUndefined();
  });
});

describe('simultaneous offers (glare)', () => {
  test('lower userId wins, the other gets GLARE', async () => {
    const a = await connect('alice'); const b = await connect('bob');
    const bobGot = once(b, 'webrtc:offer');
    const r1 = await call(a, 'webrtc:offer', offer('bob', 'neg-00000012')); // alice first
    expect(r1.ok).toBe(true);
    await bobGot;
    const r2 = await call(b, 'webrtc:offer', offer('alice', 'neg-00000013')); // bob loses
    expect(r2.code).toBe('GLARE');
  });
  test('when the lower id offers second, it replaces the first', async () => {
    const a = await connect('alice'); const b = await connect('bob');
    await call(b, 'webrtc:offer', offer('alice', 'neg-00000014'));
    const r = await call(a, 'webrtc:offer', offer('bob', 'neg-00000015'));
    expect(r.ok).toBe(true);
    expect((await call(a, 'webrtc:answer', { negotiationId: 'neg-00000014', sdp: SDP('answer') })).code).toBe('STALE_NEGOTIATION');
  });
});

describe('disconnects and eligibility changes', () => {
  test('peer disconnect notifies the other side and ends negotiation', async () => {
    const a = await connect('alice'); const b = await connect('bob');
    await call(a, 'webrtc:offer', offer('bob', 'neg-00000016'));
    const ev = once(a, 'webrtc:peer-disconnected');
    b.close();
    expect((await ev).negotiationId).toBe('neg-00000016');
    expect((await call(a, 'webrtc:ice-candidate', { negotiationId: 'neg-00000016', candidate: { candidate: 'c' } })).code).toBe('STALE_NEGOTIATION');
  });
  test('user who becomes ineligible is cut off by sweep()', async () => {
    const a = await connect('alice'); const b = await connect('bob');
    await call(a, 'webrtc:offer', offer('bob', 'neg-00000017'));
    const evA = once(a, 'webrtc:peer-ineligible'); const evB = once(b, 'webrtc:peer-ineligible');
    far.add('bob');
    await sig.sweep();
    await Promise.all([evA, evB]);
    expect(sig.store.get('neg-00000017')).toBeUndefined();
  });
  test('ICE after leaving range is blocked and ends the call', async () => {
    const a = await connect('alice'); await connect('bob');
    await call(a, 'webrtc:offer', offer('bob', 'neg-00000018'));
    far.add('bob');
    const r = await call(a, 'webrtc:ice-candidate', { negotiationId: 'neg-00000018', candidate: { candidate: 'c' } });
    expect(r.code).toBe('OUT_OF_RANGE');
    expect(sig.store.get('neg-00000018')).toBeUndefined();
  });
});
