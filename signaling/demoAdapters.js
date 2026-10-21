'use strict';
// DEMO ONLY - stand-ins for your teammates' real auth and proximity code. Replace them.
// Demo token format: "userId|officeId|x|y"  e.g. alice|officeA|0|0
const MAX_RANGE = Number(process.env.PROXIMITY_RANGE || 10);

function authenticate(handshake) {
  const token = handshake.auth && handshake.auth.token;
  if (typeof token !== 'string') return null;
  const [userId, officeId, x, y] = token.split('|');
  if (!userId || !officeId || Number.isNaN(Number(x)) || Number.isNaN(Number(y))) return null;
  return { userId, officeId, position: { x: Number(x), y: Number(y) } };
}

function isInProximity(a, b) {
  const dx = a.position.x - b.position.x;
  const dy = a.position.y - b.position.y;
  return Math.hypot(dx, dy) <= MAX_RANGE;
}

module.exports = { authenticate, isInProximity };
