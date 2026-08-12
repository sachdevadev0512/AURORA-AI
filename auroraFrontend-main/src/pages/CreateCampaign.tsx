import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { ArrowLeft, ChevronLeft, ChevronRight, Plus, Search, Trash2 } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  createAmazonCampaign,
  getAdsPortfolios,
  getAdsProfiles,
  getProducts,
} from '../api';
import {
  CampaignAdGroupInput,
  CampaignType,
  CreateCampaignPayload,
  Product,
  SbCreativeInput,
} from '../types';
import { getProductPrimaryImage } from '../utils/amazonListing';

const STEPS = ['Setup', 'Campaign', 'Targeting', 'Review'];

const CAMPAIGN_TYPES: { value: CampaignType; label: string; description: string }[] = [
  {
    value: 'Sponsored Products',
    label: 'Sponsored Products',
    description: 'Promote individual product listings with keyword or automatic targeting.',
  },
  {
    value: 'Sponsored Brands',
    label: 'Sponsored Brands',
    description: 'Showcase your brand with a custom headline and product collection.',
  },
  {
    value: 'Sponsored Display',
    label: 'Sponsored Display',
    description: 'Reach shoppers on and off Amazon with product or audience targeting.',
  },
];

function todayInputValue() {
  return new Date().toISOString().slice(0, 10);
}

function defaultAdGroup(name = 'Ad Group 1'): CampaignAdGroupInput {
  return {
    name,
    defaultBid: 0.75,
    productAds: [{ sku: '', asin: '' }],
    keywords: [],
    negativeKeywords: [],
    bidOptimization: 'clicks',
    tactic: 'T00020',
  };
}

function defaultSbCreative(): SbCreativeInput {
  return {
    brandName: '',
    headline: '',
    asins: [''],
    name: 'Aurora SB Ad',
  };
}

