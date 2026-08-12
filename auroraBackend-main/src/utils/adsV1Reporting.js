const axios = require('axios');
const { parseGzipJsonReport, normalizeV1ReportRows } = require('./adsReportParser');

const V1_REPORTING_ACCEPT = 'application/vnd.adsapireporting.v1+json';
const V1_LIST_ACCOUNTS_ACCEPT = 'application/vnd.listadsaccountsresponse.v1+json';
const V1_LIST_ACCOUNTS_CONTENT = 'application/vnd.listadsaccountsrequest.v1+json';

const V1_DAILY_FIELDS = [
  'campaign.id',
  'date.value',
  'metric.impressions',
  'metric.clicks',
  // Monetary metrics require budgetCurrency.value (Amazon 400006 otherwise).
  'budgetCurrency.value',
  // Spend is metric.totalCost in Ads Reporting v1 — metric.cost / metric.spend are unknown.
  'metric.totalCost',
  'metric.sales',
  'metric.purchases',
];

// Keep money fields on 400005 fallback. Never drop totalCost/sales or Spend/ACOS stay $0.
const V1_MINIMAL_DAILY_FIELDS = [
  'campaign.id',
  'date.value',
  'metric.impressions',
  'metric.clicks',
  'budgetCurrency.value',
  'metric.totalCost',
  'metric.sales',
  'metric.purchases',
];

function useV1Reporting() {
  return String(process.env.ADS_REPORTING_API_VERSION || 'v1').toLowerCase() !== 'v3';
}

function getV1MaxRetentionDays() {
  return Math.min(
    455,
    Math.max(95, parseInt(process.env.ADS_V1_MAX_RETENTION_DAYS || '455', 10)),
  );
}

function getV1ChunkDays() {
  return Math.min(31, Math.max(7, parseInt(process.env.ADS_V1_CHUNK_DAYS || '30', 10)));
}

function getV1RequestDelayMs() {
  return Math.max(
    5000,
    parseInt(process.env.ADS_V1_REPORT_REQUEST_DELAY_MS || '10000', 10),
  );
}

function getV1MaxReportsPerSync() {
  return Math.max(1, parseInt(process.env.ADS_V1_MAX_REPORTS_PER_SYNC || '3', 10));
}

function getV1RateLimitCooldownMs() {
  return Math.max(
    60000,
    parseInt(process.env.ADS_V1_RATE_LIMIT_COOLDOWN_MS || '300000', 10),
  );
}

let v1CreateChain = Promise.resolve();
let v1CooldownUntil = 0;

function isV1RateLimitCooldownActive() {
  return Date.now() < v1CooldownUntil;
}

function getV1RateLimitCooldownRemainingMs() {
  return Math.max(0, v1CooldownUntil - Date.now());
}

function armV1RateLimitCooldown() {
  v1CooldownUntil = Date.now() + getV1RateLimitCooldownMs();
}

function runWithV1CreateLock(fn) {
  const result = v1CreateChain.then(fn);
  v1CreateChain = result.catch(() => {});
  return result;
}

function throwV1RateLimitError(message) {
  const err = new Error(message);
  err.code = 'ADS_V1_RATE_LIMITED';
  throw err;
}

const { sleep } = require('./async');

function isV1RateLimitError(status, data) {
  if (status === 429) return true;
  const message = String(data?.message || data || '');
  return message.includes('429') || message.toLowerCase().includes('too many requests');
}

function getRetryAfterMs(response, attempt) {
  const header = response?.headers?.['retry-after'] || response?.headers?.['Retry-After'];
  const parsed = parseInt(header, 10);
  if (Number.isFinite(parsed) && parsed > 0) {
    return Math.min(120000, parsed * 1000);
  }
  return Math.min(120000, 15000 * (attempt + 1));
}

function getV1ReportingHeaders(accessToken, clientId, adsAccountId, profileId) {
  return {
    Authorization: `Bearer ${accessToken}`,
    'Amazon-Advertising-API-ClientId': clientId,
    'Amazon-Ads-AccountId': adsAccountId,
    'Amazon-Advertising-API-Scope': String(profileId),
    'Content-Type': V1_REPORTING_ACCEPT,
    Accept: V1_REPORTING_ACCEPT,
  };
}

async function listAdsAccounts(accessToken, clientId, baseUrl) {
  const response = await axios.post(
    `${baseUrl}/adsAccounts/list`,
    { maxResults: 100 },
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Amazon-Advertising-API-ClientId': clientId,
        'Content-Type': V1_LIST_ACCOUNTS_CONTENT,
        Accept: V1_LIST_ACCOUNTS_ACCEPT,
      },
      timeout: 30000,
    },
  );

  return response.data?.adsAccounts || [];
}

async function resolveAdsAccountId(accessToken, clientId, baseUrl, profileId) {
  const accounts = await listAdsAccounts(accessToken, clientId, baseUrl);
  const profileIdNum = Number(profileId);

  for (const account of accounts) {
    const match = (account.alternateIds || []).find(
      (alt) => alt.profileId === profileIdNum || String(alt.profileId) === String(profileId),
    );
    if (match) {
      return account.adsAccountId;
    }
  }

  return null;
}

/**
 * One HTTP create attempt (no lock). Retries must stay inside runWithV1CreateLock —
 * recursing into createV1DailyCampaignReport while holding the lock deadlocks the
 * module-level chain (metrics never queue → Ads UI stuck at $0 / N/A).
 */
