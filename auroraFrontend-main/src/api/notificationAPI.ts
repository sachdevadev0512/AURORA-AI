import axios from 'axios';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || 'http://localhost:5000/api',
  timeout: 10000,
});

// Add JWT token to all requests
api.interceptors.request.use((config) => {
  const token = localStorage.getItem('aurora_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

export const notificationAPI = {
  // Subscribe to Amazon order notifications
  subscribe: async () => {
    const response = await api.post('/notifications/subscribe', {});
    return response.data;
  },

  // Unsubscribe from notifications
  unsubscribe: async () => {
    const response = await api.post('/notifications/unsubscribe', {});
    return response.data;
  },

  // Get subscription status
  getStatus: async () => {
    const response = await api.get('/notifications/status');
    return response.data;
  },

  getSqsStatus: async () => {
    const response = await api.get('/notifications/sqs/status');
    return response.data;
  },

  getOrderNotificationStatus: async () => {
    const response = await api.get('/notifications/status');
    return response.data;
  },

  repairNotifications: async () => {
    const response = await api.post('/notifications/repair', {});
    return response.data;
  },

  provisionSqs: async () => {
    const response = await api.post('/notifications/sqs/provision', {});
    return response.data;
  },

  getFlowDiagnostics: async () => {
    const response = await api.get('/notifications/flow');
    return response.data;
  },

  simulateOrderChange: async (amazonOrderId?: string, orderStatus?: string) => {
    const response = await api.post('/notifications/test/simulate-order-change', {
      amazonOrderId,
      orderStatus,
    });
    return response.data;
  },

  // Manually sync orders (fallback)
  syncOrders: async () => {
    const response = await api.post('/notifications/sync', {});
    return response.data;
  },
};

export default notificationAPI;
