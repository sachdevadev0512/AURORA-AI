const mongoose = require('mongoose');
const {
  encryptSellerAppCredential,
  decryptSellerAppCredential,
  isSellerAppEncryptedValue,
} = require('../utils/sellerAppEncryption');

const sellerApplicationSchema = new mongoose.Schema({
  // Organization/Seller Info
  organizationName: {
    type: String,
    required: true,
    trim: true,
    unique: true, // One app per organization
  },
  organizationDescription: {
    type: String,
    trim: true,
  },

  // Amazon OAuth Credentials (Encrypted)
  amazonClientId: {
    type: String,
    required: true,
  },
  amazonClientSecret: {
    type: String,
    required: true,
  },
  amazonApplicationId: {
    type: String,
    required: true,
  },

  // Amazon LWA Credentials (for SP-API)
  amazonLwaClientId: {
    type: String,
    required: true,
  },
  amazonLwaClientSecret: {
    type: String,
    required: true,
  },

  // Redirect URI
  redirectUri: {
    type: String,
    required: true,
    default: () => process.env.AMAZON_REDIRECT_URI,
  },

  // Supported Regions/Marketplaces
  supportedRegions: {
    type: [String],
    enum: ['NA', 'EU', 'FE'],
    default: ['NA'],
  },

  // Status & Metadata
  isActive: {
    type: Boolean,
    default: true,
  },
  createdBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  lastUsedAt: {
    type: Date,
    sparse: true,
  },
  credentialsVerifiedAt: {
    type: Date,
    sparse: true,
  },
  notes: {
    type: String,
    trim: true,
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

sellerApplicationSchema.pre('save', function encryptCredentials(next) {
  try {
    if (this.isModified('amazonClientId')) {
      this.amazonClientId = encryptSellerAppCredential(this.amazonClientId);
    }
    if (this.isModified('amazonClientSecret')) {
      this.amazonClientSecret = encryptSellerAppCredential(this.amazonClientSecret);
    }
    if (this.isModified('amazonApplicationId')) {
      this.amazonApplicationId = encryptSellerAppCredential(this.amazonApplicationId);
    }
    if (this.isModified('amazonLwaClientId')) {
      this.amazonLwaClientId = encryptSellerAppCredential(this.amazonLwaClientId);
    }
    if (this.isModified('amazonLwaClientSecret')) {
      this.amazonLwaClientSecret = encryptSellerAppCredential(this.amazonLwaClientSecret);
    }
    this.updatedAt = new Date();
    next();
  } catch (error) {
    next(error);
  }
});

// Post-fetch hook: Decrypt sensitive fields
sellerApplicationSchema.post('findOne', decryptFields);
sellerApplicationSchema.post('find', function(docs) {
  if (Array.isArray(docs)) {
    docs.forEach(decryptFields);
  } else {
    decryptFields(docs);
  }
});

// Instance methods
sellerApplicationSchema.methods.getDecrypted = function() {
  return {
    amazonClientId: this.amazonClientId,
    amazonClientSecret: this.amazonClientSecret,
    amazonApplicationId: this.amazonApplicationId,
    amazonLwaClientId: this.amazonLwaClientId,
    amazonLwaClientSecret: this.amazonLwaClientSecret,
    redirectUri: this.redirectUri,
  };
};

sellerApplicationSchema.methods.toJSON = function() {
  const obj = this.toObject();
  // Never expose secrets in JSON
  delete obj.amazonClientSecret;
  delete obj.amazonLwaClientSecret;
  // Mask IDs
  obj.amazonClientId = obj.amazonClientId ? obj.amazonClientId.substring(0, 20) + '...' : null;
  obj.amazonApplicationId = obj.amazonApplicationId ? obj.amazonApplicationId.substring(0, 20) + '...' : null;
  obj.amazonLwaClientId = obj.amazonLwaClientId ? obj.amazonLwaClientId.substring(0, 20) + '...' : null;
  return obj;
};

function decryptFields(doc) {
  if (!doc) return;

  const fields = [
    'amazonClientId',
    'amazonClientSecret',
    'amazonApplicationId',
    'amazonLwaClientId',
    'amazonLwaClientSecret',
  ];

  for (const field of fields) {
    if (doc[field] && isSellerAppEncryptedValue(doc[field])) {
      doc[field] = decryptSellerAppCredential(doc[field]);
    }
  }
}

module.exports = mongoose.model('SellerApplication', sellerApplicationSchema);