async function createV1DailyCampaignReportAttempt(
  accessToken,
  clientId,
  baseUrl,
  adsAccountId,
  profileId,
  startDate,
  endDate,
  fields,
) {
  if (isV1RateLimitCooldownActive()) {
    const remainingSec = Math.ceil(getV1RateLimitCooldownRemainingMs() / 1000);
    throwV1RateLimitError(
      `V1 reporting is in rate-limit cooldown (${remainingSec}s remaining)`,
    );
  }

  const headers = getV1ReportingHeaders(accessToken, clientId, adsAccountId, profileId);
  const body = {
    accessRequestedAccounts: [{ advertiserAccountId: adsAccountId }],
    reports: [
      {
        format: 'GZIP_JSON',
        timeGrain: 'DAILY',
        periods: [{ datePeriod: { startDate, endDate } }],
        query: {
          fields,
          filters: [],
        },
      },
    ],
  };

  const response = await axios.post(`${baseUrl}/adsApi/v1/create/reports`, body, {
    headers,
    timeout: 30000,
    validateStatus: () => true,
  });

  return response;
}

async function createV1DailyCampaignReport(
  accessToken,
  clientId,
  baseUrl,
  adsAccountId,
  profileId,
  startDate,
  endDate,
  fields = V1_DAILY_FIELDS,
  options = {},
) {
  const retryOnRateLimit = options.retryOnRateLimit === true;
  const maxRetries = retryOnRateLimit
    ? Math.max(1, parseInt(process.env.ADS_V1_RATE_LIMIT_MAX_RETRIES || '2', 10))
    : 0;

  return runWithV1CreateLock(async () => {
    let attempt = Number(options.attempt) || 0;
    let activeFields = Array.isArray(fields) && fields.length ? fields : V1_DAILY_FIELDS;
    let strippedFieldsFor400005 = false;

    while (true) {
      const response = await createV1DailyCampaignReportAttempt(
        accessToken,
        clientId,
        baseUrl,
        adsAccountId,
        profileId,
        startDate,
        endDate,
        activeFields,
      );

      if (isV1RateLimitError(response.status, response.data)) {
        armV1RateLimitCooldown();
        if (!retryOnRateLimit || attempt >= maxRetries) {
          throwV1RateLimitError(
            retryOnRateLimit
              ? `V1 create report failed (429): rate limited after ${maxRetries} retries`
              : 'V1 create report failed (429): rate limited',
          );
        }
        const waitMs = getRetryAfterMs(response, attempt);
        console.warn(
          `[AdsV1] Rate limited creating report ${startDate}..${endDate}, retrying in ${waitMs}ms (attempt ${attempt + 1}/${maxRetries})`,
        );
        await sleep(waitMs);
        attempt += 1;
        continue;
      }

      if (
        response.status >= 400
        && activeFields.length > 4
        && !strippedFieldsFor400005
        && String(response.data?.message || '').includes('400005')
      ) {
        strippedFieldsFor400005 = true;
        activeFields = V1_MINIMAL_DAILY_FIELDS;
        console.warn(
          `[AdsV1] Field error 400005 for ${startDate}..${endDate}; retrying with minimal metric fields`,
        );
        continue;
      }

      if (response.status >= 400) {
        const message =
          response.data?.message ||
          response.data?.error ||
          JSON.stringify(response.data)?.slice(0, 300);
        const err = new Error(`V1 create report failed (${response.status}): ${message}`);
        if (response.status === 429) {
          err.code = 'ADS_V1_RATE_LIMITED';
          armV1RateLimitCooldown();
        }
        throw err;
      }

      const report = response.data?.success?.[0]?.report;
      const reportId = report?.reportId;
      if (!reportId) {
        throw new Error('V1 create report did not return reportId');
      }

      return reportId;
    }
  });
}

async function retrieveV1Reports(accessToken, clientId, baseUrl, adsAccountId, profileId, reportIds) {
  const headers = getV1ReportingHeaders(accessToken, clientId, adsAccountId, profileId);
  const response = await axios.post(
    `${baseUrl}/adsApi/v1/retrieve/reports`,
    {
      accessRequestedAccounts: [{ advertiserAccountId: adsAccountId }],
      reportIds,
    },
    { headers, timeout: 30000 },
  );

  const reports = [];
  for (const item of response.data?.success || []) {
    if (item?.report) reports.push(item.report);
  }
  return reports;
}

function normalizeV1ReportStatus(report) {
  return String(report?.status || '').toUpperCase();
}

function extractV1DownloadUrls(report) {
  const parts = report?.completedReportParts;
  if (!Array.isArray(parts) || parts.length === 0) return [];

  const urls = [];
  for (const part of parts) {
    const url = part?.url || part?.downloadUrl || part?.location || part?.presignedUrl;
    if (url) urls.push(url);
  }
  return urls;
}

async function downloadV1ReportFile(downloadUrl) {
  const response = await axios.get(downloadUrl, {
    responseType: 'arraybuffer',
    timeout: 120000,
  });
  return parseGzipJsonReport(Buffer.from(response.data));
}

async function downloadV1ReportRows(report) {
  const urls = extractV1DownloadUrls(report);
  if (urls.length === 0) {
    return [];
  }

  const allRows = [];
  for (const url of urls) {
    const rows = await downloadV1ReportFile(url);
    allRows.push(...rows);
  }

  return normalizeV1ReportRows(allRows);
}

module.exports = {
  useV1Reporting,
  getV1MaxRetentionDays,
  getV1ChunkDays,
  getV1RequestDelayMs,
  getV1MaxReportsPerSync,
  isV1RateLimitError,
  isV1RateLimitCooldownActive,
  getV1RateLimitCooldownRemainingMs,
  V1_DAILY_FIELDS,
  listAdsAccounts,
  resolveAdsAccountId,
  createV1DailyCampaignReport,
  retrieveV1Reports,
  normalizeV1ReportStatus,
  extractV1DownloadUrls,
  downloadV1ReportRows,
};
