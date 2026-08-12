import { Navigate, Route, Routes } from 'react-router-dom';
import { useAuth } from './context/AuthContext';
import Layout from './components/Layout';
import Dashboard from './pages/Dashboard';
import Login from './pages/Login';
import Register from './pages/Register';
import Products from './pages/Products';
import ProductDetail from './pages/ProductDetail';
import Orders from './pages/Orders';
import OrderDetail from './pages/OrderDetail';
import Shipments from './pages/Shipments';
import ShipmentDetail from './pages/ShipmentDetail';
import Settings from './pages/Settings';
import AmazonIntegration from './pages/AmazonIntegration';
import Ads from './pages/Ads';
import AdDetail from './pages/AdDetail';
import CreateCampaign from './pages/CreateCampaign';
import AmazonOAuthCallback from './pages/AmazonOAuthCallback';
import NotFound from './pages/NotFound';
import AIAssistant from './pages/AIAssistant';
import Pricing from './pages/Pricing';
import Repricer from './pages/Repricer';
import Home from './pages/Home';
import ProtectedRoute from './components/ProtectedRoute';
import { NotificationProvider } from './context/NotificationContext';

function App() {
  const { user } = useAuth();

  return (
    <Routes>
      <Route path="/login" element={user ? <Navigate to="/" replace /> : <Login />} />
      <Route path="/register" element={user ? <Navigate to="/" replace /> : <Register />} />
      <Route path="/amazon-oauth-callback" element={<AmazonOAuthCallback />} />
      <Route
        path="/*"
        element={
          <ProtectedRoute>
            <NotificationProvider>
              <Layout>
                <Routes>
                <Route path="/" element={<Home />} />
                <Route path="/dashboard" element={<Dashboard />} />
                <Route path="/products" element={<Products />} />
                <Route path="/products/:id" element={<ProductDetail />} />
                <Route path="/orders" element={<Orders />} />
                <Route path="/orders/:id" element={<OrderDetail />} />
                <Route path="/shipments" element={<Shipments />} />
                <Route path="/shipments/:id" element={<ShipmentDetail />} />
                <Route path="/ads" element={<Ads />} />
                <Route path="/ads/create" element={<CreateCampaign />} />
                <Route path="/ads/:id" element={<AdDetail />} />
                <Route path="/settings" element={<Settings />} />
                <Route path="/integration" element={<AmazonIntegration />} />
                <Route path="/ai" element={<AIAssistant />} />
                <Route path="/pricing" element={<Pricing />} />
                <Route path="/repricer" element={<Repricer />} />
                <Route path="*" element={<NotFound />} />
              </Routes>
            </Layout>
            </NotificationProvider>
          </ProtectedRoute>
        }
      />
    </Routes>
  );
}

export default App;
