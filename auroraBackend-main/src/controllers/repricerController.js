const Product = require('../models/Product');
const {
  repriceProduct,
  upsertRepricerConfig,
  bulkConfigureRepricer,
  bulkSetListingPrices,
  getRepricerLogs,
  getRepricerDashboard,
} = require('../services/repricerService');
const { repricerLiveSyncScheduler } = require('../services/repricerLiveSync');

const configureRepricer = async (req, res, next) => {
  try {
    const product = await upsertRepricerConfig(req.user._id, req.params.id, req.body || {});
    if (product.repricer?.enabled) {
      repricerLiveSyncScheduler.registerUser(req.user._id);
    }
    res.status(200).json({ success: true, data: product });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    next(error);
  }
};

const bulkConfigure = async (req, res, next) => {
  try {
    const productIds = req.body?.productIds || req.body?.ids || [];
    const result = await bulkConfigureRepricer(req.user._id, {
      productIds,
      config: req.body?.config || {},
    });
    if (req.body?.config?.enabled) {
      repricerLiveSyncScheduler.registerUser(req.user._id);
    }
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    next(error);
  }
};

const runRepricerForProduct = async (req, res, next) => {
  try {
    const product = await Product.findOne({ _id: req.params.id, sellerId: req.user._id });
    if (!product) {
      return res.status(404).json({ success: false, error: 'Product not found' });
    }

    const result = await repriceProduct(req.user, product, {
      source: 'manual',
      force: true,
      dryRun: req.body?.dryRun,
    });

    const updated = await Product.findById(product._id);
    res.status(200).json({
      success: true,
      data: { product: updated, result },
    });
  } catch (error) {
    next(error);
  }
};

const runRepricerForSeller = async (req, res, next) => {
  try {
    const result = await repricerLiveSyncScheduler.runSyncForUser(req.user._id, 'manual');
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    next(error);
  }
};

const listRepricerLogs = async (req, res, next) => {
  try {
    const result = await getRepricerLogs(req.user._id, {
      productId: req.params.id,
      limit: parseInt(req.query.limit || '50', 10),
      page: parseInt(req.query.page || '1', 10),
    });
    res.status(200).json({
      success: true,
      data: result.logs,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
};

const listAllRepricerLogs = async (req, res, next) => {
  try {
    const result = await getRepricerLogs(req.user._id, {
      limit: parseInt(req.query.limit || '25', 10),
      page: parseInt(req.query.page || '1', 10),
    });
    res.status(200).json({
      success: true,
      data: result.logs,
      pagination: result.pagination,
    });
  } catch (error) {
    next(error);
  }
};

const getDashboard = async (req, res, next) => {
  try {
    const data = await getRepricerDashboard(req.user._id);
    res.status(200).json({ success: true, data });
  } catch (error) {
    next(error);
  }
};

const bulkSetPrice = async (req, res, next) => {
  try {
    const result = await bulkSetListingPrices(req.user, {
      productIds: req.body?.productIds || [],
      amount: req.body?.amount,
      currency: req.body?.currency,
      dryRun: req.body?.dryRun === true,
    });
    res.status(200).json({ success: true, data: result });
  } catch (error) {
    if (error.statusCode) {
      return res.status(error.statusCode).json({ success: false, error: error.message });
    }
    next(error);
  }
};

module.exports = {
  configureRepricer,
  bulkConfigure,
  bulkSetPrice,
  runRepricerForProduct,
  runRepricerForSeller,
  listRepricerLogs,
  listAllRepricerLogs,
  getDashboard,
};
