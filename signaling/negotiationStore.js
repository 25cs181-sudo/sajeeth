'use strict';

/**
 * In-memory record of who is currently negotiating with whom.
 * Only small metadata is kept here: never SDP, never audio.
 * (For multiple server instances, swap this for Redis behind the same API.)
 */
class NegotiationStore {
  constructor({ ttlMs = 60000, now = () => Date.now() } = {}) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.byId = new Map();
  }

  _expired(n) {
    return this.now() - n.updatedAt > this.ttlMs;
  }

  create({ id, caller, callee }) {
    const n = { id, caller, callee, status: 'offered', updatedAt: this.now() };
    this.byId.set(id, n);
    return n;
  }

  /** Returns the live negotiation or undefined (expired ones are removed). */
  get(id) {
    const n = this.byId.get(id);
    if (!n) return undefined;
    if (this._expired(n)) {
      this.byId.delete(id);
      return undefined;
    }
    return n;
  }

  touch(n, status) {
    if (status) n.status = status;
    n.updatedAt = this.now();
  }

  delete(id) {
    return this.byId.delete(id);
  }

  /** All live negotiations involving userId. */
  forUser(userId) {
    const out = [];
    for (const n of [...this.byId.values()]) {
      if (this._expired(n)) { this.byId.delete(n.id); continue; }
      if (n.caller === userId || n.callee === userId) out.push(n);
    }
    return out;
  }

  /** Live negotiation between two users in either direction. */
  between(a, b) {
    return this.forUser(a).filter((n) => (n.caller === a && n.callee === b) || (n.caller === b && n.callee === a));
  }

  all() {
    return [...this.byId.values()].filter((n) => !this._expired(n));
  }
}

module.exports = { NegotiationStore };
