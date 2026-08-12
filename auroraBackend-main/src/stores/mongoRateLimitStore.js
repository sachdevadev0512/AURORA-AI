const mongoose = require('mongoose');

const rateLimitHitSchema = new mongoose.Schema(
  {
    key: { type: String, required: true, unique: true, index: true },
    totalHits: { type: Number, required: true, default: 0 },
    resetTime: { type: Date, required: true, index: true },
  },
  { versionKey: false },
);

rateLimitHitSchema.index({ resetTime: 1 }, { expireAfterSeconds: 0 });

function getRateLimitModel() {
  return mongoose.models.RateLimitHit || mongoose.model('RateLimitHit', rateLimitHitSchema);
}

/**
 * MongoDB-backed express-rate-limit store — shared across app instances.
 * Falls back to an in-process map when MongoDB is unavailable.
 */
class MongoRateLimitStore {
  constructor(prefix = 'default') {
    this.prefix = prefix;
    this.windowMs = 60_000;
    this.localKeys = false;
    this.fallback = new Map();
    this.fallbackWarned = false;
  }

  init(options = {}) {
    this.windowMs = options.windowMs || this.windowMs;
  }

  namespacedKey(key) {
    return `${this.prefix}:${key}`;
  }

  isMongoReady() {
    return mongoose.connection.readyState === 1;
  }

  warnFallback(reason) {
    if (this.fallbackWarned) return;
    this.fallbackWarned = true;
    const isProd = process.env.NODE_ENV === 'production';
    const prefix = `[RateLimit] ${this.prefix}: using in-memory fallback (${reason}).`;
    if (isProd) {
      console.error(
        `${prefix} Multi-instance rate limits will NOT be shared — set RATE_LIMIT_STORE=mongo and ensure MongoDB is connected.`,
      );
    } else {
      console.warn(`${prefix} Rate limits are per-process only until MongoDB is available.`);
    }
  }

  async increment(key) {
    const namespaced = this.namespacedKey(key);
    if (!this.isMongoReady()) {
      this.warnFallback('mongo_not_ready');
      return this.incrementFallback(namespaced);
    }

    try {
      return await this.incrementMongo(namespaced);
    } catch (error) {
      this.warnFallback(error.message);
      console.warn('[RateLimit] Mongo store failed, using in-memory fallback:', error.message);
      return this.incrementFallback(namespaced);
    }
  }

  async incrementMongo(namespaced) {
    const Model = getRateLimitModel();
    const now = Date.now();
    const windowEnd = new Date(now + this.windowMs);

    let doc = await Model.findOne({ key: namespaced }).lean();
    if (!doc || !doc.resetTime || doc.resetTime.getTime() <= now) {
      doc = await Model.findOneAndUpdate(
        { key: namespaced },
        { $set: { totalHits: 1, resetTime: windowEnd } },
        { upsert: true, new: true, setDefaultsOnInsert: true },
      ).lean();
      return { totalHits: doc.totalHits, resetTime: doc.resetTime };
    }

    const updated = await Model.findOneAndUpdate(
      { key: namespaced, resetTime: { $gt: new Date(now) } },
      { $inc: { totalHits: 1 } },
      { new: true },
    ).lean();

    if (!updated) {
      return this.incrementMongo(namespaced);
    }

    return { totalHits: updated.totalHits, resetTime: updated.resetTime };
  }

  incrementFallback(namespaced) {
    const now = Date.now();
    const existing = this.fallback.get(namespaced);

    if (!existing || existing.resetTime.getTime() <= now) {
      const resetTime = new Date(now + this.windowMs);
      const entry = { totalHits: 1, resetTime };
      this.fallback.set(namespaced, entry);
      return entry;
    }

    existing.totalHits += 1;
    return { totalHits: existing.totalHits, resetTime: existing.resetTime };
  }

  async decrement(key) {
    const namespaced = this.namespacedKey(key);
    if (!this.isMongoReady()) {
      const entry = this.fallback.get(namespaced);
      if (entry && entry.totalHits > 0) entry.totalHits -= 1;
      return;
    }

    try {
      await getRateLimitModel().updateOne(
        { key: namespaced, totalHits: { $gt: 0 } },
        { $inc: { totalHits: -1 } },
      );
    } catch (error) {
      console.warn('[RateLimit] Mongo decrement failed:', error.message);
    }
  }

  async resetKey(key) {
    const namespaced = this.namespacedKey(key);
    this.fallback.delete(namespaced);
    if (!this.isMongoReady()) return;

    try {
      await getRateLimitModel().deleteOne({ key: namespaced });
    } catch (error) {
      console.warn('[RateLimit] Mongo resetKey failed:', error.message);
    }
  }

  async resetAll() {
    this.fallback.clear();
    if (!this.isMongoReady()) return;

    try {
      await getRateLimitModel().deleteMany({ key: new RegExp(`^${this.prefix}:`) });
    } catch (error) {
      console.warn('[RateLimit] Mongo resetAll failed:', error.message);
    }
  }
}

function createMongoRateLimitStore(prefix) {
  return new MongoRateLimitStore(prefix);
}

module.exports = {
  MongoRateLimitStore,
  createMongoRateLimitStore,
};
