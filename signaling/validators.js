'use strict';

const { CODES, SignalingError } = require('./errors');

const ID_RE = /^[A-Za-z0-9_-]{8,64}$/; // negotiationId format
const USER_ID_RE = /^[A-Za-z0-9_.:@-]{1,128}$/;
const MAX_SDP = 100 * 1024; // 100 KB is far more than any real SDP
const MAX_CANDIDATE = 2048;

function fail(msg) {
  throw new SignalingError(CODES.INVALID_PAYLOAD, msg);
}

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function checkIds(p, needTarget) {
  if (!isObj(p)) fail('Payload must be an object');
  if (typeof p.negotiationId !== 'string' || !ID_RE.test(p.negotiationId)) {
    fail('negotiationId must be 8-64 chars of A-Z a-z 0-9 _ -');
  }
  if (needTarget && (typeof p.targetUserId !== 'string' || !USER_ID_RE.test(p.targetUserId))) {
    fail('targetUserId is invalid');
  }
}

function checkSdp(sdp, type) {
  if (!isObj(sdp)) fail('sdp must be an object');
  if (sdp.type !== type) fail(`sdp.type must be "${type}"`);
  if (typeof sdp.sdp !== 'string' || sdp.sdp.length === 0 || sdp.sdp.length > MAX_SDP) {
    fail('sdp.sdp must be a non-empty string under 100KB');
  }
}

// Each validator returns a clean copy so unexpected extra fields are dropped.
function validateOffer(p) {
  checkIds(p, true);
  checkSdp(p.sdp, 'offer');
  return { negotiationId: p.negotiationId, targetUserId: p.targetUserId, sdp: { type: 'offer', sdp: p.sdp.sdp } };
}

function validateAnswer(p) {
  checkIds(p, false);
  checkSdp(p.sdp, 'answer');
  return { negotiationId: p.negotiationId, sdp: { type: 'answer', sdp: p.sdp.sdp } };
}

function validateIce(p) {
  checkIds(p, false);
  const c = p.candidate;
  if (!isObj(c)) fail('candidate must be an object');
  if (typeof c.candidate !== 'string' || c.candidate.length > MAX_CANDIDATE) fail('candidate.candidate is invalid');
  const out = { candidate: c.candidate };
  if (c.sdpMid != null) {
    if (typeof c.sdpMid !== 'string' || c.sdpMid.length > 64) fail('sdpMid is invalid');
    out.sdpMid = c.sdpMid;
  }
  if (c.sdpMLineIndex != null) {
    if (!Number.isInteger(c.sdpMLineIndex) || c.sdpMLineIndex < 0 || c.sdpMLineIndex > 64) fail('sdpMLineIndex is invalid');
    out.sdpMLineIndex = c.sdpMLineIndex;
  }
  return { negotiationId: p.negotiationId, candidate: out };
}

function validateHangup(p) {
  checkIds(p, false);
  return { negotiationId: p.negotiationId };
}

module.exports = { validateOffer, validateAnswer, validateIce, validateHangup };
