function scheduleAmountFromNode(node) {
  if (node == null) return null;
  const entries = Array.isArray(node) ? node : [node];

  for (const entry of entries) {
    if (entry?.value != null) {
      const parsed = Number(entry.value);
      if (Number.isFinite(parsed)) return parsed;
    }

    const schedules = Array.isArray(entry?.schedule)
      ? entry.schedule
      : entry?.schedule
        ? [entry.schedule]
        : [];

    for (const row of schedules) {
      const raw = row?.value_with_tax ?? row?.value;
      const parsed = Number(raw);
      if (Number.isFinite(parsed)) return parsed;
    }

    const ourPrice = entry?.our_price?.[0]?.schedule?.[0];
    if (ourPrice) {
      const parsed = Number(ourPrice.value_with_tax ?? ourPrice.value);
      if (Number.isFinite(parsed)) return parsed;
    }
  }

  return null;
}

function listingAttrValue(attributes, key, marketplaceId) {
  const raw = attributes?.[key];
  if (!raw) return null;
  const entries = Array.isArray(raw) ? raw : [raw];
  const entry =
    entries.find((item) => !item.marketplace_id || item.marketplace_id === marketplaceId) ||
    entries[0];
  if (!entry) return null;

  return scheduleAmountFromNode(entry);
}

function matchesMarketplace(offer, marketplaceId) {
  return !offer?.marketplace_id || offer.marketplace_id === marketplaceId;
}

function matchesAudience(offer, audience) {
  const value = String(offer?.audience || 'ALL').toUpperCase();
  if (audience === 'B2B') {
    return value === 'B2B' || value.startsWith('B2B_');
  }
  return value === 'ALL' || !offer?.audience;
}

function findPurchasableOffer(attributes, marketplaceId, audience = 'ALL') {
  const offers = attributes?.purchasable_offer;
  if (!Array.isArray(offers) || offers.length === 0) return null;

  return (
    offers.find(
      (item) => matchesMarketplace(item, marketplaceId) && matchesAudience(item, audience),
    ) ||
    (audience === 'ALL'
      ? offers.find((item) => matchesMarketplace(item, marketplaceId)) || offers[0]
      : null)
  );
}

function getPurchasableOffer(attributes, marketplaceId) {
  return findPurchasableOffer(attributes, marketplaceId, 'ALL');
}

function extractOfferPrice(attributes, marketplaceId) {
  const offer = getPurchasableOffer(attributes, marketplaceId);
  if (offer) {
    const amount =
      scheduleAmountFromNode(offer.our_price) ??
      scheduleAmountFromNode(offer.discounted_price) ??
      scheduleAmountFromNode(offer);
    if (amount != null) {
      return { amount, currency: offer.currency || 'USD' };
    }
  }

  const listPrice = listingAttrValue(attributes, 'list_price', marketplaceId);
  if (listPrice != null) {
    return { amount: listPrice, currency: 'USD' };
  }

  return { amount: 0, currency: 'USD' };
}

function extractListingBoundPrices(attributes, marketplaceId, offers = null) {
  const offer = getPurchasableOffer(attributes, marketplaceId);
  const currency = offer?.currency || 'USD';

  const fromOffer = (field) => (offer ? scheduleAmountFromNode(offer[field]) : null);

  const minimumPrice =
    fromOffer('minimum_seller_allowed_price') ??
    fromOffer('minimum_price') ??
    listingAttrValue(attributes, 'minimum_seller_allowed_price', marketplaceId) ??
    listingAttrValue(attributes, 'minimum_price', marketplaceId);

  const maximumPrice =
    fromOffer('maximum_seller_allowed_price') ??
    fromOffer('maximum_price') ??
    listingAttrValue(attributes, 'maximum_seller_allowed_price', marketplaceId) ??
    listingAttrValue(attributes, 'maximum_price', marketplaceId);

  const b2bOffer = findPurchasableOffer(attributes, marketplaceId, 'B2B');
  let businessPrice =
    (b2bOffer ? scheduleAmountFromNode(b2bOffer.our_price) : null) ??
    fromOffer('business_price') ??
    listingAttrValue(attributes, 'business_price', marketplaceId);

  // Listings `offers` dataset often includes B2B sell prices without B2B purchasable_offer.
  if (businessPrice == null && Array.isArray(offers)) {
    const b2bListingOffer = offers.find((row) => {
      if (row?.marketplaceId && row.marketplaceId !== marketplaceId) return false;
      const offerType = String(row?.offerType || '').toUpperCase();
      const audience = String(row?.audience?.value || row?.audience || '').toUpperCase();
      return offerType === 'B2B' || audience === 'B2B' || audience.startsWith('B2B_');
    });
    if (b2bListingOffer?.price) {
      const amount = Number(
        b2bListingOffer.price.amount ??
          b2bListingOffer.price.Amount ??
          b2bListingOffer.price,
      );
      if (Number.isFinite(amount) && amount > 0) businessPrice = amount;
    }
  }

  return {
    currency,
    minimumPrice,
    maximumPrice,
    businessPrice,
  };
}

/**
 * Extract current listing price from Listings API item (matches inventory sync logic).
 */
function extractListingPrice(listingItem, marketplaceId) {
  if (!listingItem) return null;

  const attributes = listingItem.attributes || {};
  const { amount: attrAmount, currency: attrCurrency } = extractOfferPrice(
    attributes,
    marketplaceId,
  );

  let amount = attrAmount;
  let currency = attrCurrency;

  if (!amount && listingItem.offers?.length) {
    const offer =
      listingItem.offers.find((o) => !o.marketplaceId || o.marketplaceId === marketplaceId) ||
      listingItem.offers[0];
    amount = offer?.price?.amount ?? offer?.price?.Amount ?? 0;
    currency = offer?.price?.currencyCode ?? offer?.price?.CurrencyCode ?? currency;
  }

  const parsed = Number(amount) || 0;
  if (parsed <= 0) return null;

  return { amount: parsed, currency: currency || 'USD' };
}

module.exports = {
  scheduleAmountFromNode,
  listingAttrValue,
  matchesMarketplace,
  matchesAudience,
  findPurchasableOffer,
  getPurchasableOffer,
  extractOfferPrice,
  extractListingBoundPrices,
  extractListingPrice,
};
