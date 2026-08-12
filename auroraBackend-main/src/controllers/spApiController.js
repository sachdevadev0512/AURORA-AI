const {
  Joi,
  requireAmazonRefreshToken,
  validateWithJoi,
  createAmazonClientForUser,
  apiFailure,
} = require('../utils/spApiRequest');

const financialEventsSchema = Joi.object({
  startDate: Joi.date().iso().required(),
  endDate: Joi.date().iso().greater(Joi.ref('startDate')).optional(),
});

const reportsQuerySchema = Joi.object({
  reportTypes: Joi.array().items(Joi.string()).optional(),
  processingStatuses: Joi.array().items(Joi.string()).optional(),
});

const createReportSchema = Joi.object({
  reportType: Joi.string().required(),
  startDate: Joi.date().iso().optional(),
  endDate: Joi.date().iso().optional(),
});

const getSellerPerformance = async (req, res, next) => {
  try {
    const missing = requireAmazonRefreshToken(req.user);
    if (missing) return res.status(missing.status).json(missing.body);

    const amazonAPI = await createAmazonClientForUser(req.user);

    try {
      const performance = await amazonAPI.getSellerPerformance();
      res.status(200).json({ success: true, data: performance });
    } catch (apiError) {
      console.error('SP-API performance error:', apiError);
      const failure = apiFailure('Failed to fetch seller performance data', apiError);
      return res.status(failure.status).json(failure.body);
    }
  } catch (error) {
    next(error);
  }
};

const getFinancialEvents = async (req, res, next) => {
  try {
    const missing = requireAmazonRefreshToken(req.user);
    if (missing) return res.status(missing.status).json(missing.body);

    const validated = validateWithJoi(financialEventsSchema, req.query);
    if (validated.error) {
      return res.status(validated.error.status).json(validated.error.body);
    }

    const { startDate, endDate } = req.query;
    const amazonAPI = await createAmazonClientForUser(req.user);

    try {
      const financialEvents = await amazonAPI.getFinancialEvents(startDate, endDate);
      res.status(200).json({ success: true, data: financialEvents });
    } catch (apiError) {
      console.error('SP-API financial events error:', apiError);
      const failure = apiFailure('Failed to fetch financial events', apiError);
      return res.status(failure.status).json(failure.body);
    }
  } catch (error) {
    next(error);
  }
};

const getReports = async (req, res, next) => {
  try {
    const missing = requireAmazonRefreshToken(req.user);
    if (missing) return res.status(missing.status).json(missing.body);

    const validated = validateWithJoi(reportsQuerySchema, req.query);
    if (validated.error) {
      return res.status(validated.error.status).json(validated.error.body);
    }

    const { reportTypes, processingStatuses } = req.query;
    const amazonAPI = await createAmazonClientForUser(req.user);

    try {
      const reports = await amazonAPI.getReports(reportTypes, processingStatuses);
      res.status(200).json({ success: true, data: reports });
    } catch (apiError) {
      console.error('SP-API reports error:', apiError);
      const failure = apiFailure('Failed to fetch reports', apiError);
      return res.status(failure.status).json(failure.body);
    }
  } catch (error) {
    next(error);
  }
};

const createReport = async (req, res, next) => {
  try {
    const missing = requireAmazonRefreshToken(req.user);
    if (missing) return res.status(missing.status).json(missing.body);

    const validated = validateWithJoi(createReportSchema, req.body);
    if (validated.error) {
      return res.status(validated.error.status).json(validated.error.body);
    }

    const { reportType, startDate, endDate } = req.body;
    const amazonAPI = await createAmazonClientForUser(req.user);

    try {
      const report = await amazonAPI.createReport(reportType, startDate, endDate);
      res.status(201).json({ success: true, data: report });
    } catch (apiError) {
      console.error('SP-API create report error:', apiError);
      const failure = apiFailure('Failed to create report', apiError);
      return res.status(failure.status).json(failure.body);
    }
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getSellerPerformance,
  getFinancialEvents,
  getReports,
  createReport,
};
