/**
 * Normalize SQS message bodies from Amazon SP-API notifications.
 * Messages may be direct JSON, SNS-wrapped, or stringified twice.
 */

function tryParseJson(value) {
  if (value == null) return null;
  if (typeof value === 'object') return value;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function unwrapLayers(body) {
  const candidates = [];
  let current = body;

  for (let depth = 0; depth < 5 && current; depth += 1) {
    if (typeof current === 'string') {
      current = tryParseJson(current);
      if (!current) break;
    }

    if (typeof current !== 'object') break;
    candidates.push(current);

    if (current.Type === 'Notification' && current.Message != null) {
      current = tryParseJson(current.Message) || current.Message;
      continue;
    }

    if (current.message != null && typeof current.message === 'string') {
      const inner = tryParseJson(current.message);
      if (inner) {
        current = inner;
        continue;
      }
    }

    if (current.payload != null && typeof current.payload === 'string') {
      const inner = tryParseJson(current.payload);
      if (inner) {
        current = inner;
        continue;
      }
    }

    break;
  }

  return candidates;
}

/**
 * @param {string|object} rawBody - SQS Message.Body
 * @returns {object|null} Payload suitable for notificationService.handleIncomingNotification
 */
function parseSqsNotificationBody(rawBody) {
  const initial = tryParseJson(rawBody) || (typeof rawBody === 'object' ? rawBody : null);
  if (!initial) return null;

  const layers = unwrapLayers(initial);

  for (let i = layers.length - 1; i >= 0; i -= 1) {
    const layer = layers[i];
    const notificationType =
      layer.NotificationType ||
      layer.notificationType ||
      layer.notification_type;

    if (notificationType) {
      return layer;
    }

    if (layer.Payload || layer.payload || layer.OrderChangeNotification) {
      return {
        NotificationType: 'ORDER_CHANGE',
        Payload: layer.Payload || layer.payload || layer,
        ...layer,
      };
    }
  }

  return layers[layers.length - 1] || initial;
}

module.exports = {
  parseSqsNotificationBody,
  tryParseJson,
};
