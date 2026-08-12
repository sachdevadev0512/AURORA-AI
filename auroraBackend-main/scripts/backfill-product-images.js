/**
 * Backfill product.images from Catalog Items (MAIN image) and, when needed,
 * Listings Items summaries.mainImage. Safe to re-run.
 *
 * Usage: node scripts/backfill-product-images.js [email]
 */
require('dotenv').config();
const mongoose = require('mongoose');
const Product = require('../src/models/Product');
const User = require('../src/models/User');
const AmazonAPI = require('../src/utils/amazonAPI');
const { extractPrimaryImage } = require('../src/utils/productDocumentBuilder');

const CONCURRENCY = Math.max(1, parseInt(process.env.IMAGE_BACKFILL_CONCURRENCY || '5', 10));

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i;
      i += 1;
      results[idx] = await mapper(items[idx], idx);
    }
  }
  const n = Math.min(limit, items.length);
  if (n === 0) return results;
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

async function backfillSeller(user) {
  const api = new AmazonAPI(user);
  const missing = await Product.find({
    sellerId: user._id,
    $or: [{ images: { $exists: false } }, { images: { $size: 0 } }, { images: null }],
  })
    .select('sku asin images')
    .lean();

  console.log(`[${user.email}] missing images: ${missing.length}`);
  if (missing.length === 0) return { updated: 0, failed: 0 };

  const byAsin = new Map();
  for (const p of missing) {
    if (!p.asin) continue;
    if (!byAsin.has(p.asin)) byAsin.set(p.asin, []);
    byAsin.get(p.asin).push(p);
  }

  const catalogCache = new Map();
  let updated = 0;
  let failed = 0;

  const asins = [...byAsin.keys()];
  await mapWithConcurrency(asins, CONCURRENCY, async (asin) => {
    let images = [];
    try {
      if (!catalogCache.has(asin)) {
        const catalog = await api.getCatalogItem(asin).catch(() => null);
        catalogCache.set(asin, catalog);
      }
      images = extractPrimaryImage(catalogCache.get(asin));
    } catch (e) {
      console.warn(`[${user.email}] catalog ${asin}: ${e.message}`);
    }

    const products = byAsin.get(asin) || [];
    for (const p of products) {
      let finalImages = images;
      if (!finalImages.length) {
        try {
          const listing = await api.getListingsItem(p.sku);
          const mainImage = listing?.summaries?.[0]?.mainImage || null;
          finalImages = extractPrimaryImage(null, { mainImage });
        } catch (e) {
          // ignore — leave empty
        }
      }
      if (!finalImages.length) {
        failed += 1;
        continue;
      }
      await Product.updateOne(
        { _id: p._id },
        { $set: { images: finalImages, updatedAt: new Date() } }
      );
      updated += 1;
    }
  });

  console.log(`[${user.email}] updated=${updated} stillMissing=${failed}`);
  return { updated, failed };
}

(async () => {
  await mongoose.connect(process.env.MONGO_URI);
  const emailFilter = process.argv[2];
  const users = emailFilter
    ? await User.find({ email: emailFilter })
    : await User.find({
        amazonRefreshToken: { $exists: true, $ne: null },
        amazonSellerId: { $exists: true, $ne: null },
      });

  let totalUpdated = 0;
  for (const user of users) {
    try {
      const result = await backfillSeller(user);
      totalUpdated += result.updated;
    } catch (e) {
      console.error(`[${user.email}] failed:`, e.message);
    }
  }
  console.log('done, totalUpdated', totalUpdated);
  await mongoose.disconnect();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
