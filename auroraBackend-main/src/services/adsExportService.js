function escapeCsvCell(value) {
  if (value === null || value === undefined) return '';
  const text = String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function formatNumber(value, decimals = 2) {
  const num = Number(value);
  if (!Number.isFinite(num)) return '';
  return num.toFixed(decimals);
}

function buildAdsReportCsv(ads, metricsPeriod) {
  const headers = [
    'Campaign Name',
    'Campaign ID',
    'Status',
    'Type',
    'Country',
    'Impressions',
    'Clicks',
    'CTR (%)',
    'Spend',
    'Sales',
    'Orders',
    'ACOS (%)',
    'ROAS',
    'CPC',
    'Budget',
    'Campaign Start',
    'Campaign End',
    'Last Synced',
  ];

  const periodLabel = metricsPeriod?.isLifetime
    ? 'Lifetime'
    : `${metricsPeriod?.startDate || ''} to ${metricsPeriod?.endDate || ''}`;

  const metaRow = [`Report period: ${periodLabel}`, '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', '', ''];

  const rows = ads.map((ad) => [
    ad.campaignName,
    ad.campaignId,
    ad.status,
    ad.campaignType,
    ad.country || '',
    ad.impressions ?? 0,
    ad.clicks ?? 0,
    formatNumber(ad.ctr, 3),
    formatNumber(ad.spend?.amount, 2),
    formatNumber(ad.sales?.amount, 2),
    ad.orders ?? 0,
    formatNumber(ad.acos, 2),
    formatNumber(ad.roas, 2),
    formatNumber(ad.cpc, 2),
    formatNumber(ad.budget?.amount, 2),
    ad.startDate ? new Date(ad.startDate).toISOString().slice(0, 10) : '',
    ad.endDate ? new Date(ad.endDate).toISOString().slice(0, 10) : '',
    ad.lastSynced ? new Date(ad.lastSynced).toISOString() : '',
  ]);

  return [metaRow, headers, ...rows]
    .map((row) => row.map(escapeCsvCell).join(','))
    .join('\r\n');
}

function buildAdsReportFilename(metricsPeriod) {
  const stamp = new Date().toISOString().slice(0, 10);
  if (metricsPeriod?.isLifetime) {
    return `aurora-ads-lifetime-${stamp}.csv`;
  }
  const start = metricsPeriod?.startDate || 'start';
  const end = metricsPeriod?.endDate || 'end';
  return `aurora-ads-${start}-to-${end}.csv`;
}

module.exports = {
  buildAdsReportCsv,
  buildAdsReportFilename,
};
