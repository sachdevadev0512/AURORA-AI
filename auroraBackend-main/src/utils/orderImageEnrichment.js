const Product = require('../models/Product');
const Order = require('../models/Order');

const CATALOG_CONCURRENCY = Math.max(
  1,
  parseInt(process.env.ORDER_IMAGE_CATALOG_CONCURRENCY || '5', 10)
);

function getProductImageUrl(product) {
  if (!product?.images?.length) return null;
  return product.images[0]?.url || null;
}

function extractCatalogImage(catalogItem) {
  const imageSets = catalogItem?.images || catalogItem?.Images || [];
  for (const imageSet of imageSets) {
    const images = imageSet?.images || imageSet?.Images || [];
    if (!Array.isArray(images) || images.length === 0) continue;
    const firstImage = images[0];
    const link = firstImage?.link || firstImage?.Link;
    if (link) return link;
  }
  return null;
}

function toPlainOrders(orders) {
  if (!orders) return [];
  return orders.map((order) => (order?.toObject ? order.toObject() : order));
}

const { mapWithConcurrency } = require('./async');

async function loadProductImageMaps(sellerId, skus, asins) {
  if (skus.size === 0 && asins.size === 0) {
    return { bySku: new Map(), byAsin: new Map() };
  }

  const products = await Product.find({
    sellerId,
    $or: [
      ...(skus.size ? [{ sku: { $in: [...skus] } }] : []),
      ...(asins.size ? [{ asin: { $in: [...asins] } }] : []),
    ],
  })
    .select('sku asin images')
    .lean();

  return {
    bySku: new Map(products.map((product) => [product.sku, product])),
    byAsin: new Map(products.map((product) => [product.asin, product])),
  };
}

async function loadCatalogImageMap(amazonAPI, asins) {
  const imageByAsin = new Map();
  if (!amazonAPI || asins.size === 0) return imageByAsin;

  const asinList = [...asins];
  await mapWithConcurrency(asinList, CATALOG_CONCURRENCY, async (asin) => {
    try {
      const catalogItem = await amazonAPI.getCatalogItem(asin);
      const imageUrl = extractCatalogImage(catalogItem);
      if (imageUrl) imageByAsin.set(asin, imageUrl);
    } catch (error) {
      console.warn(`[OrderImages] Catalog image lookup failed for ${asin}:`, error.message);
    }
  });

  return imageByAsin;
}

function collectLookupKeys(orders) {
  const skus = new Set();
  const asins = new Set();
  const missingAsins = new Set();

  for (const order of orders) {
    for (const item of order.orderItems || []) {
      if (item.productImage) continue;
      if (item.sellerSku) skus.add(item.sellerSku);
      if (item.asin) {
        asins.add(item.asin);
        missingAsins.add(item.asin);
      }
    }
  }

  return { skus, asins, missingAsins };
}

function applyImagesToOrders(orders, bySku, byAsin, catalogByAsin) {
  for (const order of orders) {
    for (const item of order.orderItems || []) {
      if (item.productImage) continue;

      const product =
        (item.sellerSku && bySku.get(item.sellerSku)) ||
        (item.asin && byAsin.get(item.asin));

      const inventoryImage = product ? getProductImageUrl(product) : null;
      const catalogImage = item.asin ? catalogByAsin.get(item.asin) : null;

      item.productImage = inventoryImage || catalogImage || null;
    }
  }
}

async function enrichOrdersWithProductImages(orders, sellerId, { amazonAPI } = {}) {
  const plainOrders = toPlainOrders(orders);
  if (!plainOrders.length) return plainOrders;

  const { skus, asins, missingAsins } = collectLookupKeys(plainOrders);
  if (skus.size === 0 && asins.size === 0) return plainOrders;

  const { bySku, byAsin } = await loadProductImageMaps(sellerId, skus, asins);
  applyImagesToOrders(plainOrders, bySku, byAsin, new Map());

  const asinsStillMissing = new Set();
  for (const order of plainOrders) {
    for (const item of order.orderItems || []) {
      if (!item.productImage && item.asin) asinsStillMissing.add(item.asin);
    }
  }

  if (amazonAPI && asinsStillMissing.size > 0) {
    const catalogByAsin = await loadCatalogImageMap(amazonAPI, asinsStillMissing);
    applyImagesToOrders(plainOrders, bySku, byAsin, catalogByAsin);
  }

  await persistResolvedOrderImages(plainOrders);

  return plainOrders;
}

async function persistResolvedOrderImages(orders) {
  const updates = [];
  const seen = new Set();

  for (const order of orders) {
    if (!order?._id || !Array.isArray(order.orderItems)) continue;

    for (const item of order.orderItems) {
      if (!item?.productImage || !item?.asin) continue;
      const key = `${String(order._id)}|${String(item.asin)}|${String(item.productImage)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      updates.push({
        updateOne: {
          filter: { _id: order._id },
          update: {
            $set: {
              'orderItems.$[item].productImage': item.productImage,
            },
          },
          arrayFilters: [
            {
              'item.asin': item.asin,
              'item.productImage': { $in: [null, ''] },
            },
          ],
        },
      });
    }
  }

  if (updates.length > 0) {
    try {
      await Order.bulkWrite(updates, { ordered: false });
    } catch (error) {
      const writeErrors = error?.writeErrors || error?.result?.writeErrors;
      if (writeErrors?.length) {
        console.warn(`[OrderImages] Partial persist failure: ${writeErrors.length} update(s) skipped`);
      } else {
        console.warn('[OrderImages] Persist failed:', error.message);
      }
    }
  }
}

module.exports = {
  enrichOrdersWithProductImages,
  getProductImageUrl,
  extractCatalogImage,
};
