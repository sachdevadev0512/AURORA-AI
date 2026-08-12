const Shipment = require('../models/Shipment');
const ShipmentSyncJob = require('../models/ShipmentSyncJob');
const User = require('../models/User');
const AmazonAPI = require('../utils/amazonAPI');
const { getSellerAppCredentials } = require('../utils/sellerAppHelper');
const {
  parseFbaShipment,
  parseAwdShipment,
  isFbaShipmentName,
  sanitizeFbaShipmentName,
  looksLikeAmazonReferenceId,
  isPlausibleDeliveryDate,
  isPlausibleDeliveryWindow,
  normalizeDate,
  pickLatestDate,
  parseDateFromShipmentName,
  resolveFbaCreatedDate,
  resolveFbaLastUpdatedDate,
} = require('../utils/shipmentParser');
const { emitShipmentTrackingUpdate } = require('./shipmentTrackingService');
const { mergeTrackingFields } = require('../utils/shipmentTrackingParser');

const ITEM_DELAY_MS = Math.max(0, parseInt(process.env.SHIPMENT_SYNC_ITEM_DELAY_MS || '50', 10));
// Fetch SKU counts, units, ship dates, and tracking during sync (opt out with SHIPMENT_SYNC_ENRICH_ITEMS=false).
const ENRICH_ITEMS_IN_SYNC = process.env.SHIPMENT_SYNC_ENRICH_ITEMS !== 'false';
const STOPPING_STALE_MS = Math.max(15000, parseInt(process.env.SHIPMENT_SYNC_STOPPING_STALE_MS || '45000', 10));
// Amazon DATE_RANGE queries allow at most 180 days between LastUpdatedAfter/Before.
const LOOKBACK_DAYS = Math.min(
  1095,
  Math.max(30, parseInt(process.env.SHIPMENT_SYNC_LOOKBACK_DAYS || '730', 10)),
);
const MAX_DATE_WINDOW_DAYS = 180;
const STALE_JOB_MS = Math.max(60000, parseInt(process.env.SHIPMENT_SYNC_STALE_MS || '300000', 10));
const FBA_SHIPMENT_STATUSES = [
  'WORKING',
  'SHIPPED',
  'RECEIVING',
  'CANCELLED',
  'DELETED',
  'CLOSED',
  'ERROR',
  'IN_TRANSIT',
  'DELIVERED',
  'CHECKED_IN',
];

const { sleep } = require('../utils/async');
const { emitToUser } = require('../utils/socketEmit');

function buildDateWindows(lookbackDays) {
  const windows = [];
  const end = new Date();
  let remaining = lookbackDays;
  let windowEnd = new Date(end);

  while (remaining > 0) {
    const chunkDays = Math.min(remaining, MAX_DATE_WINDOW_DAYS);
    const windowStart = new Date(windowEnd);
    windowStart.setDate(windowStart.getDate() - chunkDays);
    windows.push({ start: new Date(windowStart), end: new Date(windowEnd) });
    windowEnd = new Date(windowStart);
    remaining -= chunkDays;
  }

  return windows;
}

async function fetchAllFbaShipmentItems(amazonAPI, shipmentId, shouldAbort) {
  if (shouldAbort?.()) return [];
  if (typeof amazonAPI.getAllFbaShipmentItems === 'function') {
    return amazonAPI.getAllFbaShipmentItems(shipmentId);
  }
  const { items } = await amazonAPI.getFbaShipmentItems(shipmentId);
  return items || [];
}

class ShipmentSyncManager {
  constructor() {
    this.activeJobs = new Map();
    this.backgroundEnrichment = new Map();
    this.recentListEnrichment = new Map();
  }

  isEnrichmentRunning(userId) {
    return this.backgroundEnrichment.has(String(userId));
  }

  isSyncActive(userId) {
    return this.activeJobs.has(String(userId));
  }

  async enrichShipmentRecords(user, amazonAPI, shipmentDocs, options = {}) {
    const { refreshShipmentTracking } = require('./shipmentTrackingService');
    const shouldAbort = options.shouldAbort || (() => false);
    let enriched = 0;
    let failed = 0;

    for (const shipment of shipmentDocs) {
      if (shouldAbort()) break;
      if (!shipment) continue;

      try {
        await refreshShipmentTracking(user, shipment, amazonAPI, {
          forceEmit: options.forceEmit ?? false,
        });
        enriched += 1;
      } catch (err) {
        failed += 1;
        console.warn(`[ShipmentSync] Enrich ${shipment.shipmentId}:`, err.message);
      }

      if (ITEM_DELAY_MS > 0) await sleep(ITEM_DELAY_MS);
    }

    return { enriched, failed };
  }

  async enrichIncompleteFbaShipments(user, amazonAPI, jobId, counters) {
    const incomplete = await Shipment.find({
      sellerId: user._id,
      shipmentType: 'fba_fc',
      detailsEnrichedAt: null,
      skuCount: { $lte: 0 },
    }).select('_id shipmentId');

    if (!incomplete.length || this.shouldStop(user._id)) {
      return counters;
    }

    await this.reportProgress(
      user._id,
      jobId,
      'fba_fc_details',
      counters,
      `Enriching ${incomplete.length} shipment(s) with SKU and tracking data…`,
    );

    const docs = [];
    for (const row of incomplete) {
      const doc = await Shipment.findById(row._id);
      if (doc) docs.push(doc);
    }

    const { enriched, failed } = await this.enrichShipmentRecords(user, amazonAPI, docs, {
      shouldAbort: () => this.shouldStop(user._id),
      forceEmit: false,
    });

    return {
      processed: counters.processed,
      saved: counters.saved + enriched,
      failed: counters.failed + failed,
    };
  }

  scheduleBackgroundEnrichment(user, shipmentDbIds = []) {
    const userKey = String(user._id);
    if (!shipmentDbIds.length || this.isEnrichmentRunning(userKey) || this.isSyncActive(userKey)) {
      return;
    }

    const cooldownMs = 5 * 60 * 1000;
    const now = Date.now();
    const eligibleIds = shipmentDbIds.filter((id) => {
      const key = String(id);
      const lastAt = this.recentListEnrichment.get(key);
      return !lastAt || now - lastAt > cooldownMs;
    });

    if (!eligibleIds.length) return;

    for (const id of eligibleIds) {
      this.recentListEnrichment.set(String(id), now);
    }

    this.backgroundEnrichment.set(userKey, true);
    setImmediate(async () => {
      try {
        const sellerAppCredentials = await getSellerAppCredentials(user);
        const amazonAPI = new AmazonAPI(user, sellerAppCredentials);
        const shipments = await Shipment.find({
          _id: { $in: eligibleIds },
          sellerId: user._id,
          shipmentType: 'fba_fc',
          detailsEnrichedAt: null,
          skuCount: { $lte: 0 },
        });

        if (shipments.length) {
          await this.enrichShipmentRecords(user, amazonAPI, shipments, { forceEmit: false });
        }
      } catch (err) {
        console.warn('[ShipmentSync] Background list enrichment failed:', err.message);
      } finally {
        this.backgroundEnrichment.delete(userKey);
      }
    });
  }

