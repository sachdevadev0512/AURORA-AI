const Shipment = require('../models/Shipment');
const {
  resolveLastUpdatedRange,
  mapUiStatusToDbStatuses,
  UI_STATUS_FILTERS,
  toIsoDate,
  buildShipmentDiscrepancies,
} = require('../utils/shipmentParser');
const { buildDelayedShipmentQuery, isShipmentDelayed, daysPastDeliveryWindow } = require('../utils/shipmentDelayUtils');
const {
  sanitizeFbaShipmentName,
  isPlausibleDeliveryDate,
  isPlausibleDeliveryWindow,
  buildSyntheticFbaShipmentName,
} = require('../utils/shipmentParser');
const { buildCaseInsensitiveRegex } = require('../utils/regexSearch');
const { parseExportLimit, exportLimitExceeded, mongoExportLimit } = require('../utils/exportLimits');

function csvEscape(value) {
  const text = value == null ? '' : String(value);
  if (/[",\n\r]/.test(text)) {
    return `"${text.replace(/"/g, '""')}"`;
  }
  return text;
}

function buildShipmentQuery(req) {
  const query = { sellerId: req.user._id };

  if (req.query.type === 'fba_fc' || req.query.type === 'awd_dc') {
    query.shipmentType = req.query.type;
  }

  const statusFilter = req.query.status;
  if (statusFilter) {
    const dbStatuses = mapUiStatusToDbStatuses(statusFilter);
    if (dbStatuses?.length) {
      query.status = { $in: dbStatuses };
    }
  }

  const search = String(req.query.search || '').trim();
  if (search) {
    const regex = buildCaseInsensitiveRegex(search);
    if (regex) {
      query.$or = [
        { shipmentId: regex },
        { referenceId: regex },
        { shipmentName: regex },
        { orderId: regex },
        { trackingId: regex },
      ];
    }
  }

  const lastUpdatedRange = resolveLastUpdatedRange(
    req.query.lastUpdated,
    req.query.startDate,
    req.query.endDate
  );
  if (lastUpdatedRange) {
    query.lastUpdatedDate = lastUpdatedRange;
  }

  if (String(req.query.delayed || '').toLowerCase() === 'true') {
    Object.assign(query, buildDelayedShipmentQuery(req.user._id));
  }

  return query;
}

function formatDeliveryWindowCsv(shipment) {
  if (
    !isPlausibleDeliveryWindow(
      shipment.shipDate,
      shipment.estimatedDeliveryDate,
      shipment.createdDate,
    )
  ) {
    return '';
  }
  const start = toIsoDate(shipment.shipDate);
  const end = toIsoDate(shipment.estimatedDeliveryDate);
  if (start && end) {
    const startDay = start.slice(0, 10);
    const endDay = end.slice(0, 10);
    return startDay === endDay ? startDay : `${startDay} – ${endDay}`;
  }
  return start?.slice(0, 10) || end?.slice(0, 10) || '';
}

function shipmentToCsvRow(shipment, exportType) {
  const isFba = exportType === 'fba_fc' || shipment.shipmentType === 'fba_fc';
  const base = [
    shipment.shipmentType === 'fba_fc' ? 'Fulfilment Center' : 'Distribution Center',
    shipment.shipmentId,
    shipment.referenceId || '',
    sanitizeFbaShipmentName(shipment.shipmentName, shipment.referenceId) || '',
    toIsoDate(shipment.createdDate) || '',
    toIsoDate(shipment.lastUpdatedDate) || '',
    formatDeliveryWindowCsv(shipment),
    shipment.skuCount ?? 0,
  ];

  if (isFba) {
    return [
      ...base,
      shipment.unitsExpected ?? '',
      shipment.unitsLocated ?? '',
      shipment.displayStatus || shipment.status,
      shipment.trackingId || '',
      shipment.hasDiscrepancy ? 'Yes' : 'No',
    ];
  }

  return [
    ...base,
    shipment.boxesExpected ?? '',
    shipment.boxesReceived ?? '',
    shipment.displayStatus || shipment.status,
    shipment.trackingId || '',
    shipment.hasDiscrepancy ? 'Yes' : 'No',
  ];
}

const FBA_CSV_HEADERS = [
  'Shipment Type',
  'Shipment ID',
  'Reference ID',
  'Shipment Name',
  'Created Date',
  'Last Updated Date',
  'Delivery Window',
  'Number of SKUs',
  'Units Expected',
  'Units Located',
  'Shipment Status',
  'Tracking ID',
  'Has Discrepancy',
];

const AWD_CSV_HEADERS = [
  'Shipment Type',
  'Shipment ID',
  'Reference ID',
  'Shipment Name',
  'Created Date',
  'Last Updated Date',
  'Delivery Window',
  'Number of SKUs',
  'Boxes Expected',
  'Boxes Received',
  'Shipment Status',
  'Tracking ID',
  'Has Discrepancy',
];

function getCsvHeaders(exportType) {
  if (exportType === 'fba_fc') return FBA_CSV_HEADERS;
  if (exportType === 'awd_dc') return AWD_CSV_HEADERS;
  return [
    'Shipment Type',
    'Shipment ID',
    'Reference ID',
    'Shipment Name',
    'Created Date',
    'Last Updated Date',
    'Delivery Window',
    'Number of SKUs',
    'Units/Boxes Expected',
    'Units/Boxes Received',
    'Shipment Status',
    'Tracking ID',
    'Has Discrepancy',
  ];
}

function isShipmentListIncomplete(shipment) {
  if (shipment.shipmentType !== 'fba_fc') return false;
  if (shipment.detailsEnrichedAt) return false;
  return shipment.skuCount == null || shipment.skuCount <= 0;
}

function serializeShipment(shipment) {
  const trackingPackages = (shipment.trackingPackages || []).map((pkg) => ({
    boxId: pkg.boxId,
    trackingId: pkg.trackingId,
    carrierName: pkg.carrierName,
    packageStatus: pkg.packageStatus,
  }));
  const discrepancies = buildShipmentDiscrepancies({ ...shipment, trackingPackages });
  const delayed = isShipmentDelayed(shipment);
  const sanitizedName =
    sanitizeFbaShipmentName(shipment.shipmentName, shipment.referenceId) ||
    buildSyntheticFbaShipmentName({
      createdDate: shipment.createdDate,
      destinationCenterId: shipment.destinationCenterId,
    });
  const hasWindow = isPlausibleDeliveryWindow(
    shipment.shipDate,
    shipment.estimatedDeliveryDate,
    shipment.createdDate,
  );
  const shipDate = hasWindow ? shipment.shipDate : null;
  const estimatedDeliveryDate = hasWindow ? shipment.estimatedDeliveryDate : null;

  return {
    ...shipment,
    _id: String(shipment._id),
    shipmentName: sanitizedName,
    trackingUrl: null,
    trackingPackages,
    hasDiscrepancy: discrepancies.length > 0,
    discrepancies,
    isDelayed: delayed || Boolean(shipment.isDelayed),
    daysLate: delayed ? daysPastDeliveryWindow(shipment) : 0,
    lineItems: shipment.lineItems || [],
    createdDate: toIsoDate(shipment.createdDate),
    lastUpdatedDate: toIsoDate(shipment.lastUpdatedDate),
    shipDate: toIsoDate(shipDate),
    estimatedDeliveryDate: toIsoDate(estimatedDeliveryDate),
    lastSynced: toIsoDate(shipment.lastSynced),
    lastTrackedAt: toIsoDate(shipment.lastTrackedAt),
    statusTimeline: (shipment.statusTimeline || []).map((entry) => ({
      ...entry,
      at: toIsoDate(entry.at),
    })),
  };
}

const getShipments = async (req, res, next) => {
  try {
    const { shipmentSyncManager } = require('../services/shipmentSyncService');
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit || '25', 10)));
    const requestedPage = Math.max(1, parseInt(req.query.page || '1', 10));
    const sortBy = req.query.sortBy || 'lastUpdatedDate';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const allowedSortFields = [
      'shipmentId',
      'referenceId',
      'createdDate',
      'lastUpdatedDate',
      'shipDate',
      'skuCount',
      'unitsExpected',
      'unitsLocated',
      'boxesExpected',
      'boxesReceived',
      'status',
      'displayStatus',
    ];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'lastUpdatedDate';

    const query = buildShipmentQuery(req);
    const total = await Shipment.countDocuments(query);
    const pages = Math.max(1, Math.ceil(total / limit));
    const page = Math.min(requestedPage, pages);
    const startIndex = (page - 1) * limit;

    const shipments = await Shipment.find(query)
      .sort({ [sortField]: sortOrder, shipmentId: 1 })
      .skip(startIndex)
      .limit(limit)
      .lean();

    let delayedSummary = null;
    if (String(req.query.includeDelayedSummary || 'true').toLowerCase() !== 'false') {
      const { getDelayedShipmentsSummary } = require('../services/shipmentDelayService');
      delayedSummary = await getDelayedShipmentsSummary(req.user._id, { limit: 5 });
    }

    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(200).json({
      success: true,
      count: shipments.length,
      delayedSummary,
      pagination: {
        page,
        limit,
        total,
        pages,
        from: total === 0 ? 0 : startIndex + 1,
        to: total === 0 ? 0 : Math.min(startIndex + shipments.length, total),
      },
      filters: {
        statusOptions: UI_STATUS_FILTERS,
        lastUpdatedOptions: ['7days', '30days', '3months', '6months', '1year', 'custom'],
      },
      data: shipments.map((shipment) => serializeShipment(shipment)),
    });

    const incompleteIds = shipments
      .filter(isShipmentListIncomplete)
      .slice(0, 8)
      .map((s) => s._id);

    if (
      incompleteIds.length > 0 &&
      req.user?.amazonRefreshToken &&
      !shipmentSyncManager.isSyncActive(req.user._id) &&
      !shipmentSyncManager.isEnrichmentRunning(req.user._id)
    ) {
      shipmentSyncManager.scheduleBackgroundEnrichment(req.user, incompleteIds);
    }
  } catch (error) {
    next(error);
  }
};

