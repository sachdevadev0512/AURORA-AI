const Product = require('../models/Product');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const { extractListingPrice } = require('../utils/listingPriceParser');
const {
  parseFeesEstimate,
  hasPriorProductFees,
  diffProductFees,
  formatFeeLabel,
  formatMoney,
} = require('../utils/productFeeParser');

const NOTIFY_ON_FIRST_FEE_SYNC =
  process.env.PRODUCT_FEE_NOTIFY_ON_FIRST_SYNC === 'true';

function buildChangeTitle(change) {
  const verb =
    change.changeType === 'added'
      ? 'added'
      : change.changeType === 'removed'
        ? 'removed'
        : 'changed';
  return `Amazon: ${change.feeLabel} ${verb} (${change.asin})`;
}

function buildChangeMessage(change) {
  const { asin, feeLabel, changeType, oldAmount, newAmount, currencyCode, sku } = change;
  const skuPart = sku ? ` (SKU ${sku})` : '';

  if (changeType === 'added') {
    return `Inventory ${asin}${skuPart} — ${feeLabel}: ${formatMoney(newAmount, currencyCode)}`;
  }
  if (changeType === 'removed') {
    return `Inventory ${asin}${skuPart} — ${feeLabel} removed (was ${formatMoney(oldAmount, currencyCode)})`;
  }
  return `Inventory ${asin}${skuPart} — ${feeLabel}: ${formatMoney(oldAmount, currencyCode)} → ${formatMoney(newAmount, currencyCode)}`;
}

function emitProductFeeLiveUpdate(userId, product, change, notification = null) {
  if (!global.io || !product) return;

  const payload = {
    productId: product._id ? String(product._id) : null,
    asin: product.asin,
    sku: product.sku,
    title: product.title,
    feeType: change.feeType,
    feeLabel: change.feeLabel || formatFeeLabel(change.feeType),
    changeType: change.changeType,
    oldAmount: change.oldAmount,
    newAmount: change.newAmount,
    currencyCode: change.currencyCode,
    fees: product.fees,
    price: product.price,
    notification: notification
      ? {
          _id: String(notification._id),
          source: notification.source || 'amazon',
          type: notification.type,
          title: notification.title,
          message: notification.message,
          link: notification.link,
          read: false,
          metadata: notification.metadata,
          createdAt: notification.createdAt?.toISOString?.() || new Date().toISOString(),
        }
      : null,
    timestamp: new Date().toISOString(),
  };

  global.io.to(`user_${String(userId)}`).emit('productFeeChange', payload);
  global.io.to(`user_${String(userId)}`).emit('productFeesUpdated', payload);
}

async function notifyProductFeeChanges(userId, product, changes, options = {}) {
  if (!changes?.length || !product) return 0;

  const appNotificationService = require('./appNotificationService');
  const productDbId = product._id ? String(product._id) : null;
  const link = productDbId ? `/products/${productDbId}` : '/products';
  let notified = 0;

  for (const change of changes) {
    try {
      const doc = await appNotificationService.publishProductFeeChange(userId, {
        product,
        change,
        title: buildChangeTitle(change),
        message: buildChangeMessage(change),
        link,
      });
      if (options.emitSocket !== false) {
        emitProductFeeLiveUpdate(userId, product, change, doc);
      }
      notified += 1;
    } catch (err) {
      console.warn(
        `[ProductFees] Notification failed ${product.asin} ${change.feeType}:`,
        err.message
      );
    }
  }

  return notified;
}

async function resolveLiveProductPrice(amazonAPI, product) {
  try {
    const listingItem = await amazonAPI.getListingsItem(product.sku);
    const livePrice = extractListingPrice(listingItem, amazonAPI.getMarketplaceId());

    if (livePrice?.amount > 0) {
      return livePrice;
    }
  } catch (error) {
    console.warn(
      `[ProductFees] getListingsItem failed for ${product.sku}: ${error.message}`,
    );
  }

  const stored = Number(product.price?.amount) || 0;
  if (stored > 0) {
    return {
      amount: stored,
      currency: product.price?.currency || 'USD',
    };
  }

  return null;
}

async function applyProductFeeUpdate(user, product, fees, options = {}) {
  const notify = options.notify !== false;
  const snapshot = product.toObject ? product.toObject() : { ...product };
  const changes = diffProductFees(snapshot, fees);
  const hadPriorFees = hasPriorProductFees(snapshot);

  const updateDoc = {
    fees,
    feesLastSynced: new Date(),
  };
  if (options.price?.amount > 0) {
    updateDoc.price = options.price;
  }

  const updatedProduct = product._id
    ? await Product.findByIdAndUpdate(product._id, updateDoc, { new: true })
    : null;

  const resultProduct = updatedProduct || { ...snapshot, ...updateDoc };

  let notified = 0;
  const shouldNotify =
    notify &&
    changes.length > 0 &&
    (hadPriorFees || NOTIFY_ON_FIRST_FEE_SYNC);

  if (shouldNotify) {
    notified = await notifyProductFeeChanges(user._id, resultProduct, changes);
  }

  if (changes.length > 0) {
    console.log(
      `[ProductFees] ${product.asin} (${product.sku}): ${changes.length} fee change(s)${notified ? `, ${notified} live notified` : ''}`
    );
  }

  return {
    product: resultProduct,
    changes,
    notified,
  };
}

async function refreshProductFeesAndNotify(user, product, options = {}) {
  if (!product?.sku || !product?.asin) {
    return { product, changes: [], notified: 0 };
  }

  const sellerAppCredentials = await getSellerAppCredentials(user._id);
  const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
  const isFba = product.fulfillmentType !== 'FBM';

  try {
    const livePrice = await resolveLiveProductPrice(amazonAPI, product);
    if (!livePrice?.amount) {
      return { product, changes: [], notified: 0, skipped: 'no_price' };
    }

    const feesResponse = await amazonAPI.getMyFeesEstimateForSku(
      product.sku,
      livePrice.amount,
      livePrice.currency,
      isFba
    );
    const fees = parseFeesEstimate(feesResponse);
    return applyProductFeeUpdate(user, product, fees, {
      ...options,
      price: livePrice,
    });
  } catch (err) {
    return { product, changes: [], notified: 0, error: err.message };
  }
}

module.exports = {
  notifyProductFeeChanges,
  refreshProductFeesAndNotify,
  applyProductFeeUpdate,
  resolveLiveProductPrice,
  emitProductFeeLiveUpdate,
  buildChangeTitle,
  buildChangeMessage,
};