  async getUserForSync(userId) {
    const user = await User.findById(userId);
    if (!user) {
      const error = new Error('User not found');
      error.code = 'USER_NOT_FOUND';
      throw error;
    }
    if (!user.amazonRefreshToken) {
      const error = new Error('Amazon Selling Partner account is not connected.');
      error.code = 'SP_NOT_CONNECTED';
      throw error;
    }
    return user;
  }

  async recoverJobsOnStartup() {
    const result = await ShipmentSyncJob.updateMany(
      { status: { $in: ['RUNNING', 'STOPPING'] } },
      {
        $set: {
          status: 'STOPPED',
          message: 'Sync interrupted by server restart.',
          completedAt: new Date(),
          updatedAt: new Date(),
        },
      },
    );

    if (result.modifiedCount > 0) {
      console.log(`[ShipmentSync] Cleared ${result.modifiedCount} interrupted job(s) on startup`);
    }
  }

  async finalizeStaleJob(job) {
    await ShipmentSyncJob.findByIdAndUpdate(job._id, {
      status: 'STOPPED',
      message: 'Sync no longer active.',
      completedAt: new Date(),
      updatedAt: new Date(),
    });
  }

  async getStatus(userId) {
    const job = await ShipmentSyncJob.findOne({
      sellerId: userId,
      status: { $in: ['RUNNING', 'STOPPING'] },
    }).sort({ startedAt: -1 });

    if (!job) {
      return {
        syncing: false,
        processed: 0,
        saved: 0,
        failed: 0,
        phase: null,
        message: null,
      };
    }

    const userKey = String(userId);
    const hasWorker = this.activeJobs.has(userKey);
    const idleMs = Date.now() - new Date(job.updatedAt).getTime();

    if (!hasWorker && idleMs > STALE_JOB_MS) {
      await this.finalizeStaleJob(job);
      return {
        syncing: false,
        processed: job.processed,
        saved: job.saved,
        failed: job.failed,
        phase: null,
        message: 'Previous sync was interrupted.',
      };
    }

    if (job.status === 'STOPPING' && idleMs > STOPPING_STALE_MS) {
      await ShipmentSyncJob.findByIdAndUpdate(job._id, {
        status: 'STOPPED',
        message: `Shipment sync stopped. Saved ${job.saved} shipment(s).`,
        completedAt: new Date(),
        updatedAt: new Date(),
      });
      this.activeJobs.delete(userKey);
      emitToUser(userId, 'shipmentSyncStopped', {
        event: 'SHIPMENT_SYNC_STOPPED',
        processed: job.processed,
        saved: job.saved,
        failed: job.failed,
        message: `Shipment sync stopped. Saved ${job.saved} shipment(s).`,
      });
      return {
        syncing: false,
        stopping: false,
        processed: job.processed,
        saved: job.saved,
        failed: job.failed,
        phase: null,
        message: `Shipment sync stopped. Saved ${job.saved} shipment(s).`,
      };
    }

    return {
      syncing: true,
      stopping: job.status === 'STOPPING',
      processed: job.processed,
      saved: job.saved,
      failed: job.failed,
      phase: job.phase,
      message: job.message,
      stopRequested: job.stopRequested,
    };
  }

  async start(userId) {
    const userKey = String(userId);
    let existing = await ShipmentSyncJob.findOne({
      sellerId: userId,
      status: { $in: ['RUNNING', 'STOPPING'] },
    });

    if (existing) {
      const hasWorker = this.activeJobs.has(userKey);
      const idleMs = Date.now() - new Date(existing.updatedAt).getTime();

      if (!hasWorker || (existing.status === 'STOPPING' && idleMs > STOPPING_STALE_MS)) {
        await ShipmentSyncJob.findByIdAndUpdate(existing._id, {
          status: 'STOPPED',
          message: 'Previous sync cleared.',
          completedAt: new Date(),
          updatedAt: new Date(),
        });
        this.activeJobs.delete(userKey);
        existing = null;
      }
    }

    if (existing) {
      return {
        success: true,
        message: 'Shipment sync already in progress.',
        syncing: true,
        jobId: existing._id,
      };
    }

    const job = await ShipmentSyncJob.create({
      sellerId: userId,
      status: 'RUNNING',
      phase: 'starting',
      message: 'Shipment sync started.',
    });

    this.activeJobs.set(String(userId), { stopRequested: false });

    setImmediate(() => {
      this.runSync(userId, job._id).catch((err) => {
        console.error('[ShipmentSync] Background sync failed:', err.message);
      });
    });

    return {
      success: true,
      message: 'Shipment sync started.',
      syncing: true,
      jobId: job._id,
    };
  }

  async stop(userId) {
    const userKey = String(userId);
    const active = this.activeJobs.get(userKey);
    if (active) active.stopRequested = true;

    let job = await ShipmentSyncJob.findOneAndUpdate(
      { sellerId: userId, status: 'RUNNING' },
      { stopRequested: true, status: 'STOPPING', message: 'Stop requested…' },
      { new: true },
    );

    if (!job) {
      job = await ShipmentSyncJob.findOne({
        sellerId: userId,
        status: 'STOPPING',
      });

      if (!job) {
        return { success: true, message: 'No active shipment sync to stop.', syncing: false };
      }

      if (!this.activeJobs.has(userKey)) {
        await ShipmentSyncJob.findByIdAndUpdate(job._id, {
          status: 'STOPPED',
          message: 'Shipment sync stopped.',
          completedAt: new Date(),
          updatedAt: new Date(),
        });
        emitToUser(userId, 'shipmentSyncStopped', {
          event: 'SHIPMENT_SYNC_STOPPED',
          message: 'Shipment sync stopped.',
        });
        return { success: true, message: 'Shipment sync stopped.', syncing: false };
      }

      return { success: true, message: 'Stop already requested.', syncing: true };
    }

    emitToUser(userId, 'shipmentSyncStatus', {
      event: 'SHIPMENT_SYNC_STOPPING',
      message: 'Stopping shipment sync…',
    });

    return { success: true, message: 'Shipment sync stop requested.', syncing: true };
  }

  shouldStop(userId) {
    const active = this.activeJobs.get(String(userId));
    return Boolean(active?.stopRequested);
  }

  async updateJob(jobId, patch) {
    if (!jobId) return null;
    return ShipmentSyncJob.findByIdAndUpdate(
      jobId,
      { ...patch, updatedAt: new Date() },
      { new: true }
    );
  }

