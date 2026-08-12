const jwt = require('jsonwebtoken');
const { loadUserForAuth } = require('../utils/authUserCache');

/**
 * Socket.IO middleware — bind connection to JWT user (multi-tenant safe).
 */
async function socketAuthMiddleware(socket, next) {
  try {
    const raw =
      socket.handshake.auth?.token ||
      (socket.handshake.headers?.authorization || '').replace(/^Bearer\s+/i, '');

    if (!raw) {
      return next(new Error('Socket authentication required'));
    }

    const decoded = jwt.verify(raw, process.env.JWT_SECRET);
    const user = await loadUserForAuth(decoded.id);

    if (!user?._id) {
      return next(new Error('Socket user not found'));
    }

    socket.userId = String(user._id);
    next();
  } catch (error) {
    next(new Error('Socket authentication failed'));
  }
}

module.exports = { socketAuthMiddleware };
