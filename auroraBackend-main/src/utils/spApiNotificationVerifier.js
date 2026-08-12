const crypto = require('crypto');
const https = require('https');

const CERT_CACHE = new Map();
const CERT_CACHE_TTL_MS = Math.max(
  60_000,
  Number(process.env.NOTIFICATION_CERT_CACHE_TTL_MS || 86_400_000),
);
const MAX_TIMESTAMP_SKEW_MS = Math.max(
  60_000,
  Number(process.env.NOTIFICATION_MAX_TIMESTAMP_SKEW_MS || 300_000),
);

const SNS_CERT_HOST_PATTERN = /^sns\.[a-z0-9-]+\.amazonaws\.com(\.cn)?$/i;
const SPAPI_CERT_HOST_PATTERNS = [
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.com$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.co\.uk$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.de$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.fr$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.it$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.es$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.in$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.co\.jp$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.com\.au$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.com\.mx$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.com\.br$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.ae$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.sa$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.eg$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.com\.tr$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.nl$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.se$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.pl$/i,
  /^sellingpartnerapi(-[a-z0-9-]+)?\.amazon\.com\.be$/i,
];

function canSkipVerification() {
  return (
    process.env.NODE_ENV === 'development' &&
    process.env.SKIP_NOTIFICATION_SIGNATURE_VERIFY === 'true'
  );
}

function normalizeHeader(value) {
  if (Array.isArray(value)) return value[0];
  return value;
}

function isAllowedCertUrl(certUrl) {
  let parsed;
  try {
    parsed = new URL(String(certUrl));
  } catch {
    return false;
  }

  if (parsed.protocol !== 'https:') return false;

  const host = parsed.hostname.toLowerCase();
  const path = parsed.pathname.toLowerCase();

  if (SNS_CERT_HOST_PATTERN.test(host)) {
    return path.endsWith('.pem');
  }

  if (SPAPI_CERT_HOST_PATTERNS.some((pattern) => pattern.test(host))) {
    return path.endsWith('.pem');
  }

  return false;
}

function httpsGet(url, timeoutMs = 5000) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, (response) => {
      if (response.statusCode && response.statusCode >= 400) {
        reject(new Error(`Certificate download failed with status ${response.statusCode}`));
        response.resume();
        return;
      }

      const chunks = [];
      response.on('data', (chunk) => chunks.push(chunk));
      response.on('end', () => resolve(Buffer.concat(chunks)));
    });

    request.setTimeout(timeoutMs, () => {
      request.destroy(new Error('Certificate download timed out'));
    });
    request.on('error', reject);
  });
}

async function fetchSigningCertificate(certUrl) {
  if (!isAllowedCertUrl(certUrl)) {
    throw new Error('Certificate URL is not from a trusted Amazon domain');
  }

  const cacheKey = String(certUrl);
  const cached = CERT_CACHE.get(cacheKey);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.pem;
  }

  const pem = await httpsGet(cacheKey);
  CERT_CACHE.set(cacheKey, {
    pem,
    expiresAt: Date.now() + CERT_CACHE_TTL_MS,
  });
  return pem;
}

function buildSnsStringToSign(message) {
  const type = message.Type;
  if (!type) return null;

  const fieldsByType = {
    Notification: ['Message', 'MessageId', 'Subject', 'Timestamp', 'TopicArn', 'Type'],
    SubscriptionConfirmation: [
      'Message',
      'MessageId',
      'SubscribeURL',
      'Timestamp',
      'Token',
      'TopicArn',
      'Type',
    ],
    UnsubscribeConfirmation: [
      'Message',
      'MessageId',
      'SubscribeURL',
      'Timestamp',
      'Token',
      'TopicArn',
      'Type',
    ],
  };

  const fields = fieldsByType[type];
  if (!fields) return null;

  let canonical = '';
  for (const field of fields) {
    if (field === 'Subject' && (message.Subject == null || message.Subject === '')) {
      continue;
    }
    if (message[field] == null) {
      return null;
    }
    canonical += `${field}\n${message[field]}\n`;
  }
  return canonical;
}

function verifyWithPublicKey(data, signatureBase64, publicKeyPem, algorithm) {
  try {
    return crypto.verify(
      algorithm,
      Buffer.isBuffer(data) ? data : Buffer.from(String(data), 'utf8'),
      {
        key: publicKeyPem,
        padding: crypto.constants.RSA_PKCS1_PADDING,
      },
      Buffer.from(signatureBase64, 'base64'),
    );
  } catch {
    return false;
  }
}

async function verifySnsNotificationMessage(message) {
  if (!message || typeof message !== 'object') return false;
  if (!message.SigningCertURL || !message.Signature || !message.Type) return false;

  const stringToSign = buildSnsStringToSign(message);
  if (!stringToSign) return false;

  const certPem = await fetchSigningCertificate(message.SigningCertURL);
  const signatureVersion = String(message.SignatureVersion || '1');
  const algorithm = signatureVersion === '2' ? 'RSA-SHA256' : 'RSA-SHA1';

  return verifyWithPublicKey(stringToSign, message.Signature, certPem, algorithm);
}

function validateTimestampHeader(timestampHeader) {
  if (!timestampHeader) return true;

  const parsed = Date.parse(String(timestampHeader));
  if (Number.isNaN(parsed)) return false;

  return Math.abs(Date.now() - parsed) <= MAX_TIMESTAMP_SKEW_MS;
}

async function verifySpApiHeaderSignature({ rawBody, signature, certUrl, timestamp }) {
  if (!signature || !certUrl || rawBody == null) return false;
  if (!validateTimestampHeader(timestamp)) return false;

  const certPem = await fetchSigningCertificate(certUrl);
  const payload = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody), 'utf8');

  if (verifyWithPublicKey(payload, signature, certPem, 'RSA-SHA256')) {
    return true;
  }

  return verifyWithPublicKey(payload, signature, certPem, 'RSA-SHA1');
}

/**
 * Verify Amazon SP-API / SNS notification authenticity.
 * Supports SNS-wrapped payloads (SigningCertURL in body) and SP-API header signatures.
 */
async function verifyAmazonNotification({
  rawBody,
  parsedBody,
  signature,
  certUrl,
  timestamp,
}) {
  if (canSkipVerification()) {
    return true;
  }

  const body =
    parsedBody ||
    (() => {
      try {
        const text = Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : String(rawBody || '');
        return text ? JSON.parse(text) : null;
      } catch {
        return null;
      }
    })();

  if (body?.SigningCertURL && body?.Signature && body?.Type) {
    return verifySnsNotificationMessage(body);
  }

  const headerSignature = normalizeHeader(signature);
  const headerCertUrl = normalizeHeader(certUrl);
  const headerTimestamp = normalizeHeader(timestamp);

  if (headerSignature && headerCertUrl) {
    return verifySpApiHeaderSignature({
      rawBody,
      signature: headerSignature,
      certUrl: headerCertUrl,
      timestamp: headerTimestamp,
    });
  }

  return false;
}

module.exports = {
  canSkipVerification,
  isAllowedCertUrl,
  buildSnsStringToSign,
  verifyAmazonNotification,
  verifySnsNotificationMessage,
  verifySpApiHeaderSignature,
};
