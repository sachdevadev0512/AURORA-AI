import React, { useState, useEffect } from 'react';
import { useParams, Link } from 'react-router-dom';
import { getAd, updateAd } from '../api';
import { useAuth } from '../context/AuthContext';
import { Ad } from '../types';
import StatCard from '../components/StatCard';

const AdDetail: React.FC = () => {
  const { id } = useParams<{ id: string }>();
  const { token } = useAuth();
  const [ad, setAd] = useState<Ad | null>(null);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(false);
  const [formData, setFormData] = useState<Partial<Ad>>({});

  useEffect(() => {
    if (id && token) {
      fetchAd();
    }
  }, [id, token]);

  const fetchAd = async () => {
    if (!token || !id) return;
    setLoading(true);
    try {
      const data = await getAd(token, id);
      setAd(data);
      setFormData(data);
    } catch (error) {
      console.error('Failed to fetch ad:', error);
    } finally {
      setLoading(false);
    }
  };

  const handleUpdate = async () => {
    if (!token || !id) return;
    try {
      const updatedAd = await updateAd(token, id, formData);
      setAd(updatedAd);
      setEditing(false);
    } catch (error) {
      console.error('Failed to update ad:', error);
    }
  };

  if (loading) return <div>Loading...</div>;
  if (!ad) return <div>Ad not found</div>;

  return (
    <div className="container mx-auto px-4 py-8">
      <div className="flex justify-between items-center mb-6">
        <h1 className="text-3xl font-bold">{ad.campaignName}</h1>
        <div className="flex gap-2">
          <button
            onClick={() => setEditing(!editing)}
            className="bg-blue-500 hover:bg-blue-700 text-white font-bold py-2 px-4 rounded"
          >
            {editing ? 'Cancel' : 'Edit'}
          </button>
          <Link
            to="/ads"
            className="bg-gray-500 hover:bg-gray-700 text-white font-bold py-2 px-4 rounded"
          >
            Back to Ads
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4 mb-6">
        <StatCard title="Impressions" value={ad.impressions || 0} />
        <StatCard title="Clicks" value={ad.clicks || 0} />
        <StatCard title="CTR" value={`${ad.ctr || 0}%`} />
        <StatCard title="Spend" value={ad.spend ? `${ad.spend.amount} ${ad.spend.currencyCode}` : 'N/A'} />
        <StatCard title="Sales" value={ad.sales ? `${ad.sales.amount} ${ad.sales.currencyCode}` : 'N/A'} />
        <StatCard title="Orders" value={ad.orders || 0} />
        <StatCard title="ACOS" value={`${ad.acos || 0}%`} />
        <StatCard title="ROAS" value={ad.roas || 0} />
      </div>

      {editing ? (
        <div className="bg-white p-6 rounded shadow">
          <h2 className="text-xl font-bold mb-4">Edit Ad</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div>
              <label className="label">Campaign Name</label>
              <input
                type="text"
                className="input"
                value={formData.campaignName || ''}
                onChange={(e) => setFormData({ ...formData, campaignName: e.target.value })}
              />
            </div>
            <div>
              <label className="label">Status</label>
              <select
                className="input"
                value={formData.status || ''}
                onChange={(e) => setFormData({ ...formData, status: e.target.value as Ad['status'] })}
              >
                <option value="Active">Active</option>
                <option value="Paused">Paused</option>
                <option value="Archived">Archived</option>
              </select>
            </div>
            <div>
              <label className="label">Campaign Type</label>
              <select
                className="input"
                value={formData.campaignType || ''}
                onChange={(e) => setFormData({ ...formData, campaignType: e.target.value as Ad['campaignType'] })}
              >
                <option value="Sponsored Products">Sponsored Products</option>
                <option value="Sponsored Brands">Sponsored Brands</option>
                <option value="Sponsored Display">Sponsored Display</option>
              </select>
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Portfolio</label>
              <input
                type="text"
                value={formData.portfolio || ''}
                onChange={(e) => setFormData({ ...formData, portfolio: e.target.value })}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Budget Amount</label>
              <input
                type="number"
                value={formData.budget?.amount || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  budget: { amount: parseFloat(e.target.value), currencyCode: formData.budget?.currencyCode || 'USD' }
                })}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm"
              />
            </div>
            <div>
              <label className="block text-sm font-medium text-gray-700">Budget Currency</label>
              <input
                type="text"
                value={formData.budget?.currencyCode || ''}
                onChange={(e) => setFormData({
                  ...formData,
                  budget: { amount: formData.budget?.amount || 0, currencyCode: e.target.value }
                })}
                className="mt-1 block w-full border-gray-300 rounded-md shadow-sm"
              />
            </div>
          </div>
          <div className="mt-4">
            <button
              onClick={handleUpdate}
              className="bg-green-500 hover:bg-green-700 text-white font-bold py-2 px-4 rounded"
            >
              Save Changes
            </button>
          </div>
        </div>
      ) : (
        <div className="bg-white p-6 rounded shadow">
          <h2 className="text-xl font-bold mb-4">Ad Details</h2>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            <div><strong>Campaign ID:</strong> {ad.campaignId}</div>
            <div><strong>Status:</strong> {ad.status}</div>
            <div><strong>Campaign Type:</strong> {ad.campaignType}</div>
            <div><strong>Country:</strong> {ad.country || 'N/A'}</div>
            <div><strong>Portfolio:</strong> {ad.portfolio || 'N/A'}</div>
            <div><strong>Start Date:</strong> {ad.startDate ? new Date(ad.startDate).toLocaleDateString() : 'N/A'}</div>
            <div><strong>End Date:</strong> {ad.endDate ? new Date(ad.endDate).toLocaleDateString() : 'N/A'}</div>
            <div><strong>Budget:</strong> {ad.budget ? `${ad.budget.amount} ${ad.budget.currencyCode}` : 'N/A'}</div>
            <div><strong>Last Synced:</strong> {ad.lastSynced ? new Date(ad.lastSynced).toLocaleString() : 'N/A'}</div>
          </div>
        </div>
      )}
    </div>
  );
};

export default AdDetail;
