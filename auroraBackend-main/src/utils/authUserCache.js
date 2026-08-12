const mongoose = require('mongoose');
const User = require('../models/User');

const AUTH_USER_SELECT = '-password';

const authUserCacheSchema = new mongoose.Schema(
  {
    userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true, index: true },
    userJson: { type: String, required: true },
    expiresAt: { type: Date, required: true, index: true },
  },
  { versionKey: false },
);

authUserCacheSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

function getAuthCacheModel() {
  return mongoose.models.AuthUserCache || mongoose.model('AuthUserCache', authUserCacheSchema);
}

function toCacheTtlMs() {
  const parsed = Number(process.env.AUTH_USER_CACHE_TTL_MS);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 120_000;
}

const memoryCache = new Map();

function readMemory(userId) {
  const entry = memoryCache.get(String(userId));
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    memoryCache.delete(String(userId));
    return null;
  }
  return entry.user;
}

function writeMemory(userId, user, expiresAt) {
  memoryCache.set(String(userId), {
    user,
    expiresAt: expiresAt.getTime(),
  });
}

function serializeUser(userDoc) {
  const plain = userDoc && typeof userDoc.toObject === 'function' ? userDoc.toObject() : { ...userDoc };
  delete plain.password;
  return plain;
}

/** JSON.stringify turns ObjectIds into hex strings — restore them for Mongoose aggregate $match. */
function reviveAuthUser(user) {
  if (!user || typeof user !== 'object') return user;
  const revived = { ...user };

  if (revived._id && !(revived._id instanceof mongoose.Types.ObjectId)) {
    try {
      revived._id = new mongoose.Types.ObjectId(String(revived._id));
    } catch (_) {
      // keep original
    }
  }

  if (
    revived.sellerApplicationId &&
    !(revived.sellerApplicationId instanceof mongoose.Types.ObjectId)
  ) {
    try {
      revived.sellerApplicationId = new mongoose.Types.ObjectId(
        String(revived.sellerApplicationId),
      );
    } catch (_) {
      // keep original
    }
  }

  return revived;
}

async function getCachedAuthUser(userId) {
  const cached = readMemory(userId);
  if (cached) return reviveAuthUser(cached);

  if (mongoose.connection.readyState !== 1) {
    return null;
  }

  try {
    const doc = await getAuthCacheModel()
      .findOne({ userId, expiresAt: { $gt: new Date() } })
      .lean();

    if (!doc?.userJson) return null;

    const user = reviveAuthUser(JSON.parse(doc.userJson));
    writeMemory(userId, user, doc.expiresAt);
    return user;
  } catch (error) {
    console.warn('[AuthCache] Read failed:', error.message);
    return null;
  }
}

async function setCachedAuthUser(userId, userDoc) {
  const user = serializeUser(userDoc);
  const expiresAt = new Date(Date.now() + toCacheTtlMs());
  writeMemory(userId, user, expiresAt);

  if (mongoose.connection.readyState !== 1) {
    return user;
  }

  try {
    await getAuthCacheModel().findOneAndUpdate(
      { userId },
      { userJson: JSON.stringify(user), expiresAt },
      { upsert: true },
    );
  } catch (error) {
    console.warn('[AuthCache] Write failed:', error.message);
  }

  return user;
}

async function loadUserForAuth(userId) {
  if (!userId) return null;

  const cached = await getCachedAuthUser(userId);
  if (cached) return cached;

  const user = await User.findById(userId).select(AUTH_USER_SELECT).lean();
  if (!user) return null;

  return setCachedAuthUser(userId, user);
}

async function invalidateAuthUserCache(userId) {
  if (!userId) return;
  memoryCache.delete(String(userId));

  if (mongoose.connection.readyState !== 1) return;

  try {
    await getAuthCacheModel().deleteOne({ userId });
  } catch (error) {
    console.warn('[AuthCache] Invalidate failed:', error.message);
  }
}

module.exports = {
  loadUserForAuth,
  invalidateAuthUserCache,
  getCachedAuthUser,
  setCachedAuthUser,
};
