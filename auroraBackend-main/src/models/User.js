const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const {
  encryptField,
  encryptUpdateFields,
  decryptDocumentFields,
  isEncryptedValue,
} = require('../utils/fieldEncryption');

const SENSITIVE_TOKEN_FIELDS = ['amazonRefreshToken', 'amazonAdsRefreshToken'];

const userSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
  },
  password: {
    type: String,
    required: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
  },
  amazonSellerId: {
    type: String,
    sparse: true,
    trim: true,
  },
  amazonRefreshToken: {
    type: String,
    sparse: true,
  },
  marketplace: {
    type: String,
    enum: ['NA', 'EU', 'FE'],
    default: 'NA',
  },
  amazonMarketplaceIds: {
    type: [String],
    default: [],
  },
  isVerified: {
    type: Boolean,
    default: false,
  },
  // OAuth-related fields
  amazonOAuthState: {
    type: String,
    sparse: true, // Temporary state for CSRF protection
  },
  amazonTokenExpiresAt: {
    type: Date,
    sparse: true, // When the current access token expires
  },
  // Advertising API fields
  amazonAdsRefreshToken: {
    type: String,
    sparse: true, // For advertising API access
  },
  amazonAdsOAuthState: {
    type: String,
    sparse: true, // Temporary state for ads OAuth flow
  },
  amazonAdsTokenExpiresAt: {
    type: Date,
    sparse: true, // When the advertising API access token expires
  },
  lastAdsSyncedAt: {
    type: Date,
    sparse: true,
  },
  lastAdsMetricsSyncedAt: {
    type: Date,
    sparse: true,
  },
  amazonAdsProfileIds: {
    type: [String],
    default: [],
  },
  amazonAdsAccountId: {
    type: String,
    sparse: true,
    trim: true,
  },
  orderNotificationSubscriptionId: {
    type: String,
    sparse: true,
  },
  orderNotificationsEnabled: {
    type: Boolean,
    default: false,
  },
  orderNotificationsSubscribedAt: {
    type: Date,
    sparse: true,
  },
  customerReturnsSyncScheduledAt: {
    type: Date,
    sparse: true,
  },
  customerRefundsSyncScheduledAt: {
    type: Date,
    sparse: true,
  },
  // Multi-account support
  sellerApplicationId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'SellerApplication',
    sparse: true, // Optional - allows backward compatibility
  },
  role: {
    type: String,
    enum: ['seller', 'admin'],
    default: 'seller',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

function encryptTokenFields(doc) {
  for (const field of SENSITIVE_TOKEN_FIELDS) {
    if (doc.isModified(field) && doc[field] && !isEncryptedValue(doc[field])) {
      doc[field] = encryptField(doc[field]);
    }
  }
}

function decryptTokenFields(doc) {
  decryptDocumentFields(doc, SENSITIVE_TOKEN_FIELDS);
}

// Encrypt Amazon tokens at rest before saving.
userSchema.pre('save', function encryptTokens(next) {
  try {
    encryptTokenFields(this);
    next();
  } catch (error) {
    next(error);
  }
});

userSchema.pre('findOneAndUpdate', function encryptTokensOnUpdate(next) {
  try {
    encryptUpdateFields(this.getUpdate(), SENSITIVE_TOKEN_FIELDS);
    next();
  } catch (error) {
    next(error);
  }
});

['find', 'findOne'].forEach((hook) => {
  userSchema.post(hook, function decryptTokens(docs) {
    if (Array.isArray(docs)) {
      docs.forEach(decryptTokenFields);
      return;
    }
    decryptTokenFields(docs);
  });
});

userSchema.post('findOneAndUpdate', function decryptTokens(doc) {
  decryptTokenFields(doc);
});

userSchema.methods.toJSON = function toJSON() {
  const obj = this.toObject();
  for (const field of SENSITIVE_TOKEN_FIELDS) {
    delete obj[field];
  }
  delete obj.password;
  delete obj.amazonOAuthState;
  delete obj.amazonAdsOAuthState;
  return obj;
};

// Hash password before saving
userSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();

  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// Compare password method
userSchema.methods.comparePassword = async function(candidatePassword) {
  return await bcrypt.compare(candidatePassword, this.password);
};

// Update updatedAt on save
userSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

userSchema.index({ amazonSellerId: 1 }, { unique: true, sparse: true });

module.exports = mongoose.model('User', userSchema);
