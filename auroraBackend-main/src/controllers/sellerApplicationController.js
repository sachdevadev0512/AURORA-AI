const SellerApplication = require('../models/SellerApplication');
const Joi = require('joi');

// @desc    Register new seller application
// @route   POST /api/admin/seller-applications
// @access  Private (Admin only)
const createSellerApplication = async (req, res, next) => {
  try {
    const schema = Joi.object({
      organizationName: Joi.string().required().min(3).max(100),
      organizationDescription: Joi.string().optional().max(500),
      amazonClientId: Joi.string().required().min(20),
      amazonClientSecret: Joi.string().required().min(50),
      amazonApplicationId: Joi.string().required().min(20),
      amazonLwaClientId: Joi.string().required().min(20),
      amazonLwaClientSecret: Joi.string().required().min(50),
      redirectUri: Joi.string().uri().required(),
      supportedRegions: Joi.array().items(Joi.string().valid('NA', 'EU', 'FE')).optional(),
    });

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    // Check for duplicate organization
    const existing = await SellerApplication.findOne({ 
      organizationName: value.organizationName 
    });
    if (existing) {
      return res.status(400).json({ error: 'Organization already registered' });
    }

    const sellerApp = new SellerApplication({
      ...value,
      createdBy: req.user._id,
      credentialsVerifiedAt: new Date(),
    });

    await sellerApp.save();

    res.status(201).json({
      success: true,
      message: 'Seller application registered successfully',
      data: {
        id: sellerApp._id,
        organizationName: sellerApp.organizationName,
        supportedRegions: sellerApp.supportedRegions,
        createdAt: sellerApp.createdAt,
      },
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get all seller applications
// @route   GET /api/admin/seller-applications
// @access  Private (Admin only)
const getSellerApplications = async (req, res, next) => {
  try {
    const { isActive = true } = req.query;
    const query = isActive !== 'false' ? { isActive: true } : {};

    const apps = await SellerApplication.find(query)
      .select('organizationName organizationDescription supportedRegions isActive createdAt lastUsedAt credentialsVerifiedAt')
      .sort({ createdAt: -1 });

    res.status(200).json({
      success: true,
      count: apps.length,
      data: apps,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get single seller application
// @route   GET /api/admin/seller-applications/:id
// @access  Private (Admin only)
const getSellerApplication = async (req, res, next) => {
  try {
    const app = await SellerApplication.findById(req.params.id)
      .select('-amazonClientSecret -amazonLwaClientSecret'); // Don't expose secrets

    if (!app) {
      return res.status(404).json({ error: 'Seller application not found' });
    }

    res.status(200).json({
      success: true,
      data: app,
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Update seller application
// @route   PUT /api/admin/seller-applications/:id
// @access  Private (Admin only)
const updateSellerApplication = async (req, res, next) => {
  try {
    const schema = Joi.object({
      organizationName: Joi.string().optional().min(3),
      organizationDescription: Joi.string().optional().max(500),
      supportedRegions: Joi.array().items(Joi.string().valid('NA', 'EU', 'FE')).optional(),
      isActive: Joi.boolean().optional(),
      notes: Joi.string().optional().max(500),
    }).min(1);

    const { error, value } = schema.validate(req.body);
    if (error) {
      return res.status(400).json({ error: error.details[0].message });
    }

    // Check organization name uniqueness if being updated
    if (value.organizationName) {
      const existing = await SellerApplication.findOne({ 
        organizationName: value.organizationName,
        _id: { $ne: req.params.id }
      });
      if (existing) {
        return res.status(400).json({ error: 'Organization name already in use' });
      }
    }
  
    const app = await SellerApplication.findByIdAndUpdate(
      req.params.id,
      value,
      { new: true, runValidators: true }
    ).select('-amazonClientSecret -amazonLwaClientSecret');

    if (!app) {
      return res.status(404).json({ error: 'Seller application not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Seller application updated',
      data: app,    
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Delete (soft-delete) seller application
// @route   DELETE /api/admin/seller-applications/:id
// @access  Private (Admin only)
const deleteSellerApplication = async (req, res, next) => {
  try {
    const app = await SellerApplication.findByIdAndUpdate(
      req.params.id,
      { isActive: false },
      { new: true }
    );

    if (!app) {
      return res.status(404).json({ error: 'Seller application not found' });
    }

    res.status(200).json({
      success: true,
      message: 'Seller application deactivated',
    });
  } catch (error) {
    next(error);
  }
};

// @desc    Get seller applications available for assignment
// @route   GET /api/admin/seller-applications/available
// @access  Private (Admin only)
const getAvailableApplications = async (req, res, next) => {
  try {
    const apps = await SellerApplication.find({ isActive: true })
      .select('_id organizationName supportedRegions');

    res.status(200).json({
      success: true,
      data: apps,
    });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  createSellerApplication,
  getSellerApplications,
  getSellerApplication,
  updateSellerApplication,
  deleteSellerApplication,
  getAvailableApplications,
};
