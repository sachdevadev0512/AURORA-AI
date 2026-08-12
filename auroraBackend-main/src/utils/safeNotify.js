/**
 * Best-effort inbox notification — never throws into sync paths.
 */
async function safeNotify(userId, payload, logPrefix = 'Notify') {
  try {
    const { createNotification } = require('../services/appNotificationService');
    await createNotification(userId, payload);
    return true;
  } catch (err) {
    console.warn(`[${logPrefix}] Inbox notification failed:`, err.message);
    return false;
  }
}

module.exports = {
  safeNotify,
};
