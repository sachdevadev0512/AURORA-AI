const zlib = require('zlib');
const { promisify } = require('util');

const gunzip = promisify(zlib.gunzip);

function toNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function readNested(row, path) {
  if (!row || typeof row !== 'object') return undefined;
  if (Object.prototype.hasOwnProperty.call(row, path)) {
    return row[path];
  }

  const parts = path.split('.');
  let current = row;
  for (const part of parts) {
    if (current == null || typeof current !== 'object') return undefined;
    current = current[part];
  }
  return current;
}

function normalizeV1ReportRow(row) {
  const campaignId = readNested(row, 'campaign.id') ?? row.campaignId ?? row.campaign_id;
  const date = readNested(row, 'date.value') ?? row.date ?? row.reportDate;
  const impressions = readNested(row, 'metric.impressions') ?? row.impressions;
  const clicks = readNested(row, 'metric.clicks') ?? row.clicks;
  const cost =
    readNested(row, 'metric.totalCost') ??
    readNested(row, 'metric.cost') ??
    readNested(row, 'metric.spend') ??
    readNested(row, 'metric.cost.value') ??
    row.totalCost ??
    row.cost;
  const purchases14d =
    readNested(row, 'metric.purchases') ??
    readNested(row, 'metric.purchases14d') ??
    row.purchases14d ??
    row.purchases;
  const sales14d =
    readNested(row, 'metric.sales') ??
    readNested(row, 'metric.sales14d') ??
    row.sales14d ??
    row.sales;

  return {
    campaignId: campaignId != null ? String(campaignId) : null,
    date: date != null ? String(date).slice(0, 10) : null,
    impressions: toNumber(impressions),
    clicks: toNumber(clicks),
    cost: toNumber(cost),
    purchases14d: toNumber(purchases14d),
    sales14d: toNumber(sales14d),
  };
}

function normalizeV1ReportRows(rows) {
  if (!Array.isArray(rows)) return [];
  return rows.map(normalizeV1ReportRow).filter((row) => row.campaignId);
}

async function parseGzipJsonReport(buffer) {
  let jsonText;
  try {
    const unzipped = await gunzip(buffer);
    jsonText = unzipped.toString('utf8');
  } catch {
    jsonText = buffer.toString('utf8');
  }

  const data = JSON.parse(jsonText);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.records)) return data.records;
  if (Array.isArray(data?.report)) return data.report;
  if (Array.isArray(data?.rows)) return data.rows;
  return [];
}

module.exports = {
  parseGzipJsonReport,
  normalizeV1ReportRow,
  normalizeV1ReportRows,
};
