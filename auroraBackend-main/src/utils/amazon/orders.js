/** AmazonAPI orders methods (façade mixins). */
const { createAbortError } = require('./abortError');

module.exports = {
  async getOrders(createdAfter = null, createdBefore = null, nextToken = null) {
    try {
      const params = nextToken
        ? { NextToken: nextToken }
        : {
            MarketplaceIds: this.getMarketplaceIds(),
          };

      if (!nextToken) {
        if (createdAfter) params.CreatedAfter = createdAfter;
        if (createdBefore) params.CreatedBefore = createdBefore;
      }

      const response = await this.callSpApi({
        operation: 'getOrders',
        endpoint: 'orders',
        query: params,
      });

      return {
        orders: response.Orders || [],
        nextToken: response.NextToken || null,
      };
    } catch (error) {
      console.error('Error fetching orders:', error);
      throw error;
    }
  },

  async getOrderItems(orderId) {
    try {
      const response = await this.callSpApi({
        operation: 'getOrderItems',
        endpoint: 'orders',
        path: {
          orderId,
        },
      });

      return response.OrderItems || [];
    } catch (error) {
      console.error('Error fetching order items:', error);
      throw error;
    }
  },

  async getFinancialEvents(startDate, endDate) {
    try {
      const params = {
        PostedAfter: startDate,
      };

      if (endDate) params.PostedBefore = endDate;

      const response = await this.callSpApi({
        operation: 'listFinancialEvents',
        endpoint: 'finances',
        query: params,
      });

      return response.FinancialEvents || {};
    } catch (error) {
      console.error('Error fetching financial events:', error);
      throw error;
    }
  },

  async getOrderMetrics(startDate, endDate, granularity = 'Day') {
    try {
      const params = {
        interval: `${startDate}/${endDate}`,
        granularity: granularity,
        granularityTimeZone: 'UTC',
        reportType: 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL',
      };

      const response = await this.callSpApi({
        operation: 'getReport',
        endpoint: 'reports',
        query: params,
      });

      return response;
    } catch (error) {
      console.error('Error fetching order metrics:', error);
      throw error;
    }
  },

  async fetchFlatFileOrdersByOrderDateReport(startDate, endDate, options = {}) {
    const reportType = 'GET_FLAT_FILE_ALL_ORDERS_DATA_BY_ORDER_DATE_GENERAL';
    const created = await this.createReport(reportType, startDate, endDate);
    const reportId = created?.reportId;

    if (!reportId) {
      throw new Error('Order report creation did not return a reportId');
    }

    const documentInfo = await this.waitForReportDocument(reportId, options);
    if (await Promise.resolve(options.shouldAbort?.())) {
      throw createAbortError();
    }
    const content = await this.sellingPartner.download(documentInfo, { json: true });
    return Array.isArray(content) ? content : [];
  },

  async getOrderDetails(orderId) {
    try {
      const orderResponse = await this.callSpApi({
        operation: 'getOrder',
        endpoint: 'orders',
        path: {
          orderId,
        },
      });

      const order = orderResponse.Payload || orderResponse;

      // Get order items
      const orderItems = await this.getOrderItems(orderId);

      return {
        amazonOrderId: order.AmazonOrderId,
        sellerOrderId: order.SellerOrderId || '',
        purchaseDate: order.PurchaseDate,
        lastUpdateDate: order.LastUpdateDate,
        orderStatus: order.OrderStatus,
        fulfillmentChannel: order.FulfillmentChannel,
        salesChannel: order.SalesChannel,
        shipServiceLevel: order.ShipServiceLevel,
        shippingAddress: order.ShippingAddress || {},
        orderTotal: order.OrderTotal || {},
        numberOfItemsShipped: order.NumberOfItemsShipped || 0,
        numberOfItemsUnshipped: order.NumberOfItemsUnshipped || 0,
        paymentMethod: order.PaymentMethod,
        paymentMethodDetails: order.PaymentMethodDetails,
        isBusinessOrder: order.IsBusinessOrder || false,
        isPrime: order.IsPrime || false,
        isReplacementOrder: order.IsReplacementOrder || false,
        isGlobalExpressEnabled: order.IsGlobalExpressEnabled || false,
        replacedOrderId: order.ReplacedOrderId,
        isISPU: order.IsISPU || false,
        merchantFulfillmentData: order.MerchantFulfillmentData,
        hasRegulatedItems: order.HasRegulatedItems || false,
        electronicInvoiceStatus: order.ElectronicInvoiceStatus,
        orderItems,
        marketplaceId: order.MarketplaceId,
        buyerEmail: order.BuyerEmail,
        buyerName: order.BuyerName,
        buyerCounty: order.BuyerCounty,
        buyerTaxInfo: order.BuyerTaxInfo,
      };
    } catch (error) {
      console.error('Error fetching order details:', error);
      throw error;
    }
  }
};