export default function CreateCampaign() {
  const { token, user } = useAuth();
  const navigate = useNavigate();

  const [step, setStep] = useState(0);
  const [loading, setLoading] = useState(false);
  const [profilesLoading, setProfilesLoading] = useState(false);
  const [portfoliosLoading, setPortfoliosLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [profiles, setProfiles] = useState<Awaited<ReturnType<typeof getAdsProfiles>>['profiles']>([]);
  const [portfolios, setPortfolios] = useState<Awaited<ReturnType<typeof getAdsPortfolios>>['portfolios']>([]);

  const [campaignType, setCampaignType] = useState<CampaignType>('Sponsored Products');
  const [profileId, setProfileId] = useState('');
  const [campaign, setCampaign] = useState({
    name: '',
    state: 'Active' as const,
    startDate: todayInputValue(),
    endDate: '',
    dailyBudget: 10,
    portfolioId: '',
    targetingType: 'MANUAL' as 'AUTO' | 'MANUAL',
    biddingStrategy: 'LEGACY_FOR_SALES' as 'LEGACY_FOR_SALES' | 'AUTO_FOR_SALES' | 'MANUAL',
    placementBidding: [] as { placement: string; percentage: number }[],
    brandEntityId: '',
    costType: 'cpc' as 'cpc' | 'vcpm',
    tactic: 'T00020' as 'T00020' | 'T00030',
  });
  const [adGroups, setAdGroups] = useState<CampaignAdGroupInput[]>([defaultAdGroup()]);
  const [sbCreative, setSbCreative] = useState<SbCreativeInput>(defaultSbCreative());

  const [productPickerOpen, setProductPickerOpen] = useState(false);
  const [productPickerGroupIndex, setProductPickerGroupIndex] = useState(0);
  const [productSearch, setProductSearch] = useState('');
  const [productResults, setProductResults] = useState<Product[]>([]);
  const [productSearchLoading, setProductSearchLoading] = useState(false);

  const selectedProfile = useMemo(
    () => profiles.find((profile) => profile.profileId === profileId),
    [profiles, profileId],
  );

  const loadProfiles = useCallback(async () => {
    if (!token) return;
    try {
      setProfilesLoading(true);
      const data = await getAdsProfiles(token);
      setProfiles(data.profiles || []);
      if (data.profiles?.length === 1) {
        setProfileId(data.profiles[0].profileId);
      }
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setProfilesLoading(false);
    }
  }, [token]);

  const loadPortfolios = useCallback(async () => {
    if (!token || !profileId) {
      setPortfolios([]);
      return;
    }
    try {
      setPortfoliosLoading(true);
      const data = await getAdsPortfolios(token, profileId);
      setPortfolios(data.portfolios || []);
    } catch {
      setPortfolios([]);
    } finally {
      setPortfoliosLoading(false);
    }
  }, [token, profileId]);

  useEffect(() => {
    void loadProfiles();
  }, [loadProfiles]);

  useEffect(() => {
    void loadPortfolios();
  }, [loadPortfolios]);

  useEffect(() => {
    if (campaignType === 'Sponsored Brands') {
      setAdGroups((groups) => (groups.length > 1 ? [groups[0]] : groups));
    }
  }, [campaignType]);

  const searchProducts = async () => {
    if (!token) return;
    try {
      setProductSearchLoading(true);
      const response = await getProducts(token, 1, 20, productSearch || undefined);
      setProductResults(response.data || []);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setProductSearchLoading(false);
    }
  };

  const openProductPicker = (groupIndex: number) => {
    setProductPickerGroupIndex(groupIndex);
    setProductPickerOpen(true);
    setProductSearch('');
    setProductResults([]);
  };

  const addProductToGroup = (product: Product) => {
    setAdGroups((groups) =>
      groups.map((group, index) => {
        if (index !== productPickerGroupIndex) return group;
        const existing = group.productAds.filter((ad) => ad.sku || ad.asin);
        const next = [...existing, { sku: product.sku, asin: product.asin }];
        return { ...group, productAds: next.length ? next : [{ sku: product.sku, asin: product.asin }] };
      }),
    );
    setProductPickerOpen(false);
  };

  const updateAdGroup = (index: number, patch: Partial<CampaignAdGroupInput>) => {
    setAdGroups((groups) => groups.map((group, i) => (i === index ? { ...group, ...patch } : group)));
  };

  const addAdGroup = () => {
    setAdGroups((groups) => [...groups, defaultAdGroup(`Ad Group ${groups.length + 1}`)]);
  };

  const removeAdGroup = (index: number) => {
    setAdGroups((groups) => (groups.length <= 1 ? groups : groups.filter((_, i) => i !== index)));
  };

  const validateStep = (currentStep: number): string | null => {
    if (currentStep === 0) {
      if (!profileId) return 'Select an advertising profile.';
      return null;
    }
    if (currentStep === 1) {
      if (!campaign.name.trim()) return 'Campaign name is required.';
      if (!campaign.startDate) return 'Start date is required.';
      if (campaign.dailyBudget < 1) return 'Daily budget must be at least 1.';
      return null;
    }
    if (currentStep === 2) {
      for (const group of adGroups) {
        if (!group.name.trim()) return 'Each ad group needs a name.';
        if (group.defaultBid < 0.02) return 'Default bid must be at least 0.02.';
        const validAds = group.productAds.filter((ad) => ad.sku?.trim() || ad.asin?.trim());
        if (validAds.length === 0) {
          return `Ad group "${group.name}" needs at least one product (SKU or ASIN).`;
        }
        if (
          campaignType === 'Sponsored Products' &&
          campaign.targetingType === 'MANUAL' &&
          group.keywords.length === 0
        ) {
          return `Manual SP ad group "${group.name}" needs at least one keyword, or switch targeting to Automatic.`;
        }
      }
      if (campaignType === 'Sponsored Brands') {
        if (!sbCreative.brandName.trim()) return 'Brand name is required for Sponsored Brands.';
        if (!sbCreative.headline.trim()) return 'Headline is required for Sponsored Brands.';
        const asins = sbCreative.asins.filter((asin) => asin.trim());
        if (asins.length === 0) return 'Add at least one ASIN for Sponsored Brands creative.';
      }
      return null;
    }
    return null;
  };

  const goNext = () => {
    const error = validateStep(step);
    if (error) {
      setMessage(error);
      return;
    }
    setMessage('');
    setStep((value) => Math.min(value + 1, STEPS.length - 1));
  };

  const goBack = () => {
    setMessage('');
    setStep((value) => Math.max(value - 1, 0));
  };

  const buildPayload = (): CreateCampaignPayload => {
    const cleanedGroups = adGroups.map((group) => ({
      ...group,
      productAds: group.productAds.filter((ad) => ad.sku?.trim() || ad.asin?.trim()),
      keywords: group.keywords.filter((keyword) => keyword.keywordText.trim()),
      negativeKeywords: group.negativeKeywords.filter((keyword) => keyword.keywordText.trim()),
    }));

    const payload: CreateCampaignPayload = {
      profileId,
      campaignType,
      campaign: {
        ...campaign,
        portfolioId: campaign.portfolioId || undefined,
        endDate: campaign.endDate || undefined,
        brandEntityId: campaign.brandEntityId || undefined,
        targetingType: campaignType === 'Sponsored Products' ? campaign.targetingType : undefined,
        biddingStrategy: campaignType === 'Sponsored Products' ? campaign.biddingStrategy : undefined,
        placementBidding:
          campaignType === 'Sponsored Products' && campaign.placementBidding.length
            ? campaign.placementBidding
            : undefined,
        costType: campaignType === 'Sponsored Display' ? campaign.costType : undefined,
        tactic: campaignType === 'Sponsored Display' ? campaign.tactic : undefined,
      },
      adGroups: cleanedGroups,
    };

    if (campaignType === 'Sponsored Brands') {
      payload.sbCreative = {
        ...sbCreative,
        asins: sbCreative.asins.filter((asin) => asin.trim()),
      };
    }

    return payload;
  };

  const handleSubmit = async () => {
    const error = validateStep(2);
    if (error) {
      setMessage(error);
      setStep(2);
      return;
    }
    if (!token) return;

    try {
      setLoading(true);
      setMessage('Creating campaign on Amazon…');
      const result = await createAmazonCampaign(token, buildPayload());
      setMessage(result.message);
      navigate(`/ads/${result.ad._id}`);
    } catch (err) {
      setMessage((err as Error).message);
    } finally {
      setLoading(false);
    }
  };

  const renderPlacementRow = (placement: string, label: string) => {
    const existing = campaign.placementBidding.find((row) => row.placement === placement);
    const percentage = existing?.percentage ?? 0;

    return (
      <div key={placement} style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', marginBottom: '0.5rem' }}>
        <span style={{ flex: 1 }}>{label}</span>
        <input
          className="input"
          type="number"
          min={0}
          max={900}
          value={percentage}
          onChange={(e) => {
            const value = Number(e.target.value);
            setCampaign((prev) => {
              const rest = prev.placementBidding.filter((row) => row.placement !== placement);
              if (value > 0) rest.push({ placement, percentage: value });
              return { ...prev, placementBidding: rest };
            });
          }}
          style={{ width: '120px' }}
        />
        <span>%</span>
      </div>
    );
  };

  return (
    <div className="container">
      <div className="page-header">
        <div>
          <Link to="/ads" className="btn secondary" style={{ marginBottom: '0.75rem', display: 'inline-flex', gap: '0.35rem' }}>
            <ArrowLeft size={16} />
            Back to campaigns
          </Link>
          <h1>Create Amazon Campaign</h1>
          <p>Build Sponsored Products, Brands, or Display campaigns directly on Amazon from Aurora.</p>
        </div>
      </div>

      {user && !user.hasAmazonAdsConnected && (
        <div className="alert alert-warning" style={{ marginBottom: '1rem' }}>
          Connect <strong>Amazon Ads</strong> on <Link to="/integration">Integration</Link> before creating campaigns.
        </div>
      )}

      {message && (
        <div className="alert" style={{ marginBottom: '1rem', whiteSpace: 'pre-wrap' }}>
          {message}
        </div>
      )}

      <div className="card" style={{ marginBottom: '1rem' }}>
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {STEPS.map((label, index) => (
            <div
              key={label}
              style={{
                padding: '0.35rem 0.75rem',
                borderRadius: '999px',
                background: index === step ? '#2563eb' : index < step ? '#dbeafe' : '#f3f4f6',
                color: index === step ? '#fff' : '#374151',
                fontWeight: index === step ? 600 : 500,
                fontSize: '0.875rem',
              }}
            >
              {index + 1}. {label}
            </div>
          ))}
        </div>
      </div>

      {step === 0 && (
        <div className="card">
          <h2>Campaign type & profile</h2>
          <div style={{ display: 'grid', gap: '0.75rem', marginBottom: '1.5rem' }}>
            {CAMPAIGN_TYPES.map((type) => (
              <label
                key={type.value}
                style={{
                  display: 'flex',
                  gap: '0.75rem',
                  padding: '1rem',
                  border: campaignType === type.value ? '2px solid #2563eb' : '1px solid #e5e7eb',
                  borderRadius: '8px',
                  cursor: 'pointer',
                }}
              >
                <input
                  type="radio"
                  name="campaignType"
                  checked={campaignType === type.value}
                  onChange={() => setCampaignType(type.value)}
                />
                <div>
                  <strong>{type.label}</strong>
                  <p style={{ margin: '0.25rem 0 0', color: '#6b7280' }}>{type.description}</p>
                </div>
              </label>
            ))}
          </div>

          <div>
            <label className="label">Advertising profile</label>
            <select
              className="input"
              value={profileId}
              onChange={(e) => setProfileId(e.target.value)}
              disabled={profilesLoading}
            >
              <option value="">{profilesLoading ? 'Loading profiles…' : 'Select profile'}</option>
              {profiles.map((profile) => (
                <option key={profile.profileId} value={profile.profileId}>
                  {profile.name || profile.profileId} — {profile.countryCode || '?'}{' '}
                  {profile.currencyCode ? `(${profile.currencyCode})` : ''}
                </option>
              ))}
            </select>
            {selectedProfile && (
              <p style={{ marginTop: '0.5rem', color: '#6b7280', fontSize: '0.875rem' }}>
                Profile ID {selectedProfile.profileId}
                {selectedProfile.timezone ? ` · ${selectedProfile.timezone}` : ''}
              </p>
            )}
          </div>
        </div>
      )}

      {step === 1 && (
        <div className="card">
          <h2>Campaign settings</h2>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
            <div style={{ gridColumn: '1 / -1' }}>
              <label className="label">Campaign name</label>
              <input
                className="input"
                value={campaign.name}
                onChange={(e) => setCampaign((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="e.g. Aurora SP — Brand Keywords"
              />
            </div>

            <div>
              <label className="label">Status</label>
              <select
                className="input"
                value={campaign.state}
                onChange={(e) => setCampaign((prev) => ({ ...prev, state: e.target.value as typeof campaign.state }))}
              >
                <option value="Active">Active</option>
                <option value="Paused">Paused</option>
              </select>
            </div>

            <div>
              <label className="label">Daily budget ({selectedProfile?.currencyCode || 'USD'})</label>
              <input
                className="input"
                type="number"
                min={1}
                step={0.01}
                value={campaign.dailyBudget}
                onChange={(e) => setCampaign((prev) => ({ ...prev, dailyBudget: Number(e.target.value) }))}
              />
            </div>

            <div>
              <label className="label">Start date</label>
              <input
                className="input"
                type="date"
                value={campaign.startDate}
                onChange={(e) => setCampaign((prev) => ({ ...prev, startDate: e.target.value }))}
              />
            </div>

            <div>
              <label className="label">End date (optional)</label>
              <input
                className="input"
                type="date"
                value={campaign.endDate}
                onChange={(e) => setCampaign((prev) => ({ ...prev, endDate: e.target.value }))}
              />
            </div>

            <div>
              <label className="label">Portfolio (optional)</label>
              <select
                className="input"
                value={campaign.portfolioId}
                onChange={(e) => setCampaign((prev) => ({ ...prev, portfolioId: e.target.value }))}
                disabled={portfoliosLoading}
              >
                <option value="">{portfoliosLoading ? 'Loading…' : 'No portfolio'}</option>
                {portfolios.map((portfolio) => (
                  <option key={portfolio.portfolioId} value={portfolio.portfolioId}>
                    {portfolio.name}
                  </option>
                ))}
              </select>
            </div>

            {campaignType === 'Sponsored Products' && (
              <>
                <div>
                  <label className="label">Targeting</label>
                  <select
                    className="input"
                    value={campaign.targetingType}
                    onChange={(e) =>
                      setCampaign((prev) => ({
                        ...prev,
                        targetingType: e.target.value as 'AUTO' | 'MANUAL',
                      }))
                    }
                  >
                    <option value="MANUAL">Manual (keywords)</option>
                    <option value="AUTO">Automatic</option>
                  </select>
                </div>

                <div>
                  <label className="label">Bidding strategy</label>
                  <select
                    className="input"
                    value={campaign.biddingStrategy}
                    onChange={(e) =>
                      setCampaign((prev) => ({
                        ...prev,
                        biddingStrategy: e.target.value as typeof campaign.biddingStrategy,
                      }))
                    }
                  >
                    <option value="LEGACY_FOR_SALES">Dynamic bids — down only</option>
                    <option value="AUTO_FOR_SALES">Dynamic bids — up and down</option>
                    <option value="MANUAL">Fixed bids</option>
                  </select>
                </div>
              </>
            )}

            {campaignType === 'Sponsored Brands' && (
              <div style={{ gridColumn: '1 / -1' }}>
                <label className="label">Brand entity ID (optional)</label>
                <input
                  className="input"
                  value={campaign.brandEntityId}
                  onChange={(e) => setCampaign((prev) => ({ ...prev, brandEntityId: e.target.value }))}
                  placeholder="From Amazon Brand Registry if required"
                />
              </div>
            )}

            {campaignType === 'Sponsored Display' && (
              <>
                <div>
                  <label className="label">Tactic</label>
                  <select
                    className="input"
                    value={campaign.tactic}
                    onChange={(e) =>
                      setCampaign((prev) => ({ ...prev, tactic: e.target.value as 'T00020' | 'T00030' }))
                    }
                  >
                    <option value="T00020">Product targeting</option>
                    <option value="T00030">Audience / remarketing</option>
                  </select>
                </div>
                <div>
                  <label className="label">Cost type</label>
                  <select
                    className="input"
                    value={campaign.costType}
                    onChange={(e) =>
                      setCampaign((prev) => ({ ...prev, costType: e.target.value as 'cpc' | 'vcpm' }))
                    }
                  >
                    <option value="cpc">CPC</option>
                    <option value="vcpm">vCPM</option>
                  </select>
                </div>
              </>
            )}
          </div>

          {campaignType === 'Sponsored Products' && (
            <div style={{ marginTop: '1.5rem' }}>
              <h3>Placement bid adjustments</h3>
              <p style={{ color: '#6b7280', fontSize: '0.875rem' }}>
                Optional percentage increases for top of search, product pages, and rest of search.
              </p>
              {renderPlacementRow('PLACEMENT_TOP', 'Top of search')}
              {renderPlacementRow('PLACEMENT_PRODUCT_PAGE', 'Product pages')}
              {renderPlacementRow('PLACEMENT_REST_OF_SEARCH', 'Rest of search')}
            </div>
          )}
        </div>
      )}

      {step === 2 && (
        <div style={{ display: 'grid', gap: '1rem' }}>
          {campaignType === 'Sponsored Brands' && (
            <div className="card">
              <h2>Brand creative</h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem' }}>
                <div>
                  <label className="label">Brand name</label>
                  <input
                    className="input"
                    value={sbCreative.brandName}
                    onChange={(e) => setSbCreative((prev) => ({ ...prev, brandName: e.target.value }))}
                  />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label className="label">Headline (max 50 chars)</label>
                  <input
                    className="input"
                    maxLength={50}
                    value={sbCreative.headline}
                    onChange={(e) => setSbCreative((prev) => ({ ...prev, headline: e.target.value }))}
                  />
                </div>
                <div style={{ gridColumn: '1 / -1' }}>
                  <label className="label">ASINs (1–3)</label>
                  {sbCreative.asins.map((asin, index) => (
                    <div key={index} style={{ display: 'flex', gap: '0.5rem', marginBottom: '0.5rem' }}>
                      <input
                        className="input"
                        value={asin}
                        onChange={(e) =>
                          setSbCreative((prev) => ({
                            ...prev,
                            asins: prev.asins.map((value, i) => (i === index ? e.target.value : value)),
                          }))
                        }
                        placeholder="B0XXXXXXXXX"
                      />
                      {sbCreative.asins.length > 1 && (
                        <button
                          type="button"
                          className="btn secondary"
                          onClick={() =>
                            setSbCreative((prev) => ({
                              ...prev,
                              asins: prev.asins.filter((_, i) => i !== index),
                            }))
                          }
                        >
                          <Trash2 size={14} />
                        </button>
                      )}
                    </div>
                  ))}
                  {sbCreative.asins.length < 3 && (
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => setSbCreative((prev) => ({ ...prev, asins: [...prev.asins, ''] }))}
                    >
                      <Plus size={14} /> Add ASIN
                    </button>
                  )}
                </div>
              </div>
            </div>
          )}

          {adGroups.map((group, groupIndex) => (
            <div className="card" key={groupIndex}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h2 style={{ margin: 0 }}>Ad group {groupIndex + 1}</h2>
                {campaignType !== 'Sponsored Brands' && adGroups.length > 1 && (
                  <button type="button" className="btn secondary" onClick={() => removeAdGroup(groupIndex)}>
                    <Trash2 size={14} /> Remove
                  </button>
                )}
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '1rem' }}>
                <div>
                  <label className="label">Name</label>
                  <input
                    className="input"
                    value={group.name}
                    onChange={(e) => updateAdGroup(groupIndex, { name: e.target.value })}
                  />
                </div>
                <div>
                  <label className="label">Default bid</label>
                  <input
                    className="input"
                    type="number"
                    min={0.02}
                    step={0.01}
                    value={group.defaultBid}
                    onChange={(e) => updateAdGroup(groupIndex, { defaultBid: Number(e.target.value) })}
                  />
                </div>
                {campaignType === 'Sponsored Display' && (
                  <div>
                    <label className="label">Bid optimization</label>
                    <select
                      className="input"
                      value={group.bidOptimization || 'clicks'}
                      onChange={(e) =>
                        updateAdGroup(groupIndex, {
                          bidOptimization: e.target.value as 'clicks' | 'conversions' | 'reach',
                        })
                      }
                    >
                      <option value="clicks">Clicks</option>
                      <option value="conversions">Conversions</option>
                      <option value="reach">Reach</option>
                    </select>
                  </div>
                )}
              </div>

              <div style={{ marginTop: '1.25rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <h3 style={{ margin: 0 }}>Products</h3>
                  <button type="button" className="btn secondary" onClick={() => openProductPicker(groupIndex)}>
                    <Search size={14} /> Pick from inventory
                  </button>
                </div>
                <p style={{ margin: '0.35rem 0 0.75rem', color: '#6b7280', fontSize: '0.875rem' }}>
                  Seller accounts advertise by SKU. When both SKU and ASIN are present, only the SKU is sent to Amazon.
                </p>
                {group.productAds.map((ad, adIndex) => (
                  <div
                    key={adIndex}
                    style={{ display: 'grid', gridTemplateColumns: '1fr 1fr auto', gap: '0.5rem', marginTop: '0.5rem' }}
                  >
                    <input
                      className="input"
                      placeholder="SKU"
                      value={ad.sku || ''}
                      onChange={(e) => {
                        const productAds = [...group.productAds];
                        productAds[adIndex] = { ...productAds[adIndex], sku: e.target.value };
                        updateAdGroup(groupIndex, { productAds });
                      }}
                    />
                    <input
                      className="input"
                      placeholder="ASIN"
                      value={ad.asin || ''}
                      onChange={(e) => {
                        const productAds = [...group.productAds];
                        productAds[adIndex] = { ...productAds[adIndex], asin: e.target.value };
                        updateAdGroup(groupIndex, { productAds });
                      }}
                    />
                    <button
                      type="button"
                      className="btn secondary"
                      onClick={() => {
                        const productAds = group.productAds.filter((_, i) => i !== adIndex);
                        updateAdGroup(groupIndex, {
                          productAds: productAds.length ? productAds : [{ sku: '', asin: '' }],
                        });
                      }}
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                ))}
                <button
                  type="button"
                  className="btn secondary"
                  style={{ marginTop: '0.5rem' }}
                  onClick={() => updateAdGroup(groupIndex, { productAds: [...group.productAds, { sku: '', asin: '' }] })}
                >
                  <Plus size={14} /> Add product row
                </button>
              </div>

              {campaignType === 'Sponsored Products' && campaign.targetingType === 'MANUAL' && (
                <div style={{ marginTop: '1.25rem' }}>
                  <h3>Keywords</h3>
                  {group.keywords.map((keyword, keywordIndex) => (
                    <div
                      key={keywordIndex}
                      style={{ display: 'grid', gridTemplateColumns: '2fr 1fr 1fr auto', gap: '0.5rem', marginTop: '0.5rem' }}
                    >
                      <input
                        className="input"
                        placeholder="Keyword"
                        value={keyword.keywordText}
                        onChange={(e) => {
                          const keywords = [...group.keywords];
                          keywords[keywordIndex] = { ...keywords[keywordIndex], keywordText: e.target.value };
                          updateAdGroup(groupIndex, { keywords });
                        }}
                      />
                      <select
                        className="input"
                        value={keyword.matchType}
                        onChange={(e) => {
                          const keywords = [...group.keywords];
                          keywords[keywordIndex] = {
                            ...keywords[keywordIndex],
                            matchType: e.target.value as 'EXACT' | 'PHRASE' | 'BROAD',
                          };
                          updateAdGroup(groupIndex, { keywords });
                        }}
                      >
                        <option value="EXACT">Exact</option>
                        <option value="PHRASE">Phrase</option>
                        <option value="BROAD">Broad</option>
                      </select>
                      <input
                        className="input"
                        type="number"
                        min={0.02}
                        step={0.01}
                        placeholder="Bid"
                        value={keyword.bid ?? ''}
                        onChange={(e) => {
                          const keywords = [...group.keywords];
                          keywords[keywordIndex] = {
                            ...keywords[keywordIndex],
                            bid: e.target.value ? Number(e.target.value) : undefined,
                          };
                          updateAdGroup(groupIndex, { keywords });
                        }}
                      />
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={() =>
                          updateAdGroup(groupIndex, {
                            keywords: group.keywords.filter((_, i) => i !== keywordIndex),
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ marginTop: '0.5rem' }}
                    onClick={() =>
                      updateAdGroup(groupIndex, {
                        keywords: [...group.keywords, { keywordText: '', matchType: 'EXACT', bid: group.defaultBid }],
                      })
                    }
                  >
                    <Plus size={14} /> Add keyword
                  </button>
                </div>
              )}

              {campaignType === 'Sponsored Products' && (
                <div style={{ marginTop: '1.25rem' }}>
                  <h3>Negative keywords</h3>
                  {group.negativeKeywords.map((keyword, keywordIndex) => (
                    <div
                      key={keywordIndex}
                      style={{ display: 'grid', gridTemplateColumns: '2fr 1fr auto', gap: '0.5rem', marginTop: '0.5rem' }}
                    >
                      <input
                        className="input"
                        placeholder="Negative keyword"
                        value={keyword.keywordText}
                        onChange={(e) => {
                          const negativeKeywords = [...group.negativeKeywords];
                          negativeKeywords[keywordIndex] = {
                            ...negativeKeywords[keywordIndex],
                            keywordText: e.target.value,
                          };
                          updateAdGroup(groupIndex, { negativeKeywords });
                        }}
                      />
                      <select
                        className="input"
                        value={keyword.matchType}
                        onChange={(e) => {
                          const negativeKeywords = [...group.negativeKeywords];
                          negativeKeywords[keywordIndex] = {
                            ...negativeKeywords[keywordIndex],
                            matchType: e.target.value as 'NEGATIVE_EXACT' | 'NEGATIVE_PHRASE',
                          };
                          updateAdGroup(groupIndex, { negativeKeywords });
                        }}
                      >
                        <option value="NEGATIVE_EXACT">Negative exact</option>
                        <option value="NEGATIVE_PHRASE">Negative phrase</option>
                      </select>
                      <button
                        type="button"
                        className="btn secondary"
                        onClick={() =>
                          updateAdGroup(groupIndex, {
                            negativeKeywords: group.negativeKeywords.filter((_, i) => i !== keywordIndex),
                          })
                        }
                      >
                        <Trash2 size={14} />
                      </button>
                    </div>
                  ))}
                  <button
                    type="button"
                    className="btn secondary"
                    style={{ marginTop: '0.5rem' }}
                    onClick={() =>
                      updateAdGroup(groupIndex, {
                        negativeKeywords: [
                          ...group.negativeKeywords,
                          { keywordText: '', matchType: 'NEGATIVE_EXACT' },
                        ],
                      })
                    }
                  >
                    <Plus size={14} /> Add negative keyword
                  </button>
                </div>
              )}
            </div>
          ))}

          {campaignType !== 'Sponsored Brands' && (
            <button type="button" className="btn secondary" onClick={addAdGroup}>
              <Plus size={16} /> Add ad group
            </button>
          )}
        </div>
      )}

      {step === 3 && (
        <div className="card">
          <h2>Review</h2>
          <dl style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: '0.5rem 1rem' }}>
            <dt>Type</dt>
            <dd>{campaignType}</dd>
            <dt>Profile</dt>
            <dd>
              {selectedProfile?.name || profileId} ({selectedProfile?.countryCode})
            </dd>
            <dt>Campaign</dt>
            <dd>{campaign.name}</dd>
            <dt>Budget</dt>
            <dd>
              {campaign.dailyBudget} {selectedProfile?.currencyCode || 'USD'} / day
            </dd>
            <dt>Dates</dt>
            <dd>
              {campaign.startDate}
              {campaign.endDate ? ` → ${campaign.endDate}` : ' (no end date)'}
            </dd>
            {campaignType === 'Sponsored Products' && (
              <>
                <dt>Targeting</dt>
                <dd>{campaign.targetingType}</dd>
              </>
            )}
            <dt>Ad groups</dt>
            <dd>{adGroups.length}</dd>
            <dt>Product ads</dt>
            <dd>
              {adGroups.reduce(
                (sum, group) => sum + group.productAds.filter((ad) => ad.sku?.trim() || ad.asin?.trim()).length,
                0,
              )}
            </dd>
            {campaignType === 'Sponsored Products' && campaign.targetingType === 'MANUAL' && (
              <>
                <dt>Keywords</dt>
                <dd>{adGroups.reduce((sum, group) => sum + group.keywords.length, 0)}</dd>
              </>
            )}
          </dl>
          <p style={{ marginTop: '1rem', color: '#6b7280' }}>
            Submitting will create this campaign live on Amazon. You can sync metrics afterward from the Ads page.
          </p>
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: '1rem' }}>
        <button type="button" className="btn secondary" onClick={goBack} disabled={step === 0 || loading}>
          <ChevronLeft size={16} /> Back
        </button>
        {step < STEPS.length - 1 ? (
          <button type="button" className="btn" onClick={goNext} disabled={loading}>
            Next <ChevronRight size={16} />
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            onClick={() => void handleSubmit()}
            disabled={loading || !user?.hasAmazonAdsConnected}
          >
            {loading ? 'Creating…' : 'Create on Amazon'}
          </button>
        )}
      </div>

      {productPickerOpen && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            background: 'rgba(0,0,0,0.45)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 50,
            padding: '1rem',
          }}
          onClick={() => setProductPickerOpen(false)}
        >
          <div
            className="card"
            style={{ width: 'min(640px, 100%)', maxHeight: '80vh', overflow: 'auto' }}
            onClick={(e) => e.stopPropagation()}
          >
            <h2>Pick products</h2>
            <div style={{ display: 'flex', gap: '0.5rem', marginBottom: '1rem' }}>
              <input
                className="input"
                placeholder="Search SKU, ASIN, title…"
                value={productSearch}
                onChange={(e) => setProductSearch(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && void searchProducts()}
              />
              <button type="button" className="btn" onClick={() => void searchProducts()} disabled={productSearchLoading}>
                {productSearchLoading ? 'Searching…' : 'Search'}
              </button>
            </div>
            {productResults.length === 0 ? (
              <p style={{ color: '#6b7280' }}>Search your synced inventory to add SKUs and ASINs.</p>
            ) : (
              <div style={{ display: 'grid', gap: '0.5rem' }}>
                {productResults.map((product) => {
                  const imageUrl = getProductPrimaryImage(product);
                  return (
                    <button
                      key={product._id}
                      type="button"
                      className="btn secondary"
                      style={{
                        display: 'flex',
                        gap: '0.75rem',
                        alignItems: 'center',
                        textAlign: 'left',
                        width: '100%',
                      }}
                      onClick={() => addProductToGroup(product)}
                    >
                      {imageUrl ? (
                        <img src={imageUrl} alt="" referrerPolicy="no-referrer" style={{ width: 40, height: 40, objectFit: 'contain' }} />
                      ) : (
                        <div style={{ width: 40, height: 40, background: '#f3f4f6' }} />
                      )}
                      <div>
                        <div style={{ fontWeight: 500 }}>{product.title}</div>
                        <div style={{ fontSize: '0.875rem', color: '#6b7280' }}>
                          SKU {product.sku} · ASIN {product.asin}
                        </div>
                      </div>
                    </button>
                  );
                })}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
