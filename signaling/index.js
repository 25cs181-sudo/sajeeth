'use strict';

const { CODES, SignalingError } = require('./errors');
const { NegotiationStore } = require('./negotiationStore');
const { Presence } = require('./presence');
const { createGuards } = require('./guards');
const v = require('./validators');

/**
 * Plug WebRTC signaling into an existing Socket.IO server.
 *
 * Teammate-provided dependencies (injected, so nothing is assumed):
 *  - authenticate(handshake) -> { userId, officeId, ...anything } | throws/returns null
 *      Must verify the credential server-side (e.g. JWT from handshake.auth.token).
 *  - isInProximity(userA, userB) -> boolean | Promise<boolean>
 *      Receives the objects returned by authenticate(). Must return exactly true to allow.
 *
 * Client -> server events: webrtc:offer, webrtc:answer, webrtc:ice-candidate, webrtc:hangup
 * Server -> client events: webrtc:offer, webrtc:answer, webrtc:ice-candidate, webrtc:hangup,
 *                          webrtc:peer-ineligible, webrtc:peer-disconnected, webrtc:error
 */
function registerSignaling(io, opts = {}) {
  const { authenticate, isInProximity } = opts;
  if (typeof authenticate !== 'function') throw new Error('authenticate function is required');
  if (typeof isInProximity !== 'function') throw new Error('isInProximity function is required');

  const store = opts.store || new NegotiationStore({ ttlMs: opts.ttlMs });
  const presence = new Presence();
  const guards = createGuards({ presence, isInProximity });

  // Build a namespace-aware emitter to a user (all of their sockets).
  const sendTo = (userId, event, payload) => {
    for (const sid of presence.socketIds(userId)) io.to(sid).emit(event, payload);
  };

  const endNegotiation = (n, reason, event) => {
    store.delete(n.id);
    for (const uid of [n.caller, n.callee]) {
      sendTo(uid, event, { negotiationId: n.id, reason });
    }
  };

  // ---- Step 1: authenticate every connection before any event is accepted ----
  io.use(async (socket, next) => {
    try {
      const user = await authenticate(socket.handshake);
      if (!user || typeof user.userId !== 'string' || typeof user.officeId !== 'string') {
        throw new Error('bad identity');
      }
      socket.data.user = user;
      next();
    } catch (e) {
      next(new Error(CODES.UNAUTHENTICATED));
    }
  });

  io.on('connection', (socket) => {
    const me = socket.data.user;
    presence.add(me, socket.id);

    // Wrap a handler: validates, catches errors, replies with a consistent shape.
    const on = (event, handler) => {
      socket.on(event, async (payload, ack) => {
        let negotiationId;
        try {
          if (payload && typeof payload === 'object') negotiationId = payload.negotiationId;
          // Identity must still be registered (user may have been removed).
          if (!presence.get(me.userId)) throw new SignalingError(CODES.UNAUTHENTICATED, 'Not authenticated');
          await handler(payload);
          if (typeof ack === 'function') ack({ ok: true });
        } catch (err) {
          const code = err instanceof SignalingError ? err.code : CODES.INTERNAL;
          const message = err instanceof SignalingError ? err.message : 'Internal error';
          const body = { ok: false, code, message, event, negotiationId: typeof negotiationId === 'string' ? negotiationId : undefined };
          socket.emit('webrtc:error', body);
          if (typeof ack === 'function') ack(body);
        }
      });
    };

    on('webrtc:offer', async (raw) => {
      const p = v.validateOffer(raw);
      await guards.assertEligible(me.userId, p.targetUserId);

      // Glare: both users offered to each other at the same time.
      for (const old of store.between(me.userId, p.targetUserId)) {
        if (old.status === 'offered' && old.caller === p.targetUserId) {
          // Deterministic rule: the lexicographically smaller userId wins.
          if (me.userId > p.targetUserId) {
            throw new SignalingError(CODES.GLARE, 'Simultaneous offer: the other user\'s offer takes priority');
          }
          store.delete(old.id);
          sendTo(old.caller, 'webrtc:error', { ok: false, code: CODES.GLARE, event: 'webrtc:offer', negotiationId: old.id, message: 'Simultaneous offer: yours lost' });
        } else {
          // New offer supersedes an older negotiation between the same pair.
          store.delete(old.id);
          sendTo(old.caller === me.userId ? old.callee : old.caller, 'webrtc:hangup', { negotiationId: old.id, reason: 'superseded' });
        }
      }
      if (store.get(p.negotiationId)) throw new SignalingError(CODES.STALE_NEGOTIATION, 'negotiationId already in use');

      store.create({ id: p.negotiationId, caller: me.userId, callee: p.targetUserId });
      sendTo(p.targetUserId, 'webrtc:offer', { negotiationId: p.negotiationId, fromUserId: me.userId, sdp: p.sdp });
    });

    // Common checks for answer / ice / hangup.
    const loadNegotiation = (id) => {
      const n = store.get(id);
      if (!n) throw new SignalingError(CODES.STALE_NEGOTIATION, 'Unknown, expired or ended negotiationId');
      if (n.caller !== me.userId && n.callee !== me.userId) {
        throw new SignalingError(CODES.NOT_PARTICIPANT, 'You are not part of this negotiation');
      }
      return n;
    };
    const otherOf = (n) => (n.caller === me.userId ? n.callee : n.caller);
    const checkStillEligible = async (n) => {
      try {
        await guards.assertEligible(me.userId, otherOf(n));
      } catch (e) {
        if (e.code === CODES.PEER_OFFLINE) endNegotiation(n, e.code, 'webrtc:peer-disconnected');
        else endNegotiation(n, e.code, 'webrtc:peer-ineligible');
        throw e;
      }
    };

    on('webrtc:answer', async (raw) => {
      const p = v.validateAnswer(raw);
      const n = loadNegotiation(p.negotiationId);
      if (n.callee !== me.userId) throw new SignalingError(CODES.NOT_PARTICIPANT, 'Only the callee can answer');
      if (n.status !== 'offered') throw new SignalingError(CODES.STALE_NEGOTIATION, 'Negotiation already answered');
      await checkStillEligible(n);
      store.touch(n, 'answered');
      sendTo(n.caller, 'webrtc:answer', { negotiationId: n.id, fromUserId: me.userId, sdp: p.sdp });
    });

    on('webrtc:ice-candidate', async (raw) => {
      const p = v.validateIce(raw);
      const n = loadNegotiation(p.negotiationId);
      await checkStillEligible(n);
      store.touch(n);
      sendTo(otherOf(n), 'webrtc:ice-candidate', { negotiationId: n.id, fromUserId: me.userId, candidate: p.candidate });
    });

    on('webrtc:hangup', async (raw) => {
      const p = v.validateHangup(raw);
      const n = loadNegotiation(p.negotiationId);
      store.delete(n.id);
      sendTo(otherOf(n), 'webrtc:hangup', { negotiationId: n.id, reason: 'hangup' });
    });

    socket.on('disconnect', () => {
      const gone = presence.remove(me.userId, socket.id);
      if (!gone) return; // user still has another tab/socket open
      for (const n of store.forUser(me.userId)) {
        store.delete(n.id);
        const other = n.caller === me.userId ? n.callee : n.caller;
        sendTo(other, 'webrtc:peer-disconnected', { negotiationId: n.id, reason: 'disconnect' });
      }
    });
  });

  /**
   * Re-check every live negotiation. Call it whenever positions/membership change
   * (teammates can hook this up) or let the optional timer run it.
   */
  async function sweep() {
    for (const n of store.all()) {
      if (!(await guards.isEligible(n.caller, n.callee))) {
        const offline = !presence.get(n.caller) || !presence.get(n.callee);
        endNegotiation(n, offline ? CODES.PEER_OFFLINE : 'NO_LONGER_ELIGIBLE', offline ? 'webrtc:peer-disconnected' : 'webrtc:peer-ineligible');
      }
    }
  }

  let timer = null;
  if (opts.sweepIntervalMs) {
    timer = setInterval(() => sweep().catch(() => {}), opts.sweepIntervalMs);
    if (timer.unref) timer.unref();
  }

  return { sweep, store, presence, stop: () => timer && clearInterval(timer) };
}

module.exports = { registerSignaling, CODES };
