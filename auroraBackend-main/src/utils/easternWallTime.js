/**
 * Build Eastern wall-clock Date (America/New_York) on the same calendar day as source.
 */
function dateAtEasternWallTime(sourceDate, hour, minute, second = 0) {
  if (!sourceDate) return null;
  const ymd = sourceDate.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const [y, m, d] = ymd.split('-').map((n) => parseInt(n, 10));

  for (const offset of [4, 5]) {
    const candidate = new Date(Date.UTC(y, m - 1, d, hour + offset, minute, second));
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York',
      hour: 'numeric',
      minute: 'numeric',
      hour12: false,
    }).formatToParts(candidate);
    const ch = parseInt(parts.find((p) => p.type === 'hour').value, 10);
    const cm = parseInt(parts.find((p) => p.type === 'minute').value, 10);
    if (ch === hour && cm === minute) return candidate;
  }

  return new Date(Date.UTC(y, m - 1, d, hour + 4, minute, second));
}

function hourInEastern(date) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    hour: 'numeric',
    hour12: false,
  }).formatToParts(date);
  return parseInt(parts.find((p) => p.type === 'hour').value, 10);
}

module.exports = { dateAtEasternWallTime, hourInEastern };
