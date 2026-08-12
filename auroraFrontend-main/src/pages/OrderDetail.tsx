import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { ArrowLeft, User, MapPin, Package, CreditCard, TrendingUp, Clock, DollarSign, ShoppingCart } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import { getOrder } from '../api';
import { Order } from '../types';

export default function OrderDetail() {
  const { id } = useParams<{ id: string }>();
  const { token } = useAuth();
  const [order, setOrder] = useState<Order | null>(null);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');

  useEffect(() => {
    const loadOrder = async () => {
      if (!token || !id) return;
      try {
        setLoading(true);
        const response = await getOrder(token, id);
        setOrder(response.data);
      } catch (err) {
        setMessage((err as Error).message);
      } finally {
        setLoading(false);
      }
    };

    void loadOrder();
  }, [id, token]);

  const getStatusBadge = (status: string) => {
    const classes = {
      Pending: 'status-pending',
      Unshipped: 'status-inactive',
      PartiallyShipped: 'status-warning',
      Shipped: 'status-active',
      Canceled: 'status-error',
      Unfulfillable: 'status-error',
      InvoiceUnconfirmed: 'status-warning',
    };
    return <span className={`status-badge ${classes[status as keyof typeof classes] || 'status-inactive'}`}>{status}</span>;
  };

  const formatOrderDateTime = (value?: string) => {
    if (!value) return 'N/A';
    return new Date(value).toLocaleString('en-US', {
      timeZone: order?.displayTimeZone || undefined,
    });
  };

  const formatMoney = (amount?: number, currencyCode?: string) => {
    const value = amount ?? 0;
    const currency = currencyCode || order?.orderTotal.currencyCode || 'USD';

    return new Intl.NumberFormat('en-US', {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(value);
  };

  const calculateOrderProfit = (order: Order) => {
    let totalRevenue = 0;
    let totalReferralFees = 0;
    let totalFulfillmentFees = 0;
    let totalCOGS = 0;

    order.orderItems.forEach(item => {
      totalRevenue += item.itemSubtotal?.amount || 0;
      totalReferralFees += item.referralFee?.amount || 0;
      totalFulfillmentFees += item.fulfillmentFee?.amount || 0;
      totalCOGS += item.costOfGoodsSold?.amount || 0;
    });

    const netProfit = totalRevenue - totalReferralFees - totalFulfillmentFees - totalCOGS;
    const profitMargin = totalRevenue > 0 ? (netProfit / totalRevenue) * 100 : 0;

    return { totalRevenue, totalReferralFees, totalFulfillmentFees, totalCOGS, netProfit, profitMargin };
  };

  if (loading) {
    return (
      <div className="container">
        <div className="splash">
          <div className="card">
            <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
              <div className="spinner"></div>
              <p>Loading order details...</p>
            </div>
          </div>
        </div>
      </div>
    );
  }

  if (!order) {
    return (
      <div className="container">
        <div className="page-header">
          <div>
            <h1>Order Not Found</h1>
            <p>The requested order could not be found.</p>
          </div>
          <Link className="btn secondary" to="/orders">
            <ArrowLeft size={16} />
            Back to orders
          </Link>
        </div>
        {message && <div className="alert error">{message}</div>}
      </div>
    );
  }

  const profitData = calculateOrderProfit(order);

  return (
    <div className="container">
      <div className="page-header">
        <div>
          <h1>Order Details</h1>
          <p>Comprehensive view of order #{order.amazonOrderId}</p>
        </div>
        <Link className="btn secondary" to="/orders">
          <ArrowLeft size={16} />
          Back to orders
        </Link>
      </div>

      {message && <div className="alert error">{message}</div>}

      {/* Order Summary Cards */}
      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', marginBottom: '1.5rem' }}>
        <div className="card stat-card">
          <div className="stat-icon">
            <Package size={20} />
          </div>
          <div className="stat-content">
            <div className="stat-value">{getStatusBadge(order.orderStatus)}</div>
            <div className="stat-label">Order Status</div>
          </div>
        </div>

        <div className="card stat-card">
          <div className="stat-icon">
            <DollarSign size={20} />
          </div>
          <div className="stat-content">
            <div className="stat-value">${order.orderTotal.amount.toFixed(2)}</div>
            <div className="stat-label">{order.orderTotal.currencyCode}</div>
          </div>
        </div>

        <div className="card stat-card">
          <div className="stat-icon">
            <ShoppingCart size={20} />
          </div>
          <div className="stat-content">
            <div className="stat-value">{order.orderItems.length}</div>
            <div className="stat-label">Items</div>
          </div>
        </div>

        <div className="card stat-card">
          <div className="stat-icon">
            <TrendingUp size={20} />
          </div>
          <div className="stat-content">
            <div className="stat-value">${profitData.netProfit.toFixed(2)}</div>
            <div className="stat-label">Net Profit ({profitData.profitMargin.toFixed(1)}%)</div>
          </div>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: '2fr 1fr', gap: '1.5rem' }}>
        {/* Main Order Details */}
        <div>
          {/* Order Information */}
          <div className="card">
            <h2 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '1rem' }}>
              <Package size={20} />
              Order Information
            </h2>

            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
              <div>
                <strong>Amazon Order ID:</strong>
                <div>{order.amazonOrderId}</div>
              </div>
              {order.sellerOrderId && (
                <div>
                  <strong>Seller Order ID:</strong>
                  <div>{order.sellerOrderId}</div>
                </div>
              )}
              <div>
                <strong>Purchase Date:</strong>
                <div>{formatOrderDateTime(order.purchaseDate)}</div>
              </div>
              {order.lastUpdateDate && (
                <div>
                  <strong>Last Updated:</strong>
                  <div>{formatOrderDateTime(order.lastUpdateDate)}</div>
                </div>
              )}
              <div>
                <strong>Fulfillment Channel:</strong>
                <div>{order.fulfillmentChannel === 'AFN' ? 'Fulfilled by Amazon' : order.fulfillmentChannel === 'MFN' ? 'Fulfilled by Merchant' : order.fulfillmentChannel || 'N/A'}</div>
              </div>
              <div>
                <strong>Sales Channel:</strong>
                <div>{order.salesChannel || 'N/A'}</div>
              </div>
              {order.marketplaceName && (
                <div>
                  <strong>Marketplace:</strong>
                  <div>{order.marketplaceName}</div>
                </div>
              )}
              {order.marketplaceId && (
                <div>
                  <strong>Marketplace ID:</strong>
                  <div>{order.marketplaceId}</div>
                </div>
              )}
              {order.shipServiceLevel && (
                <div>
                  <strong>Shipping Service:</strong>
                  <div>{order.shipServiceLevel}</div>
                </div>
              )}
              {order.shipmentServiceLevelCategory && (
                <div>
                  <strong>Shipment Category:</strong>
                  <div>{order.shipmentServiceLevelCategory}</div>
                </div>
              )}
              {order.paymentMethod && (
                <div>
                  <strong>Payment Method:</strong>
                  <div>{order.paymentMethod}</div>
                </div>
              )}
            </div>

            {/* Special Flags */}
            {(order.isPrime || order.isBusinessOrder || order.isReplacementOrder) && (
              <div style={{ marginBottom: '1.5rem' }}>
                <h3>Order Flags</h3>
                <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
                  {order.isPrime && <span className="status-badge status-active">Prime</span>}
                  {order.isBusinessOrder && <span className="status-badge status-active">Business Order</span>}
                  {order.isReplacementOrder && <span className="status-badge status-warning">Replacement Order</span>}
                  {order.isPremiumOrder && <span className="status-badge status-active">Premium Order</span>}
                </div>
              </div>
            )}
          </div>

          {/* Order Items */}
          <div className="card" style={{ marginTop: '1.5rem' }}>
            <h3>Order Items</h3>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>Product</th>
                    <th>SKU/ASIN</th>
                    <th>Item Status</th>
                    <th>Qty</th>
                    <th>Unit Price</th>
                    <th>Total</th>
                    <th>Promotions</th>
                    <th>Fees</th>
                    <th>Profit</th>
                  </tr>
                </thead>
                <tbody>
                  {order.orderItems.map((item, index) => {
                    const itemProfit = (item.itemSubtotal?.amount || 0) -
                      (item.referralFee?.amount || 0) -
                      (item.fulfillmentFee?.amount || 0) -
                      (item.costOfGoodsSold?.amount || 0);

                    return (
                      <tr key={`${item.asin}-${index}`}>
                        <td>
                          <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                            {item.productImage ? (
                              <img
                                src={item.productImage}
                                alt={item.title}
                                className="product-cell-image"
                              />
                            ) : (
                              <div className="product-cell-image product-cell-image-placeholder" aria-hidden>
                                <Package size={18} />
                              </div>
                            )}
                            <div>
                              <div style={{ fontWeight: '500', marginBottom: '0.25rem' }}>{item.title}</div>
                              {item.fnsku && <div style={{ fontSize: '0.8rem', color: '#666' }}>FNSKU: {item.fnsku}</div>}
                            </div>
                          </div>
                        </td>
                        <td>
                          <div>{item.sellerSku}</div>
                          <div style={{ fontSize: '0.8rem', color: '#666' }}>{item.asin}</div>
                        </td>
                        <td>{item.itemStatus || order.orderStatus}</td>
                        <td>{item.quantityOrdered}</td>
                        <td>{formatMoney(item.itemPrice.amount, item.itemPrice.currencyCode)}</td>
                        <td>{formatMoney(item.itemSubtotal?.amount, item.itemSubtotal?.currencyCode || item.itemPrice.currencyCode)}</td>
                        <td>
                          {item.promotionIds && item.promotionIds.length > 0
                            ? item.promotionIds.join(', ')
                            : 'None'}
                        </td>
                        <td>
                          <div style={{ fontSize: '0.8rem' }}>
                            <div>Ref: {formatMoney(item.referralFee?.amount, item.referralFee?.currencyCode)}</div>
                            <div>FBA: {formatMoney(item.fulfillmentFee?.amount, item.fulfillmentFee?.currencyCode)}</div>
                          </div>
                        </td>
                        <td style={{ color: itemProfit >= 0 ? '#10b981' : '#ef4444' }}>
                          {formatMoney(itemProfit, item.itemSubtotal?.currencyCode || item.itemPrice.currencyCode)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Profit Breakdown */}
          <div className="card" style={{ marginTop: '1.5rem' }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <TrendingUp size={18} />
              Profit Analysis
            </h3>
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: '1rem' }}>
              <div>
                <strong>Total Revenue:</strong>
                <div style={{ color: '#10b981' }}>${profitData.totalRevenue.toFixed(2)}</div>
              </div>
              <div>
                <strong>Referral Fees:</strong>
                <div style={{ color: '#ef4444' }}>${profitData.totalReferralFees.toFixed(2)}</div>
              </div>
              <div>
                <strong>Fulfillment Fees:</strong>
                <div style={{ color: '#ef4444' }}>${profitData.totalFulfillmentFees.toFixed(2)}</div>
              </div>
              <div>
                <strong>Cost of Goods:</strong>
                <div style={{ color: '#ef4444' }}>${profitData.totalCOGS.toFixed(2)}</div>
              </div>
              <div>
                <strong>Net Profit:</strong>
                <div style={{ color: profitData.netProfit >= 0 ? '#10b981' : '#ef4444', fontWeight: 'bold' }}>
                  ${profitData.netProfit.toFixed(2)}
                </div>
              </div>
              <div>
                <strong>Profit Margin:</strong>
                <div style={{ color: profitData.profitMargin >= 0 ? '#10b981' : '#ef4444', fontWeight: 'bold' }}>
                  {profitData.profitMargin.toFixed(1)}%
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Sidebar */}
        <div>
          {/* Buyer Information */}
          <div className="card">
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <User size={18} />
              Buyer Information
            </h3>
            <div style={{ marginTop: '1rem' }}>
              <p><strong>Name:</strong> {order.buyerName || 'N/A'}</p>
              <p><strong>Email:</strong> {order.buyerEmail || 'N/A'}</p>
              {order.buyerCounty && <p><strong>County:</strong> {order.buyerCounty}</p>}
              {order.isBusinessOrder && order.buyerTaxInfo?.companyLegalName && (
                <p><strong>Company:</strong> {order.buyerTaxInfo.companyLegalName}</p>
              )}
            </div>
          </div>

          {/* Shipping Address */}
          <div className="card" style={{ marginTop: '1rem' }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <MapPin size={18} />
              Shipping Address
            </h3>
            {order.shippingAddress ? (
              <div style={{ marginTop: '1rem' }}>
                <p>{order.shippingAddress.name}</p>
                <p>{order.shippingAddress.addressLine1}</p>
                {order.shippingAddress.addressLine2 && <p>{order.shippingAddress.addressLine2}</p>}
                {order.shippingAddress.addressLine3 && <p>{order.shippingAddress.addressLine3}</p>}
                <p>
                  {order.shippingAddress.city}
                  {order.shippingAddress.city && order.shippingAddress.stateOrRegion && ', '}
                  {order.shippingAddress.stateOrRegion} {order.shippingAddress.postalCode}
                </p>
                <p>{order.shippingAddress.countryCode}</p>
                {order.shippingAddress.phone && <p><strong>Phone:</strong> {order.shippingAddress.phone}</p>}
              </div>
            ) : (
              <p>No shipping address available.</p>
            )}
          </div>

          {/* Payment Information */}
          {order.paymentMethod && (
            <div className="card" style={{ marginTop: '1rem' }}>
              <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                <CreditCard size={18} />
                Payment Information
              </h3>
              <div style={{ marginTop: '1rem' }}>
                <p><strong>Method:</strong> {order.paymentMethod}</p>
                {order.paymentMethodDetails && (
                  <p><strong>Details:</strong> {order.paymentMethodDetails.paymentMethodDetail}</p>
                )}
                {order.paymentExecutionDetail && order.paymentExecutionDetail.length > 0 && (
                  <div style={{ marginTop: '0.5rem' }}>
                    <strong>Payment Breakdown:</strong>
                    {order.paymentExecutionDetail.map((payment, index) => (
                      <div key={index} style={{ marginTop: '0.25rem', fontSize: '0.9rem' }}>
                        {payment.paymentMethod}: ${payment.payment.amount.toFixed(2)} {payment.payment.currencyCode}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          )}

          {/* Order Timeline */}
          <div className="card" style={{ marginTop: '1rem' }}>
            <h3 style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
              <Clock size={18} />
              Order Timeline
            </h3>
            <div style={{ marginTop: '1rem' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#10b981' }}></div>
                <span style={{ fontSize: '0.9rem' }}>
                  <strong>Ordered:</strong> {formatOrderDateTime(order.purchaseDate)}
                </span>
              </div>
              {order.lastUpdateDate && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginBottom: '0.5rem' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#3b82f6' }}></div>
                  <span style={{ fontSize: '0.9rem' }}>
                    <strong>Last Updated:</strong> {formatOrderDateTime(order.lastUpdateDate)}
                  </span>
                </div>
              )}
              {order.lastSynced && (
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem' }}>
                  <div style={{ width: '8px', height: '8px', borderRadius: '50%', backgroundColor: '#8b5cf6' }}></div>
                  <span style={{ fontSize: '0.9rem' }}>
                    <strong>Last Synced:</strong> {new Date(order.lastSynced).toLocaleString()}
                  </span>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