const getShipment = async (req, res, next) => {
  try {
    let shipment = await Shipment.findOne({
      _id: req.params.id,
      sellerId: req.user._id,
    });

    if (!shipment) {
      return res.status(404).json({ success: false, error: 'Shipment not found' });
    }

    if (req.user?.amazonRefreshToken) {
      const { refreshShipmentTracking } = require('../services/shipmentTrackingService');
      const AmazonAPI = require('../utils/amazonAPI');
      const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
      try {
        const sellerAppCredentials = await getSellerAppCredentials(req.user);
        const amazonAPI = new AmazonAPI(req.user, sellerAppCredentials);
        shipment = await refreshShipmentTracking(req.user, shipment, amazonAPI, { forceEmit: false });
      } catch (trackErr) {
        console.warn(`[ShipmentTracking] Detail refresh ${shipment.shipmentId}:`, trackErr.message);
      }
    }

    res.status(200).json({
      success: true,
      data: serializeShipment(shipment.toObject ? shipment.toObject() : shipment),
    });
  } catch (error) {
    next(error);
  }
};

const refreshShipmentTrackingNow = async (req, res, next) => {
  try {
    const { refreshShipmentTrackingById } = require('../services/shipmentTrackingService');
    const updated = await refreshShipmentTrackingById(req.user, req.params.id, { forceEmit: true });
    if (!updated) {
      return res.status(404).json({ success: false, error: 'Shipment not found' });
    }

    res.status(200).json({
      success: true,
      data: serializeShipment(updated.toObject ? updated.toObject() : updated),
    });
  } catch (error) {
    if (error.code === 'SP_NOT_CONNECTED') {
      return res.status(400).json({ success: false, error: error.message });
    }
    next(error);
  }
};