  async upsertShipment(sellerId, doc) {
    return Shipment.findOneAndUpdate(
      {
        sellerId,
        shipmentType: doc.shipmentType,
        shipmentId: doc.shipmentId,
      },
      { $set: { ...doc, sellerId } },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
  }

  async loadExistingFbaMap(userId, shipmentInfos) {
    const ids = shipmentInfos
      .map((s) => s.ShipmentId || s.shipmentId)
      .filter(Boolean);
    if (!ids.length) return new Map();

    const rows = await Shipment.find({
      sellerId: userId,
      shipmentType: 'fba_fc',
      shipmentId: { $in: ids },
    }).lean();

    return new Map(rows.map((row) => [row.shipmentId, row]));
  }

  async saveFbaListBatch(userId, shipmentInfos, existingMap) {
    if (!shipmentInfos.length) return 0;

    const ops = [];
    for (const shipmentInfo of shipmentInfos) {
      const shipmentId = shipmentInfo.ShipmentId || shipmentInfo.shipmentId;
      if (!shipmentId) continue;

      const existing = existingMap.get(shipmentId) || null;
      const doc = parseFbaShipment(shipmentInfo, [], existing, { fromAmazonList: true });
      const {
        referenceId,
        createdDate,
        lastUpdatedDate,
        inboundPlanId,
        metadata,
        ...listFields
      } = doc;

      const setFields = { ...listFields, sellerId: userId };
      // Prefer a fresh Amazon SC title when present; otherwise keep an existing clean name.
      const existingClean = sanitizeFbaShipmentName(
        existing?.shipmentName,
        existing?.referenceId || referenceId,
      );
      const nextName = sanitizeFbaShipmentName(
        doc.shipmentName,
        referenceId || existing?.referenceId,
      );
      if (nextName && isFbaShipmentName(nextName)) {
        setFields.shipmentName = nextName;
      } else if (existingClean) {
        setFields.shipmentName = existingClean;
      } else if (nextName) {
        setFields.shipmentName = nextName;
      } else {
        delete setFields.shipmentName;
      }
      if (referenceId && !isFbaShipmentName(referenceId)) {
        setFields.referenceId = referenceId;
      } else if (existing?.referenceId && !isFbaShipmentName(existing.referenceId)) {
        setFields.referenceId = existing.referenceId;
      }
      if (
        existing?.shipDate &&
        existing?.estimatedDeliveryDate &&
        isPlausibleDeliveryWindow(
          existing.shipDate,
          existing.estimatedDeliveryDate,
          existing.createdDate || createdDate,
        )
      ) {
        setFields.shipDate = existing.shipDate;
        setFields.estimatedDeliveryDate = existing.estimatedDeliveryDate;
      } else if (
        doc.shipDate &&
        doc.estimatedDeliveryDate &&
        isPlausibleDeliveryWindow(doc.shipDate, doc.estimatedDeliveryDate, createdDate)
      ) {
        setFields.shipDate = doc.shipDate;
        setFields.estimatedDeliveryDate = doc.estimatedDeliveryDate;
      } else {
        delete setFields.shipDate;
        delete setFields.estimatedDeliveryDate;
      }
      // Created: SC title clock wins (never freeze an older plan createdAt forever).
      const nextCreated = resolveFbaCreatedDate({
        shipmentName: setFields.shipmentName || doc.shipmentName || existing?.shipmentName,
        existingName: existing?.shipmentName,
        amazonCreated: createdDate,
        existingCreated: existing?.createdDate,
        existing,
      });
      if (nextCreated) setFields.createdDate = nextCreated;
      else delete setFields.createdDate;

      const nextLastUpdated = resolveFbaLastUpdatedDate({
        amazonLastUpdated: lastUpdatedDate,
        existingLastUpdated: existing?.lastUpdatedDate,
        createdDate: nextCreated || createdDate,
        existing,
      });
      if (nextLastUpdated) setFields.lastUpdatedDate = nextLastUpdated;
      if (existing?.inboundPlanId || inboundPlanId) {
        setFields.inboundPlanId = existing?.inboundPlanId || inboundPlanId;
      }
      if (existing?.metadata?.v2024ShipmentId || metadata?.v2024ShipmentId) {
        setFields.metadata = {
          ...(metadata || {}),
          ...(existing?.metadata || {}),
          v2024ShipmentId:
            existing?.metadata?.v2024ShipmentId || metadata?.v2024ShipmentId || null,
        };
      }

      ops.push({
        updateOne: {
          filter: { sellerId: userId, shipmentType: 'fba_fc', shipmentId },
          update: { $set: setFields },
          upsert: true,
        },
      });
    }

    if (!ops.length) return 0;
    await Shipment.bulkWrite(ops, { ordered: false });
    return ops.length;
  }

  /**
   * Resolve Amazon reference ID + plan Created/Last updated from inbound plans.
   */
  async applyFbaAmazonReferenceIds(user, amazonAPI, jobId, counters) {
    const targetRows = await Shipment.find({
      sellerId: user._id,
      shipmentType: 'fba_fc',
    })
      .select('shipmentId')
      .lean();
    if (!targetRows.length) return counters;

    const targetSet = new Set(targetRows.map((row) => row.shipmentId));
    const initialTargets = targetSet.size;
    await this.reportProgress(
      user._id,
      jobId,
      'fba_fc_reference_ids',
      counters,
      `Resolving Amazon reference IDs and dates for ${initialTargets} shipment(s)…`,
    );

    const { parseFbaV2024Shipment } = require('../utils/shipmentTrackingParser');
    const statuses = ['SHIPPED', 'ACTIVE', 'VOIDED', undefined];
    const seenPlans = new Set();
    let updated = 0;
    const maxPagesPerStatus = 40;

    for (const status of statuses) {
      if (this.shouldStop(user._id) || targetSet.size === 0) break;
      let nextToken = null;
      let pages = 0;
      do {
        if (this.shouldStop(user._id) || targetSet.size === 0) break;
        let page;
        try {
          page = await amazonAPI.listFbaInboundPlans({
            nextToken,
            status,
            sortBy: 'LAST_UPDATED_TIME',
          });
        } catch (err) {
          console.warn(`[ShipmentSync] listInboundPlans(${status}):`, err.message);
          break;
        }

        for (const plan of page.plans || []) {
          if (this.shouldStop(user._id) || targetSet.size === 0) break;
          const planId = plan.inboundPlanId;
          if (!planId || seenPlans.has(planId)) continue;
          seenPlans.add(planId);

          const planCreated = normalizeDate(plan.createdAt || plan.creationDate);
          const planUpdated = normalizeDate(plan.lastUpdatedAt || plan.updatedAt);
          let detail;
          try {
            detail = await amazonAPI.getFbaInboundPlan(planId);
          } catch {
            continue;
          }

          for (const entry of detail?.shipments || detail?.inboundShipments || []) {
            if (this.shouldStop(user._id) || targetSet.size === 0) break;
            const v2024ShipmentId = entry.shipmentId;
            if (!v2024ShipmentId) continue;

            let shipmentDetail;
            try {
              shipmentDetail = await amazonAPI.getFbaInboundShipmentV2024(
                planId,
                v2024ShipmentId,
              );
            } catch {
              continue;
            }

            const parsed = parseFbaV2024Shipment({
              ...shipmentDetail,
              inboundPlanId: planId,
            });
            const confirmationId = parsed.shipmentConfirmationId;
            if (!confirmationId || !targetSet.has(confirmationId)) continue;

            const amazonReferenceId =
              parsed.referenceId && !isFbaShipmentName(parsed.referenceId)
                ? parsed.referenceId
                : null;
            const shipmentName = sanitizeFbaShipmentName(
              parsed.shipmentName || plan.name,
              amazonReferenceId,
            );

            const setFields = {
              inboundPlanId: planId,
              'metadata.v2024ShipmentId': parsed.v2024ShipmentId || v2024ShipmentId,
            };
            if (amazonReferenceId) setFields.referenceId = amazonReferenceId;
            // Only set when we have a real SC title — never blank out a good name with null.
            if (shipmentName) {
              setFields.shipmentName = shipmentName;
            }
            const nameCreated = parseDateFromShipmentName(shipmentName);
            const createdDate = resolveFbaCreatedDate({
              shipmentName,
              amazonCreated: normalizeDate(parsed.createdDate) || planCreated,
            });
            const lastUpdatedDate = resolveFbaLastUpdatedDate({
              amazonLastUpdated: normalizeDate(parsed.lastUpdatedDate) || planUpdated,
              createdDate,
            });
            if (createdDate) setFields.createdDate = createdDate;
            if (lastUpdatedDate) setFields.lastUpdatedDate = lastUpdatedDate;

            // Seller Central "Delivery window" = selectedDeliveryWindow start/end.
            // Do not gate on createdDate — Amazon's confirmed window is authoritative.
            if (
              isPlausibleDeliveryWindow(
                parsed.shipDate,
                parsed.estimatedDeliveryDate,
                null,
              )
            ) {
              setFields.shipDate = parsed.shipDate;
              setFields.estimatedDeliveryDate = parsed.estimatedDeliveryDate;
            }

            const result = await Shipment.updateOne(
              { sellerId: user._id, shipmentType: 'fba_fc', shipmentId: confirmationId },
              { $set: setFields },
            );
            if (result.matchedCount) {
              targetSet.delete(confirmationId);
              updated += 1;
            }
          }
        }

        nextToken = page.nextToken;
        pages += 1;
      } while (nextToken && pages < maxPagesPerStatus && targetSet.size > 0);
    }

    console.log(
      `[ShipmentSync] Reference IDs/dates for ${user.email || user._id}: updated=${updated}/${initialTargets}`,
    );

    // Direct backfill for rows that still lack a real SC shipment name but already
    // have inboundPlanId (plan scan can miss recently matched plans / empty plan.name).
    const nameBackfill = await this.backfillMissingFbaShipmentNames(user, amazonAPI);
    updated += nameBackfill;
    const dateBackfill = await this.backfillFbaCreatedAndLastUpdatedDates(user, amazonAPI);
    updated += dateBackfill;
    const windowBackfill = await this.backfillFbaDeliveryWindows(user, amazonAPI);
    updated += windowBackfill;
    const unitBackfill = await this.backfillFbaUnitQuantities(user, amazonAPI);
    updated += unitBackfill;

    await this.reportProgress(
      user._id,
      jobId,
      'fba_fc_reference_ids',
      { ...counters, saved: counters.saved + updated },
      updated
        ? `Updated Amazon reference ID/dates/names/windows/units on ${updated} shipment(s)`
        : 'No inbound-plan updates found for FBA shipments',
    );
    return {
      processed: counters.processed,
      saved: counters.saved + updated,
      failed: counters.failed,
    };
  }

  /**
   * For FBA shipments missing a real Seller Central title:
   * 1) Prefer inbound-plan (v2024) name when inboundPlanId is known
   * 2) Otherwise synthesize SC-style "FBA STA (…)-DEST" so no row is blank
   */
  async backfillMissingFbaShipmentNames(user, amazonAPI) {
    const { parseFbaV2024Shipment } = require('../utils/shipmentTrackingParser');
    const {
      looksLikeAmazonReferenceId,
      buildSyntheticFbaShipmentName,
    } = require('../utils/shipmentParser');

    const rows = await Shipment.find({
      sellerId: user._id,
      shipmentType: 'fba_fc',
    })
      .select(
        'shipmentId shipmentName referenceId inboundPlanId destinationCenterId createdDate metadata',
      )
      .lean();

    const targets = rows.filter((row) => !sanitizeFbaShipmentName(row.shipmentName, row.referenceId));
    if (!targets.length) return 0;

    let updated = 0;
    for (const row of targets) {
      if (this.shouldStop(user._id)) break;

      let shipmentName = null;
      const setFields = {};

      if (row.inboundPlanId) {
        try {
          const plan = await amazonAPI.getFbaInboundPlan(row.inboundPlanId);
          const entries = plan?.shipments || plan?.inboundShipments || [];
          for (const entry of entries) {
            const v2024Id = entry.shipmentId;
            if (!v2024Id) continue;
            let detail;
            try {
              detail = await amazonAPI.getFbaInboundShipmentV2024(row.inboundPlanId, v2024Id);
            } catch {
              continue;
            }
            const parsed = parseFbaV2024Shipment({
              ...detail,
              inboundPlanId: row.inboundPlanId,
            });
            if (parsed.shipmentConfirmationId !== row.shipmentId) continue;

            const amazonReferenceId = parsed.referenceId || row.referenceId || null;
            shipmentName = sanitizeFbaShipmentName(
              parsed.shipmentName || plan?.name,
              amazonReferenceId,
            );
            setFields['metadata.v2024ShipmentId'] = parsed.v2024ShipmentId || v2024Id;
            if (amazonReferenceId && !isFbaShipmentName(amazonReferenceId)) {
              setFields.referenceId = amazonReferenceId;
            }
            if (
              isPlausibleDeliveryWindow(
                parsed.shipDate,
                parsed.estimatedDeliveryDate,
                null,
              )
            ) {
              setFields.shipDate = parsed.shipDate;
              setFields.estimatedDeliveryDate = parsed.estimatedDeliveryDate;
            }
            if (parsed.destinationCenterId) {
              setFields.destinationCenterId = parsed.destinationCenterId;
            }
            break;
          }
        } catch (err) {
          console.warn(
            `[ShipmentSync] Name backfill failed for ${row.shipmentId}:`,
            err.message,
          );
        }
      }

      if (!shipmentName) {
        shipmentName = buildSyntheticFbaShipmentName({
          createdDate: row.createdDate || new Date(),
          destinationCenterId: setFields.destinationCenterId || row.destinationCenterId,
        });
      }

      if (shipmentName) {
        setFields.shipmentName = shipmentName;
        const createdDate = resolveFbaCreatedDate({
          shipmentName,
          existingName: row.shipmentName,
          existingCreated: row.createdDate,
        });
        if (createdDate) setFields.createdDate = createdDate;
      } else if (
        looksLikeAmazonReferenceId(row.shipmentName) ||
        (row.shipmentName && row.shipmentName === row.referenceId)
      ) {
        setFields.shipmentName = null;
      }

      if (Object.keys(setFields).length === 0) continue;

      await Shipment.updateOne(
        { sellerId: user._id, shipmentType: 'fba_fc', shipmentId: row.shipmentId },
        { $set: setFields },
      );
      updated += 1;
    }

    if (updated > 0) {
      console.log(
        `[ShipmentSync] Backfilled shipment names for ${updated} FBA shipment(s) (${user.email || user._id})`,
      );
    }
    return updated;
  }

  /**
   * Align Created / Last Updated with Seller Central for every FBA row:
   * - Created ← FBA STA title clock (immutable if Amazon later renames the title).
   *   Display in seller local TZ so it matches SC (e.g. 06:29Z → 11:59 AM IST).
   * - Last Updated ← inbound-plan lastUpdatedAt (best SP-API source; SC UI can lead by 1–2 days).
   * Also refreshes stale reference-as-name titles when inboundPlanId is known.
   */
  async backfillFbaCreatedAndLastUpdatedDates(user, amazonAPI) {
    const { parseFbaV2024Shipment } = require('../utils/shipmentTrackingParser');

    const rows = await Shipment.find({
      sellerId: user._id,
      shipmentType: 'fba_fc',
    })
      .select(
        'shipmentId shipmentName referenceId inboundPlanId createdDate lastUpdatedDate destinationCenterId metadata',
      )
      .lean();
    if (!rows.length) return 0;

    let updated = 0;
    const planCache = new Map();

    for (const row of rows) {
      if (this.shouldStop(user._id)) break;

      const setFields = {};
      let shipmentName = sanitizeFbaShipmentName(row.shipmentName, row.referenceId);
      let planCreated = null;
      let planUpdated = null;

      if (row.inboundPlanId) {
        try {
          let plan = planCache.get(row.inboundPlanId);
          if (!plan) {
            plan = await amazonAPI.getFbaInboundPlan(row.inboundPlanId);
            planCache.set(row.inboundPlanId, plan || null);
          }
          planCreated = normalizeDate(plan?.createdAt);
          planUpdated = normalizeDate(plan?.lastUpdatedAt);

          if (!shipmentName || !isFbaShipmentName(shipmentName)) {
            const entries = plan?.shipments || plan?.inboundShipments || [];
            for (const entry of entries) {
              const v2024Id = entry.shipmentId;
              if (!v2024Id) continue;
              let detail;
              try {
                detail = await amazonAPI.getFbaInboundShipmentV2024(row.inboundPlanId, v2024Id);
              } catch {
                continue;
              }
              const parsed = parseFbaV2024Shipment({
                ...detail,
                inboundPlanId: row.inboundPlanId,
              });
              if (parsed.shipmentConfirmationId !== row.shipmentId) continue;
              const nextName = sanitizeFbaShipmentName(
                parsed.shipmentName || plan?.name,
                parsed.referenceId || row.referenceId,
              );
              if (nextName) {
                shipmentName = nextName;
                setFields.shipmentName = nextName;
              }
              if (parsed.referenceId && !isFbaShipmentName(parsed.referenceId)) {
                setFields.referenceId = parsed.referenceId;
              }
              break;
            }
          }
        } catch (err) {
          console.warn(
            `[ShipmentSync] Date backfill failed for ${row.shipmentId}:`,
            err.message,
          );
        }
      }

      const createdDate = resolveFbaCreatedDate({
        shipmentName: shipmentName || row.shipmentName,
        existingName: row.shipmentName,
        amazonCreated: planCreated,
        existingCreated: row.createdDate,
      });
      const lastUpdatedDate = resolveFbaLastUpdatedDate({
        amazonLastUpdated: planUpdated,
        existingLastUpdated: row.lastUpdatedDate,
        createdDate,
      });

      if (createdDate) {
        const prev = row.createdDate ? new Date(row.createdDate).getTime() : null;
        if (prev !== createdDate.getTime()) setFields.createdDate = createdDate;
      }
      if (lastUpdatedDate) {
        const prev = row.lastUpdatedDate ? new Date(row.lastUpdatedDate).getTime() : null;
        if (prev !== lastUpdatedDate.getTime()) setFields.lastUpdatedDate = lastUpdatedDate;
      }

      if (Object.keys(setFields).length === 0) continue;

      await Shipment.updateOne(
        { sellerId: user._id, shipmentType: 'fba_fc', shipmentId: row.shipmentId },
        { $set: setFields },
      );
      updated += 1;
    }

    if (updated > 0) {
      console.log(
        `[ShipmentSync] Backfilled created/lastUpdated for ${updated} FBA shipment(s) (${user.email || user._id})`,
      );
    }
    return updated;
  }

  /**
   * Fill Seller Central Delivery Window (selectedDeliveryWindow start/end) for every
   * FBA shipment that still lacks a plausible shipDate + estimatedDeliveryDate pair.
   * Uses inboundPlanId when known; otherwise skipped (plan scan in applyFbaAmazonReferenceIds).
   */
  async backfillFbaDeliveryWindows(user, amazonAPI) {
    const { parseFbaV2024Shipment } = require('../utils/shipmentTrackingParser');

    const rows = await Shipment.find({
      sellerId: user._id,
      shipmentType: 'fba_fc',
      inboundPlanId: { $ne: null },
    })
      .select(
        'shipmentId inboundPlanId shipDate estimatedDeliveryDate createdDate metadata',
      )
      .lean();

    const targets = rows.filter(
      (row) =>
        !isPlausibleDeliveryWindow(row.shipDate, row.estimatedDeliveryDate, null),
    );
    if (!targets.length) return 0;

    let updated = 0;
    const planCache = new Map();

    for (const row of targets) {
      if (this.shouldStop(user._id)) break;

      try {
        let plan = planCache.get(row.inboundPlanId);
        if (plan === undefined) {
          try {
            plan = await amazonAPI.getFbaInboundPlan(row.inboundPlanId);
          } catch (err) {
            console.warn(
              `[ShipmentSync] Delivery window plan ${row.inboundPlanId}:`,
              err.message,
            );
            plan = null;
          }
          planCache.set(row.inboundPlanId, plan);
        }
        if (!plan) continue;

        const entries = plan.shipments || plan.inboundShipments || [];
        const preferredId = row.metadata?.v2024ShipmentId || null;
        const ordered = preferredId
          ? [
              ...entries.filter((e) => e.shipmentId === preferredId),
              ...entries.filter((e) => e.shipmentId !== preferredId),
            ]
          : entries;

        for (const entry of ordered) {
          const v2024Id = entry.shipmentId;
          if (!v2024Id) continue;

          let detail;
          try {
            detail = await amazonAPI.getFbaInboundShipmentV2024(row.inboundPlanId, v2024Id);
          } catch {
            continue;
          }

          const parsed = parseFbaV2024Shipment({
            ...detail,
            inboundPlanId: row.inboundPlanId,
          });
          if (
            parsed.shipmentConfirmationId &&
            parsed.shipmentConfirmationId !== row.shipmentId
          ) {
            continue;
          }

          if (
            !isPlausibleDeliveryWindow(
              parsed.shipDate,
              parsed.estimatedDeliveryDate,
              null,
            )
          ) {
            // Matched confirmation but Amazon has no window — stop for this row.
            if (parsed.shipmentConfirmationId === row.shipmentId) break;
            continue;
          }

          const setFields = {
            shipDate: parsed.shipDate,
            estimatedDeliveryDate: parsed.estimatedDeliveryDate,
            'metadata.v2024ShipmentId': parsed.v2024ShipmentId || v2024Id,
          };
          if (parsed.referenceId && !isFbaShipmentName(parsed.referenceId)) {
            setFields.referenceId = parsed.referenceId;
          }

          await Shipment.updateOne(
            { sellerId: user._id, shipmentType: 'fba_fc', shipmentId: row.shipmentId },
            { $set: setFields },
          );
          updated += 1;
          break;
        }
      } catch (err) {
        console.warn(
          `[ShipmentSync] Delivery window backfill failed for ${row.shipmentId}:`,
          err.message,
        );
      }

      if (ITEM_DELAY_MS > 0) await sleep(ITEM_DELAY_MS);
    }

    if (updated > 0) {
      console.log(
        `[ShipmentSync] Backfilled delivery windows for ${updated} FBA shipment(s) (${user.email || user._id})`,
      );
    }
    return updated;
  }

  /**
   * Fix AWD Amazon Reference ID: Seller Central shows warehouseReferenceId
   * (short codes like 6KXKOUGO), not externalReferenceId workflow UUIDs.
   */
  async backfillAwdReferenceIds(user, amazonAPI) {
    const rows = await Shipment.find({
      sellerId: user._id,
      shipmentType: 'awd_dc',
    })
      .select('shipmentId referenceId orderId metadata')
      .lean();

    const targets = rows.filter((row) => !looksLikeAmazonReferenceId(row.referenceId));
    if (!targets.length) return 0;

    let updated = 0;

    for (const row of targets) {
      if (this.shouldStop(user._id)) break;

      let nextRef = looksLikeAmazonReferenceId(row.metadata?.warehouseReferenceId)
        ? String(row.metadata.warehouseReferenceId).trim()
        : null;

      if (!nextRef) {
        try {
          const detail = await amazonAPI.getAwdInboundShipment(row.shipmentId);
          if (looksLikeAmazonReferenceId(detail?.warehouseReferenceId)) {
            nextRef = String(detail.warehouseReferenceId).trim();
          }
          const setFields = {
            referenceId: nextRef,
            'metadata.warehouseReferenceId': detail?.warehouseReferenceId || null,
            'metadata.externalReferenceId': detail?.externalReferenceId || row.metadata?.externalReferenceId || null,
          };
          if (detail?.orderId) setFields.orderId = detail.orderId;
          await Shipment.updateOne(
            { sellerId: user._id, shipmentType: 'awd_dc', shipmentId: row.shipmentId },
            { $set: setFields },
          );
          if (nextRef) updated += 1;
          if (ITEM_DELAY_MS > 0) await sleep(ITEM_DELAY_MS);
          continue;
        } catch (err) {
          console.warn(`[ShipmentSync] AWD ref backfill ${row.shipmentId}:`, err.message);
          // Fall through to clear bad UUID if we at least have metadata ref.
        }
      }

      await Shipment.updateOne(
        { sellerId: user._id, shipmentType: 'awd_dc', shipmentId: row.shipmentId },
        {
          $set: {
            referenceId: nextRef,
            ...(nextRef ? { 'metadata.warehouseReferenceId': nextRef } : {}),
          },
        },
      );
      if (nextRef) updated += 1;
    }

    if (updated > 0) {
      console.log(
        `[ShipmentSync] Backfilled AWD Amazon reference IDs for ${updated} shipment(s) (${user.email || user._id})`,
      );
    }
    return updated;
  }

  /**
   * Re-fetch FBA item quantities (Units Expected / Located) with safe pagination
   * and recompute hasDiscrepancy from shipment totals (Seller Central style).
   */
  async backfillFbaUnitQuantities(user, amazonAPI) {
    const rows = await Shipment.find({
      sellerId: user._id,
      shipmentType: 'fba_fc',
    })
      .select(
        'shipmentId status referenceId shipmentName destinationCenterId createdDate lastUpdatedDate unitsExpected unitsLocated lineItems skuCount shipDate estimatedDeliveryDate inboundPlanId metadata',
      )
      .lean();

    if (!rows.length) return 0;

    const allReimbursements =
      typeof amazonAPI.getFbaReimbursementsForLocatedAdjustments === 'function'
        ? await amazonAPI.getFbaReimbursementsForLocatedAdjustments()
        : [];

    // Pass 1: refresh raw QuantityShipped/Received (no reimbursement netting yet).
    const refreshed = [];
    for (const row of rows) {
      if (this.shouldStop(user._id)) break;

      try {
        const items = await amazonAPI.getAllFbaShipmentItems(row.shipmentId);
        const shipmentInfo = {
          ShipmentId: row.shipmentId,
          ShipmentStatus: row.status,
          ShipmentName: row.shipmentName || row.referenceId,
          DestinationFulfillmentCenterId: row.destinationCenterId,
          CreatedDate: row.createdDate,
          LastUpdatedDate: row.lastUpdatedDate,
        };
        const raw = parseFbaShipment(shipmentInfo, items, row, { reimbursements: [] });
        refreshed.push({
          row,
          shipmentInfo,
          items,
          raw,
        });
      } catch (err) {
        console.warn(`[ShipmentSync] Unit backfill ${row.shipmentId}:`, err.message);
      }

      if (ITEM_DELAY_MS > 0) await sleep(ITEM_DELAY_MS);
    }

    const { assignReimbursementsToShipments } = require('../utils/shipmentParser');
    const assignment = assignReimbursementsToShipments(
      refreshed.map(({ row, raw }) => ({
        shipmentId: row.shipmentId,
        createdDate: raw.createdDate || row.createdDate,
        lastUpdatedDate: raw.lastUpdatedDate || row.lastUpdatedDate,
        lineItems: raw.lineItems,
      })),
      allReimbursements,
    );

    // Pass 2: apply only reimbursements attributed to each shipment.
    let updated = 0;
    for (const entry of refreshed) {
      const { row, shipmentInfo, items, raw } = entry;
      const reimbursements = assignment.get(String(row.shipmentId)) || [];
      const parsed = reimbursements.length
        ? parseFbaShipment(shipmentInfo, items, row, { reimbursements })
        : raw;

      const setFields = {
        skuCount: parsed.skuCount,
        unitsExpected: parsed.unitsExpected,
        unitsLocated: parsed.unitsLocated,
        lineItems: parsed.lineItems,
        hasDiscrepancy: parsed.hasDiscrepancy,
        detailsEnrichedAt: new Date(),
        lastSynced: new Date(),
      };

      const changed =
        Number(row.unitsExpected || 0) !== Number(setFields.unitsExpected || 0) ||
        Number(row.unitsLocated || 0) !== Number(setFields.unitsLocated || 0) ||
        Boolean(row.hasDiscrepancy) !== Boolean(setFields.hasDiscrepancy);

      if (changed || !row.detailsEnrichedAt) {
        await Shipment.updateOne(
          { sellerId: user._id, shipmentType: 'fba_fc', shipmentId: row.shipmentId },
          { $set: setFields },
        );
        updated += 1;
      }
    }

    if (updated > 0) {
      console.log(
        `[ShipmentSync] Backfilled FBA unit quantities for ${updated} shipment(s) (${user.email || user._id})`,
      );
    }
    return updated;
  }

  async enrichFbaItemsForPage(user, amazonAPI, shipmentInfos, existingMap, jobId, counters) {
    const shouldAbort = () => this.shouldStop(user._id);
    const shipmentDocs = [];

    for (const shipmentInfo of shipmentInfos) {
      if (shouldAbort()) break;

      const shipmentId = shipmentInfo.ShipmentId || shipmentInfo.shipmentId;
      if (!shipmentId) continue;

      const shipment = await Shipment.findOne({
        sellerId: user._id,
        shipmentType: 'fba_fc',
        shipmentId,
      });
      if (shipment) shipmentDocs.push(shipment);
    }

    if (!shipmentDocs.length) return counters;

    const { enriched, failed } = await this.enrichShipmentRecords(user, amazonAPI, shipmentDocs, {
      shouldAbort,
      forceEmit: true,
    });

    return {
      processed: counters.processed,
      saved: counters.saved + enriched,
      failed: counters.failed + failed,
    };
  }

  async reportProgress(userId, jobId, phase, counters, message) {
    const { processed, saved, failed } = counters;
    await this.updateJob(jobId, { processed, saved, failed, phase, message });
    emitToUser(userId, 'shipmentSyncStatus', {
      event: 'SHIPMENT_SYNC_PROGRESS',
      phase,
      processed,
      saved,
      failed,
      message,
    });
  }

  async fetchUniqueFbaShipmentsForWindow(user, amazonAPI, window, seenIds) {
    const marketplaceIds = amazonAPI.getMarketplaceIds();
    const collected = [];

    for (const marketplaceId of marketplaceIds) {
      if (this.shouldStop(user._id)) break;

      for (const status of FBA_SHIPMENT_STATUSES) {
        if (this.shouldStop(user._id)) break;

        let nextToken = null;
        do {
          if (this.shouldStop(user._id)) break;

          let page;
          try {
            page = await amazonAPI.getFbaInboundShipments({
              lastUpdatedAfter: window.start.toISOString(),
              lastUpdatedBefore: window.end.toISOString(),
              shipmentStatusList: [status],
              nextToken,
              marketplaceId,
            });
          } catch (err) {
            console.warn(
              `[ShipmentSync] FBA list ${status} (${marketplaceId}):`,
              err.message,
            );
            break;
          }

          for (const shipmentInfo of page.shipments) {
            const shipmentId = shipmentInfo.ShipmentId || shipmentInfo.shipmentId;
            if (!shipmentId || seenIds.has(shipmentId)) continue;
            seenIds.add(shipmentId);
            collected.push(shipmentInfo);
          }

          nextToken = page.nextToken;
          if (nextToken && ITEM_DELAY_MS > 0) await sleep(ITEM_DELAY_MS);
        } while (nextToken);
      }
    }

    return collected;
  }

  async syncFbaShipments(user, amazonAPI, jobId) {
    const dateWindows = buildDateWindows(LOOKBACK_DAYS);
    const seenIds = new Set();
    let processed = 0;
    let saved = 0;
    let failed = 0;

    await this.updateJob(jobId, {
      phase: 'fba_fc',
      message: 'Syncing Fulfilment Center shipments…',
    });

    emitToUser(user._id, 'shipmentSyncStatus', {
      event: 'SHIPMENT_SYNC_PROGRESS',
      phase: 'fba_fc',
      message: 'Syncing Fulfilment Center shipments…',
    });

    for (const window of dateWindows) {
      if (this.shouldStop(user._id)) break;

      const windowShipments = await this.fetchUniqueFbaShipmentsForWindow(
        user,
        amazonAPI,
        window,
        seenIds,
      );

      console.log(
        `[ShipmentSync] FBA window ${window.start.toISOString().slice(0, 10)}–${window.end.toISOString().slice(0, 10)}: ${windowShipments.length} unique shipment(s)`,
      );

      if (!windowShipments.length) continue;

      const CHUNK = 50;
      for (let i = 0; i < windowShipments.length; i += CHUNK) {
        if (this.shouldStop(user._id)) break;

        const chunk = windowShipments.slice(i, i + CHUNK);
        const existingMap = await this.loadExistingFbaMap(user._id, chunk);
        const batchSaved = await this.saveFbaListBatch(user._id, chunk, existingMap);
        processed += chunk.length;
        saved += batchSaved;

        await this.reportProgress(
          user._id,
          jobId,
          'fba_fc',
          { processed, saved, failed },
          `Saved ${saved} FBA shipment(s) from Amazon…`,
        );

        if (ENRICH_ITEMS_IN_SYNC && !this.shouldStop(user._id)) {
          await this.updateJob(jobId, {
            phase: 'fba_fc_items',
            message: `Enriching SKU counts (${saved}/${seenIds.size})…`,
          });
          ({ processed, saved, failed } = await this.enrichFbaItemsForPage(
            user,
            amazonAPI,
            chunk,
            existingMap,
            jobId,
            { processed, saved, failed },
          ));
        }
      }
    }

    if (!this.shouldStop(user._id)) {
      ({ processed, saved, failed } = await this.enrichIncompleteFbaShipments(
        user,
        amazonAPI,
        jobId,
        { processed, saved, failed },
      ));
    }

    if (!this.shouldStop(user._id)) {
      ({ processed, saved, failed } = await this.applyFbaAmazonReferenceIds(
        user,
        amazonAPI,
        jobId,
        { processed, saved, failed },
      ));
    }

    console.log(`[ShipmentSync] FBA complete: ${seenIds.size} unique shipment(s) from Amazon`);
    return { processed, saved, failed, uniqueFromAmazon: seenIds.size };
  }

  async syncAwdShipments(user, amazonAPI, jobId, counters) {
    let nextToken = null;
    let processed = counters.processed;
    let saved = counters.saved;
    let failed = counters.failed;

    const lookbackStart = new Date();
    lookbackStart.setDate(lookbackStart.getDate() - LOOKBACK_DAYS);

    await this.updateJob(jobId, {
      phase: 'awd_dc',
      message: 'Syncing Distribution Center shipments…',
      processed,
      saved,
      failed,
    });

    emitToUser(user._id, 'shipmentSyncStatus', {
      event: 'SHIPMENT_SYNC_PROGRESS',
      phase: 'awd_dc',
      processed,
      saved,
      failed,
      message: 'Syncing Distribution Center shipments…',
    });

    do {
      if (this.shouldStop(user._id)) break;

      let page;
      try {
        page = await amazonAPI.listAwdInboundShipments({
          updatedAfter: lookbackStart.toISOString(),
          nextToken,
        });
      } catch (err) {
        console.warn('[ShipmentSync] AWD list unavailable:', err.message);
        break;
      }

      console.log(`[ShipmentSync] AWD page: ${page.shipments.length} shipment(s)`);

      const awdIds = page.shipments.map((s) => s.shipmentId).filter(Boolean);
      const awdExisting = awdIds.length
        ? await Shipment.find({
            sellerId: user._id,
            shipmentType: 'awd_dc',
            shipmentId: { $in: awdIds },
          }).lean()
        : [];
      const awdExistingMap = new Map(awdExisting.map((row) => [row.shipmentId, row]));

      const awdOps = [];
      for (const summary of page.shipments) {
        const shipmentId = summary.shipmentId;
        if (!shipmentId) continue;
        const existing = awdExistingMap.get(shipmentId) || null;
        const doc = parseAwdShipment(summary, null, existing);
        const { createdDate, ...setFields } = doc;
        // List API has no warehouseReferenceId — keep a good SC ref; clear workflow UUIDs.
        if (looksLikeAmazonReferenceId(existing?.referenceId) && !looksLikeAmazonReferenceId(setFields.referenceId)) {
          setFields.referenceId = existing.referenceId;
        } else if (
          looksLikeAmazonReferenceId(existing?.metadata?.warehouseReferenceId) &&
          !looksLikeAmazonReferenceId(setFields.referenceId)
        ) {
          setFields.referenceId = existing.metadata.warehouseReferenceId;
        } else if (!looksLikeAmazonReferenceId(setFields.referenceId)) {
          setFields.referenceId = null;
        }
        awdOps.push({
          updateOne: {
            filter: { sellerId: user._id, shipmentType: 'awd_dc', shipmentId },
            update: {
              $set: { ...setFields, sellerId: user._id },
              $setOnInsert: { createdDate: createdDate || new Date() },
            },
            upsert: true,
          },
        });
      }
      if (awdOps.length) {
        await Shipment.bulkWrite(awdOps, { ordered: false });
        processed += awdOps.length;
        saved += awdOps.length;
      }

      await this.reportProgress(
        user._id,
        jobId,
        'awd_dc',
        { processed, saved, failed },
        `Saved ${saved} shipment(s)…`,
      );

      if (this.shouldStop(user._id)) break;

      for (const summary of page.shipments) {
        if (this.shouldStop(user._id)) break;

        const shipmentId = summary.shipmentId;
        if (!shipmentId) continue;

        try {
          const existing = awdExistingMap.get(shipmentId) || null;
          let detail = null;
          try {
            detail = await amazonAPI.getAwdInboundShipment(shipmentId);
          } catch (detailErr) {
            console.warn(`[ShipmentSync] AWD detail ${shipmentId}:`, detailErr.message);
          }

          if (detail) {
            const doc = parseAwdShipment(summary, detail, existing);
            const { parseAwdTrackingDetails } = require('../utils/shipmentTrackingParser');
            const trackingData = parseAwdTrackingDetails(detail);
            if (detail?.shipmentStatus) {
              trackingData.status = String(detail.shipmentStatus).toUpperCase();
            }
            const enriched = mergeTrackingFields(doc, trackingData, existing);
            const savedDoc = await this.upsertShipment(user._id, enriched);
            if (existing && existing.status !== savedDoc.status) {
              emitShipmentTrackingUpdate(user._id, savedDoc, 'status_change');
            }
          }
        } catch (err) {
          failed += 1;
          console.warn(`[ShipmentSync] AWD ${shipmentId}:`, err.message);
        }

        if (ITEM_DELAY_MS > 0) await sleep(ITEM_DELAY_MS);
      }

      nextToken = page.nextToken;
      if (nextToken && ITEM_DELAY_MS > 0) await sleep(ITEM_DELAY_MS);
    } while (nextToken && !this.shouldStop(user._id));

    if (!this.shouldStop(user._id)) {
      const refFixed = await this.backfillAwdReferenceIds(user, amazonAPI);
      saved += refFixed;
    }

    return { processed, saved, failed };
  }

  async runSync(userId, jobId) {
    let job = await ShipmentSyncJob.findById(jobId);
    if (!job) return;

    try {
      const user = await this.getUserForSync(userId);
      const sellerAppCredentials = await getSellerAppCredentials(user);
      const amazonAPI = new AmazonAPI(user, sellerAppCredentials);

      let fbaResult = { processed: 0, saved: 0, failed: 0 };
      try {
        fbaResult = await this.syncFbaShipments(user, amazonAPI, jobId);
      } catch (err) {
        console.error('[ShipmentSync] FBA phase failed:', err.message);
      }
      const finalResult = await this.syncAwdShipments(user, amazonAPI, jobId, fbaResult);

      const stopped = this.shouldStop(userId);
      const amazonTotal = fbaResult.uniqueFromAmazon ?? finalResult.saved;
      job = await this.updateJob(jobId, {
        status: stopped ? 'STOPPED' : 'COMPLETED',
        stopRequested: false,
        stoppedByUser: stopped,
        processed: finalResult.processed,
        saved: finalResult.saved,
        failed: finalResult.failed,
        phase: 'complete',
        message: stopped
          ? `Shipment sync stopped. Saved ${finalResult.saved} shipment(s) (${amazonTotal} found on Amazon).`
          : `Shipment sync complete. Saved ${finalResult.saved} shipment(s) (${amazonTotal} found on Amazon).`,
        completedAt: new Date(),
      });

      emitToUser(userId, stopped ? 'shipmentSyncStopped' : 'shipmentSyncComplete', {
        event: stopped ? 'SHIPMENT_SYNC_STOPPED' : 'SHIPMENT_SYNC_COMPLETE',
        processed: finalResult.processed,
        saved: finalResult.saved,
        failed: finalResult.failed,
        message: job.message,
      });

      if (!stopped) {
        try {
          const { checkDelayedShipmentsForUser } = require('./shipmentDelayService');
          await checkDelayedShipmentsForUser(userId);
        } catch (delayErr) {
          console.warn('[ShipmentSync] Delay scan failed:', delayErr.message);
        }
      }
    } catch (err) {
      await this.updateJob(jobId, {
        status: 'FAILED',
        error: err.message,
        message: `Shipment sync failed: ${err.message}`,
        completedAt: new Date(),
      });

      emitToUser(userId, 'shipmentSyncError', {
        event: 'SHIPMENT_SYNC_ERROR',
        message: err.message,
      });
    } finally {
      this.activeJobs.delete(String(userId));
    }
  }
}

const shipmentSyncManager = new ShipmentSyncManager();

module.exports = {
  shipmentSyncManager,
};
