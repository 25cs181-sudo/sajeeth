# ProxiSpeak WebRTC signaling - run & test guide

## What this module does (plain English)
WebRTC lets two browsers send voice **directly** to each other. Before that can happen they must swap a few
small messages (offer, answer, ICE candidates). Our Socket.IO server only relays those messages, after checking
that both users are logged in, in the same office and close enough. **No audio ever touches the server.**

## Files
- `signaling/index.js` - `registerSignaling(io, { authenticate, isInProximity })`, the entry point
- `signaling/validators.js` - payload checks
- `signaling/guards.js` - same-office + proximity checks
- `signaling/negotiationStore.js` - tracks live negotiations (stale-ID detection, expiry)
- `signaling/presence.js` - who is online
- `signaling/demoAdapters.js` - **DEMO ONLY** fake auth/proximity; replace with teammates' code
- `server.js`, `public/` - demo server and browser test page

## Plugging into the real project
```js
registerSignaling(io, {
  authenticate: async (handshake) => ({ userId, officeId, ... }), // verify token server-side
  isInProximity: async (userA, userB) => true | false,           // exactly true allows
  sweepIntervalMs: 5000,                                          // optional re-check timer
});
```
Call `sweep()` (returned by `registerSignaling`) whenever positions change to cut off users who left range.
If you run several server instances, replace `NegotiationStore`/`Presence` with a shared (e.g. Redis) store.

## Run
```bash
npm install
npm test        # automated tests
npm start       # http://localhost:3000
```

## Two-browser checklist (microphone works on `localhost` or HTTPS only)
1. [ ] `npm start`; open `http://localhost:3000` in two windows (use a normal and an incognito window).
2. [ ] Window 1 token `alice|officeA|0|0`, Connect -> log shows `connected`.
3. [ ] Window 2 token `bob|officeA|3|4`, Connect.
4. [ ] In Window 1 type `bob`, Call; allow the mic. Window 2 allows the mic automatically on answering.
5. [ ] Both logs reach `state: connected`; speak and hear the other side (use headphones to avoid echo).
6. [ ] Hang up in one window -> the other shows `state: hangup`.
7. Negative checks:
   - [ ] Connect with no/garbage token -> `connect error: UNAUTHENTICATED`.
   - [ ] Third window `carol|officeB|0|0` calls `alice` -> `error: CROSS_OFFICE`.
   - [ ] Window with `dave|officeA|500|500` calls `alice` -> `error: OUT_OF_RANGE`.
   - [ ] Call a user who isn't connected -> `error: PEER_OFFLINE`.
   - [ ] Both windows press Call at the same time -> one call wins, the other shows `error: GLARE`.
   - [ ] Close one window mid-call -> the other shows `state: peer-disconnected`.
8. [ ] In DevTools > Network > WS, confirm only small JSON messages go through the socket (no audio).

Demo range is 10 units (`PROXIMITY_RANGE` env var). Note: demo positions are fixed in the token, so "leaving range" is covered by automated tests (`sweep()`).

## Error codes
UNAUTHENTICATED, INVALID_PAYLOAD, PEER_OFFLINE, CROSS_OFFICE, OUT_OF_RANGE, SELF_CALL, STALE_NEGOTIATION, NOT_PARTICIPANT, GLARE, INTERNAL.
