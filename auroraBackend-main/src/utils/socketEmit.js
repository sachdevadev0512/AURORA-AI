/**
 * Emit a Socket.IO event to a single user's room.
 * Payload always gets an ISO timestamp (matches prior per-service helpers).
 */
function emitToUser(userId, event, payload = {}) {
  if (!global.io || userId == null) return;
  global.io.to(`user_${String(userId)}`).emit(event, {
    ...payload,
    timestamp: new Date().toISOString(),
  });
}

module.exports = {
  emitToUser,
};
