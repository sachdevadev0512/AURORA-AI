/** AmazonAPI shipments methods (façade mixins). */
/** Collapse duplicate SKU rows (bad NextToken paging can repeat the same item). */
function dedupeFbaShipmentItems(items = []) {
  const bySku = new Map();
  for (const item of items) {
    const sku = String(item.SellerSKU || item.sellerSKU || '').trim();
    const key = sku || JSON.stringify(item);
    const existing = bySku.get(key);
    if (!existing) {
      bySku.set(key, { ...item });
      continue;
    }
    const shipped = Math.max(
      Number(existing.QuantityShipped ?? existing.quantityShipped ?? 0) || 0,
      Number(item.QuantityShipped ?? item.quantityShipped ?? 0) || 0,
    );
    const received = Math.max(
      Number(existing.QuantityReceived ?? existing.quantityReceived ?? 0) || 0,
      Number(item.QuantityReceived ?? item.quantityReceived ?? 0) || 0,
    );
    bySku.set(key, {
      ...existing,
      ...item,
      QuantityShipped: shipped,
      quantityShipped: shipped,
      QuantityReceived: received,
      quantityReceived: received,
    });
  }
  return [...bySku.values()];
}

module.exports = {
  async getFbaInboundShipments({
    lastUpdatedAfter,
    lastUpdatedBefore,
    shipmentStatusList,
    nextToken,
    marketplaceId,
  } = {}) {
    const ALL_FBA_SHIPMENT_STATUSES = [
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

    try {
      const query = {
        MarketplaceId: marketplaceId || this.getMarketplaceId(),
        QueryType: nextToken ? 'NEXT_TOKEN' : 'DATE_RANGE',
      };

      if (nextToken) {
        query.NextToken = nextToken;
      } else {
        if (lastUpdatedAfter) query.LastUpdatedAfter = lastUpdatedAfter;
        if (lastUpdatedBefore) query.LastUpdatedBefore = lastUpdatedBefore;
        query.ShipmentStatusList =
          shipmentStatusList?.length > 0 ? shipmentStatusList : ALL_FBA_SHIPMENT_STATUSES;
      }

      const response = await this.callSpApi({
        operation: 'getShipments',
        endpoint: 'fulfillmentInbound',
        query,
      });

      return {
        shipments: response.ShipmentData || response.shipmentData || [],
        nextToken: response.NextToken || response.nextToken || null,
      };
    } catch (error) {
      console.error('Error fetching FBA inbound shipments:', error);
      throw error;
    }
  },

  async getFbaShipmentItems(shipmentId, nextToken = null) {
    try {
      const query = { MarketplaceId: this.getMarketplaceId() };
      if (nextToken) query.NextToken = nextToken;

      const response = await this.callSpApi({
        operation: 'getShipmentItemsByShipmentId',
        endpoint: 'fulfillmentInbound',
        path: { shipmentId },
        query,
      });

      return {
        items: response.ItemData || response.itemData || [],
        nextToken: response.NextToken || response.nextToken || null,
      };
    } catch (error) {
      console.error(`Error fetching FBA shipment items for ${shipmentId}:`, error);
      throw error;
    }
  },

  async getAllFbaShipmentItems(shipmentId) {
    const first = await this.getFbaShipmentItems(shipmentId);
    const PAGE_SIZE = 200;
    let items = [...(first.items || [])];
    let nextToken = first.nextToken || null;
    const seenTokens = new Set();

    while (nextToken && items.length >= PAGE_SIZE) {
      if (seenTokens.has(nextToken)) break;
      seenTokens.add(nextToken);

      const response = await this.callSpApi({
        operation: 'getShipmentItems',
        endpoint: 'fulfillmentInbound',
        query: {
          MarketplaceId: this.getMarketplaceId(),
          QueryType: 'NEXT_TOKEN',
          NextToken: nextToken,
        },
      });

      const pageItems = response.ItemData || response.itemData || [];
      if (!pageItems.length) break;
      items = items.concat(pageItems);
      nextToken = response.NextToken || response.nextToken || null;
    }

    return dedupeFbaShipmentItems(items);
  },

  async getFbaTransportDetails(shipmentId) {
    try {
      const response = await this.callSpApi({
        method: 'GET',
        api_path: `/fba/inbound/v0/shipments/${encodeURIComponent(shipmentId)}/transport`,
        restore_rate: 0.5,
      });
      return response.payload || response;
    } catch (error) {
      return null;
    }
  },

  async listFbaInboundPlans({ nextToken, status, sortBy = 'LAST_UPDATED_TIME' } = {}) {
    try {
      const query = { sortBy };
      if (nextToken) query.paginationToken = nextToken;
      if (status) query.status = status;

      const response = await this.callSpApi({
        operation: 'listInboundPlans',
        endpoint: 'fulfillmentInbound',
        query,
        options: { version: '2024-03-20' },
      });

      return {
        plans: response.inboundPlans || [],
        nextToken: response.pagination?.nextToken || null,
      };
    } catch (error) {
      console.warn('Error listing FBA inbound plans:', error.message);
      return { plans: [], nextToken: null };
    }
  },

  async getFbaInboundPlan(inboundPlanId) {
    try {
      const response = await this.callSpApi({
        operation: 'getInboundPlan',
        endpoint: 'fulfillmentInbound',
        path: { inboundPlanId },
        options: { version: '2024-03-20' },
      });
      return response;
    } catch (error) {
      return null;
    }
  },

  async getFbaInboundShipmentV2024(inboundPlanId, shipmentId) {
    try {
      const response = await this.callSpApi({
        operation: 'getShipment',
        endpoint: 'fulfillmentInbound',
        path: { inboundPlanId, shipmentId },
        options: { version: '2024-03-20' },
      });
      return response;
    } catch (error) {
      return null;
    }
  },

  async listAwdInboundShipments({
    nextToken,
    updatedAfter,
    updatedBefore,
    shipmentStatus,
    sortBy = 'UPDATED_AT',
    maxResults = 25,
  } = {}) {
    try {
      const query = { maxResults, sortBy };
      if (nextToken) query.nextToken = nextToken;
      if (updatedAfter) query.updatedAfter = updatedAfter;
      if (updatedBefore) query.updatedBefore = updatedBefore;
      if (shipmentStatus) query.shipmentStatus = shipmentStatus;

      const response = await this.callSpApi({
        operation: 'listInboundShipments',
        endpoint: 'amazonWarehousingAndDistribution',
        query,
      });

      return {
        shipments: response.shipments || [],
        nextToken: response.nextToken || null,
      };
    } catch (error) {
      console.error('Error listing AWD inbound shipments:', error);
      throw error;
    }
  },

  async getAwdInboundShipment(shipmentId) {
    try {
      const response = await this.callSpApi({
        operation: 'getInboundShipment',
        endpoint: 'amazonWarehousingAndDistribution',
        path: { shipmentId },
        query: { skuQuantities: 'SHOW' },
      });
      return response;
    } catch (error) {
      console.error(`Error fetching AWD inbound shipment ${shipmentId}:`, error);
      throw error;
    }
  }
};
