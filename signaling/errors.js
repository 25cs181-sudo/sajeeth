'use strict';

// Every rejection uses one of these codes so the frontend can react to them.
const CODES = Object.freeze({
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  PEER_OFFLINE: 'PEER_OFFLINE',
  CROSS_OFFICE: 'CROSS_OFFICE',
  OUT_OF_RANGE: 'OUT_OF_RANGE',
  SELF_CALL: 'SELF_CALL',
  STALE_NEGOTIATION: 'STALE_NEGOTIATION',
  NOT_PARTICIPANT: 'NOT_PARTICIPANT',
  GLARE: 'GLARE',
  INTERNAL: 'INTERNAL',
});

class SignalingError extends Error {
  constructor(code, message) {
    super(message || code);
    this.code = code;
  }
}

module.exports = { CODES, SignalingError };