const syncShipments = async (req, res, next) => {
  try {
    const { shipmentSyncManager } = require('../services/shipmentSyncService');
    const result = await shipmentSyncManager.start(req.user._id);
    res.status(202).json(result);
  } catch (error) {
    if (error.code === 'SP_NOT_CONNECTED') {
      return res.status(400).json({ success: false, error: error.message });
    }
    next(error);
  }
};

const getShipmentSyncStatus = async (req, res, next) => {
  try {
    const { shipmentSyncManager } = require('../services/shipmentSyncService');
    const status = await shipmentSyncManager.getStatus(req.user._id);
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.status(200).json({ success: true, ...status });
  } catch (error) {
    next(error);
  }
};

const stopShipmentSync = async (req, res, next) => {
  try {
    const { shipmentSyncManager } = require('../services/shipmentSyncService');
    const result = await shipmentSyncManager.stop(req.user._id);
    res.status(200).json(result);
  } catch (error) {
    next(error);
  }
};

const exportShipments = async (req, res, next) => {
  try {
    const query = buildShipmentQuery(req);
    const sortBy = req.query.sortBy || 'lastUpdatedDate';
    const sortOrder = req.query.sortOrder === 'asc' ? 1 : -1;
    const allowedSortFields = [
      'shipmentId',
      'referenceId',
      'createdDate',
      'lastUpdatedDate',
      'shipDate',
      'skuCount',
      'unitsExpected',
      'unitsLocated',
      'boxesExpected',
      'boxesReceived',
      'status',
      'displayStatus',
    ];
    const sortField = allowedSortFields.includes(sortBy) ? sortBy : 'lastUpdatedDate';

    const exportLimit = parseExportLimit(
      process.env.SHIPMENT_EXPORT_MAX_ROWS || process.env.EXPORT_MAX_ROWS,
      0,
    );

    let shipmentQuery = Shipment.find(query).sort({ [sortField]: sortOrder, shipmentId: 1 });
    const mongoLimit = mongoExportLimit(exportLimit);
    if (mongoLimit > 0) {
      shipmentQuery = shipmentQuery.limit(mongoLimit);
    }
    const shipments = await shipmentQuery.lean();

    if (exportLimitExceeded(shipments.length, exportLimit)) {
      return res.status(400).json({
        success: false,
        error: `Export would include ${shipments.length} shipment(s), which exceeds the limit of ${exportLimit}. Narrow your filters or raise SHIPMENT_EXPORT_MAX_ROWS.`,
      });
    }

    if (shipments.length === 0) {
      return res.status(404).json({
        success: false,
        error: 'No shipments available to export for the current filters.',
      });
    }

    const exportType =
      req.query.type === 'fba_fc' || req.query.type === 'awd_dc' ? req.query.type : null;
    const headers = getCsvHeaders(exportType);
    const csvRows = shipments.map((shipment) =>
      shipmentToCsvRow(shipment, exportType).map(csvEscape).join(','),
    );
    const csvContent = [headers.map(csvEscape).join(','), ...csvRows].join('\n');

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader(
      'Content-Disposition',
      `attachment; filename=shipments-report-${new Date().toISOString().split('T')[0]}.csv`
    );
    res.status(200).send(csvContent);
  } catch (error) {
    next(error);
  }
};

const getDelayedShipmentsSummary = async (req, res, next) => {
  try {
    const { getDelayedShipmentsSummary: fetchSummary } = require('../services/shipmentDelayService');
    const limit = Math.min(25, Math.max(1, parseInt(req.query.limit || '10', 10)));
    const summary = await fetchSummary(req.user._id, { limit });
    res.status(200).json({ success: true, data: summary });
  } catch (error) {
    next(error);
  }
};

module.exports = {
  getShipments,
  getDelayedShipmentsSummary,
  getShipment,
  refreshShipmentTrackingNow,
  syncShipments,
  getShipmentSyncStatus,
  stopShipmentSync,
  exportShipments,
};
