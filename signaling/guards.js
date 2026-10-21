'use strict';

const { CODES, SignalingError } = require('./errors');

/**
 * Decides whether two users are allowed to talk right now.
 * Office comes from the server-side authenticated identity, NEVER from the client payload.
 * Proximity comes from the teammates' injected `isInProximity(userA, userB)`.
 */
function createGuards({ presence, isInProximity }) {
  async function assertEligible(fromId, toId) {
    if (fromId === toId) throw new SignalingError(CODES.SELF_CALL, 'Cannot connect to yourself');
    const a = presence.get(fromId);
    const b = presence.get(toId);
    if (!a) throw new SignalingError(CODES.UNAUTHENTICATED, 'Sender is not connected');
    if (!b) throw new SignalingError(CODES.PEER_OFFLINE, 'Peer is not online');
    if (!a.user.officeId || a.user.officeId !== b.user.officeId) {
      throw new SignalingError(CODES.CROSS_OFFICE, 'Users are not in the same office');
    }
    let near = false;
    try {
      near = (await isInProximity(a.user, b.user)) === true;
    } catch (err) {
      near = false; // fail closed: if the check breaks, deny
    }
    if (!near) throw new SignalingError(CODES.OUT_OF_RANGE, 'Peer is out of range');
  }

  /** Same as assertEligible but returns boolean (used by sweeps). */
  async function isEligible(a, b) {
    try { await assertEligible(a, b); return true; } catch (e) { return false; }
  }

  return { assertEligible, isEligible };
}

module.exports = { createGuards };
