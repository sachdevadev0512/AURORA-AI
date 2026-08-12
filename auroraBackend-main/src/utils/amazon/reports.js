/** AmazonAPI reports methods (façade mixins). */
const { createAbortError } = require('./abortError');
const { aggregateSalesAndTrafficByAsin: parseSalesAndTrafficByAsin } = require('../salesTrafficWindow');

module.exports = {
  async getReports(reportTypes = null, processingStatuses = null) {
    try {
      const params = {};

      if (reportTypes) params.reportTypes = reportTypes;
      if (processingStatuses) params.processingStatuses = processingStatuses;

      const response = await this.callSpApi({
        operation: 'getReports',
        endpoint: 'reports',
        query: params,
      });

      return response.reports || [];
    } catch (error) {
      console.error('Error fetching reports:', error);
      throw error;
    }
  },

  async createReport(reportType, startDate = null, endDate = null, marketplaceIds = null) {
    try {
      const params = {
        reportType,
        // Prefer a single primary marketplace. Passing every NA participation
        // (MX/CA/BR/…) often yields InvalidInput or FATAL for inventory reports.
        marketplaceIds: marketplaceIds || [this.getMarketplaceId()],
      };

      if (startDate) params.dataStartTime = startDate;
      if (endDate) params.dataEndTime = endDate;

      const response = await this.callSpApi({
        operation: 'createReport',
        endpoint: 'reports',
        body: params,
      });

      return response;
    } catch (error) {
      console.error('Error creating report:', error);
      throw error;
    }
  },

  async waitForReportDocument(reportId, options = {}) {
    const maxAttempts = parseInt(
      options.maxAttempts || process.env.ORDER_REPORT_POLL_MAX_ATTEMPTS || '120',
      10
    );
    const basePollMs = parseInt(
      options.basePollMs || process.env.ORDER_REPORT_POLL_INTERVAL_MS || '5000',
      10
    );

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const aborted = await Promise.resolve(options.shouldAbort?.());
      if (aborted) throw createAbortError();

      const report = await this.getReportById(reportId);
      const statusText = String(report?.processingStatus || '').toUpperCase();

      if (statusText === 'DONE') {
        if (!report?.reportDocumentId) {
          throw new Error(`Report ${reportId} completed without reportDocumentId`);
        }
        return this.getReportDocumentById(report.reportDocumentId);
      }

      if (statusText === 'CANCELLED' || statusText === 'FATAL') {
        throw new Error(`Report ${reportId} ended with status ${statusText}`);
      }

      if (attempt > 0 && attempt % 12 === 0) {
        console.log(`[AmazonAPI] Order report ${reportId} still ${statusText || 'PENDING'} (poll ${attempt})`);
      }

      await this.sleepInterruptible(
        Math.min(15000, basePollMs + Math.floor(attempt / 6) * 1000),
        options.shouldAbort,
      );
    }

    throw new Error(`Timed out waiting for report ${reportId}`);
  },

  async createSalesAndTrafficReport(
    startDate,
    endDate,
    { asinGranularity = 'CHILD', dateGranularity = 'DAY' } = {}
  ) {
    const response = await this.callSpApi({
      operation: 'createReport',
      endpoint: 'reports',
      body: {
        reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
        marketplaceIds: [this.getMarketplaceId()],
        dataStartTime: startDate,
        dataEndTime: endDate,
        reportOptions: { asinGranularity, dateGranularity },
      },
    });
    return response?.reportId || null;
  },

  async getReportById(reportId) {
    return this.callSpApi({
      operation: 'getReport',
      endpoint: 'reports',
      path: { reportId },
    });
  },

  async getReportDocumentById(reportDocumentId) {
    return this.callSpApi({
      operation: 'getReportDocument',
      endpoint: 'reports',
      path: { reportDocumentId },
    });
  },

  async fetchSalesAndTrafficByAsin(startDate, endDate, options = {}) {
    const reportId = await this.createSalesAndTrafficReport(startDate, endDate, options);
    if (!reportId) {
      throw new Error('Sales & Traffic report creation did not return a reportId');
    }

    const maxAttempts = parseInt(process.env.SALES_TRAFFIC_POLL_MAX_ATTEMPTS || '60', 10);
    const basePollMs = parseInt(process.env.SALES_TRAFFIC_POLL_INTERVAL_MS || '5000', 10);

    let reportDocumentId = null;
    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const report = await this.getReportById(reportId);
      const statusText = String(report?.processingStatus || '').toUpperCase();

      if (statusText === 'DONE') {
        reportDocumentId = report.reportDocumentId;
        break;
      }
      if (statusText === 'CANCELLED' || statusText === 'FATAL') {
        throw new Error(`Sales & Traffic report ${reportId} ended with status ${statusText}`);
      }

      await this.sleep(Math.min(15000, basePollMs + Math.floor(attempt / 5) * 1000));
    }

    if (!reportDocumentId) {
      throw new Error(`Timed out waiting for Sales & Traffic report ${reportId}`);
    }

    const documentInfo = await this.getReportDocumentById(reportDocumentId);
    let content = await this.sellingPartner.download(documentInfo, { json: true });
    if (typeof content === 'string') {
      try {
        content = JSON.parse(content);
      } catch (err) {
        throw new Error(`Failed to parse Sales & Traffic report: ${err.message}`);
      }
    }

    return parseSalesAndTrafficByAsin(content);
  },

  aggregateSalesAndTrafficByAsin(report) {
    return parseSalesAndTrafficByAsin(report);
  }
};
