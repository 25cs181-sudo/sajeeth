'use strict';

/** Tracks which authenticated user is on which socket(s). */
class Presence {
  constructor() {
    this.users = new Map(); // userId -> { user, sockets:Set<socketId> }
  }

  add(user, socketId) {
    const e = this.users.get(user.userId) || { user, sockets: new Set() };
    e.user = user;
    e.sockets.add(socketId);
    this.users.set(user.userId, e);
  }

  /** Returns true if that was the user's last socket. */
  remove(userId, socketId) {
    const e = this.users.get(userId);
    if (!e) return false;
    e.sockets.delete(socketId);
    if (e.sockets.size === 0) { this.users.delete(userId); return true; }
    return false;
  }

  get(userId) { return this.users.get(userId); }
  socketIds(userId) { const e = this.users.get(userId); return e ? [...e.sockets] : []; }
  ids() { return [...this.users.keys()]; }
}

module.exports = { Presence };
