function normalizeOrigin(url) {
  if (!url) return null;
  try {
    const parsed = new URL(String(url).trim());
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

function getAllowedFrontendOrigins() {
  const raw = [
    process.env.FRONTEND_URL,
    process.env.CLIENT_URL,
    ...(process.env.ALLOWED_FRONTEND_URLS || '').split(','),
  ];

  return [...new Set(raw.map(normalizeOrigin).filter(Boolean))];
}

function getDefaultFrontendOrigin() {
  const allowed = getAllowedFrontendOrigins();
  return allowed[0] || 'http://localhost:5173';
}

function resolveFrontendReturnUrl(candidate) {
  const origin = normalizeOrigin(candidate);
  const allowed = getAllowedFrontendOrigins();
  if (origin && allowed.includes(origin)) {
    return origin;
  }
  return getDefaultFrontendOrigin();
}

function buildIntegrationRedirect(returnUrl, query = '') {
  const base = resolveFrontendReturnUrl(returnUrl);
  const path = `${base.replace(/\/$/, '')}/integration`;
  return query ? `${path}?${query}` : path;
}

module.exports = {
  normalizeOrigin,
  getAllowedFrontendOrigins,
  getDefaultFrontendOrigin,
  resolveFrontendReturnUrl,
  buildIntegrationRedirect,
};
