/**
 * Match Amazon Advertising profiles to the Selling Partner seller linked in Aurora.
 * accountInfo.id on Ads profiles corresponds to the merchant/seller identifier.
 */

function normalizeSellerId(value) {
  if (value == null || value === '') return null;
  return String(value).trim().toUpperCase();
}

function getProfileAccountId(profile) {
  return profile?.accountInfo?.id ?? profile?.account_info?.id ?? null;
}

function profileMatchesSeller(profile, amazonSellerId) {
  const expected = normalizeSellerId(amazonSellerId);
  if (!expected) return true;

  const accountId = normalizeSellerId(getProfileAccountId(profile));
  if (!accountId) return false;

  return accountId === expected;
}

function filterProfilesForSeller(profiles, amazonSellerId) {
  const list = Array.isArray(profiles) ? profiles : [];
  if (!amazonSellerId) return list;

  return list.filter((profile) => profileMatchesSeller(profile, amazonSellerId));
}

function summarizeProfiles(profiles) {
  return (profiles || []).map((p) => ({
    profileId: p.profileId,
    countryCode: p.countryCode,
    accountId: getProfileAccountId(p),
    accountName: p.accountInfo?.name || p.account_info?.name || null,
  }));
}

module.exports = {
  normalizeSellerId,
  getProfileAccountId,
  profileMatchesSeller,
  filterProfilesForSeller,
  summarizeProfiles,
};
