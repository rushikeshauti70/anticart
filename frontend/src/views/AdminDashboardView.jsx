import React, { useState, useEffect } from 'react';
import {
  TrendingUp,
  Package,
  Scan,
  Database,
  Activity,
  AlertTriangle,
  CheckCircle2,
  RefreshCw,
  Download,
  Server,
  Cpu,
  Layers,
  ArrowUpRight,
  ArrowDownRight,
  FileSpreadsheet,
  Plus,
  Search,
  Filter,
  Radio,
  Clock,
  ShieldCheck,
  ChevronLeft,
  ChevronRight
} from 'lucide-react';
import { api } from '../api';

export function AdminDashboardView() {
  const [activeSubTab, setActiveSubTab] = useState('overview'); // 'overview' | 'inventory' | 'audit' | 'database'
  const [auditSubTab, setAuditSubTab] = useState('scans'); // 'scans' | 'movements'
  const [daysFilter, setDaysFilter] = useState(14);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [dashboardData, setDashboardData] = useState(null);
  const [healthData, setHealthData] = useState(null);
  const [errorMsg, setErrorMsg] = useState(null);
  const [successMsg, setSuccessMsg] = useState(null);

  // Audit Logs State
  const [scanLogs, setScanLogs] = useState({ data: [], total: 0, page: 1, pageSize: 15 });
  const [scanResultFilter, setScanResultFilter] = useState('');
  const [scanSearch, setScanSearch] = useState('');
  const [movementLogs, setMovementLogs] = useState({ data: [], total: 0, page: 1, pageSize: 15 });
  const [movementReasonFilter, setMovementReasonFilter] = useState('');

  // Quick Restock State
  const [restockingId, setRestockingId] = useState(null);
  const [flushLoading, setFlushLoading] = useState(false);

  useEffect(() => {
    loadDashboard();
  }, [daysFilter]);

  useEffect(() => {
    if (activeSubTab === 'audit') {
      if (auditSubTab === 'scans') loadScanLogs(1);
      else loadMovementLogs(1);
    } else if (activeSubTab === 'database') {
      loadHealth();
    }
  }, [activeSubTab, auditSubTab, scanResultFilter, movementReasonFilter]);

  async function loadDashboard() {
    try {
      setRefreshing(true);
      setErrorMsg(null);
      const res = await api.getAdminDashboard(daysFilter);
      if (res?.data) {
        setDashboardData(res.data);
      }
    } catch (err) {
      setErrorMsg(`Failed to load admin metrics: ${err.message}`);
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  async function loadHealth() {
    try {
      const res = await api.getDatabaseHealth();
      if (res?.data) setHealthData(res.data);
    } catch (err) {
      console.warn('Health check error:', err.message);
    }
  }

  async function loadScanLogs(page = 1) {
    try {
      const res = await api.getAdminScans({
        page,
        pageSize: 15,
        result: scanResultFilter,
        search: scanSearch,
      });
      if (res) setScanLogs(res);
    } catch (err) {
      console.warn('Error fetching scan logs:', err.message);
    }
  }

  async function loadMovementLogs(page = 1) {
    try {
      const res = await api.getAdminMovements({
        page,
        pageSize: 15,
        reason: movementReasonFilter,
      });
      if (res) setMovementLogs(res);
    } catch (err) {
      console.warn('Error fetching stock movements:', err.message);
    }
  }

  async function handleQuickRestock(productId, delta = 10) {
    try {
      setRestockingId(productId);
      const res = await api.quickRestock(productId, delta);
      setSuccessMsg(`Restocked +${delta} units for product successfully!`);
      setTimeout(() => setSuccessMsg(null), 4000);
      await loadDashboard();
    } catch (err) {
      setErrorMsg(`Restock failed: ${err.message}`);
    } finally {
      setRestockingId(null);
    }
  }

  async function handleFlushExcel() {
    try {
      setFlushLoading(true);
      const res = await api.triggerAdminLogFlush();
      setSuccessMsg(`Excel log flushed: ${res.flushedCount} events written to workbook!`);
      setTimeout(() => setSuccessMsg(null), 4000);
      await loadDashboard();
      if (activeSubTab === 'database') await loadHealth();
    } catch (err) {
      setErrorMsg(`Excel flush failed: ${err.message}`);
    } finally {
      setFlushLoading(false);
    }
  }

  const kpis = dashboardData?.kpis || {};
  const timeline = dashboardData?.salesTimeline || [];
  const categories = dashboardData?.categoryBreakdown || [];
  const lowStock = dashboardData?.lowStockAlerts || [];
  const recentActivity = dashboardData?.recentActivity || [];
  const fleet = dashboardData?.fleet?.['trolley-01'] || null;

  // Max revenue for scaling SVG chart
  const maxRevenue = Math.max(...timeline.map((t) => t.revenue || 0), 100);

  return (
    <div className="admin-container" style={{ padding: '1.25rem', maxWidth: '1400px', margin: '0 auto' }}>
      {/* Top Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: '1rem', marginBottom: '1.25rem' }}>
        <div>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <h1 style={{ margin: 0, fontSize: '1.5rem', fontWeight: '700', color: 'var(--text-main)' }}>Admin Operations & Analytics</h1>
            <span style={{ fontSize: '0.75rem', fontWeight: '600', padding: '2px 8px', borderRadius: '12px', backgroundColor: 'var(--accent)', color: '#0F172A' }}>
              Live Supabase
            </span>
          </div>
          <p style={{ margin: '4px 0 0', fontSize: '0.875rem', color: 'var(--text-muted)' }}>
            Real-time retail performance, trolley hardware telemetry, database health, and audit trails.
          </p>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', flexWrap: 'wrap' }}>
          {/* Timeframe Selector */}
          <div style={{ display: 'flex', backgroundColor: 'var(--bg-card)', border: '1px solid var(--border)', borderRadius: '8px', padding: '2px' }}>
            {[7, 14, 30].map((d) => (
              <button
                key={d}
                onClick={() => setDaysFilter(d)}
                style={{
                  padding: '4px 10px',
                  fontSize: '0.8rem',
                  fontWeight: daysFilter === d ? '600' : '400',
                  border: 'none',
                  borderRadius: '6px',
                  cursor: 'pointer',
                  backgroundColor: daysFilter === d ? 'var(--primary-dark)' : 'transparent',
                  color: daysFilter === d ? '#ffffff' : 'var(--text-main)',
                  transition: 'all 0.15s ease'
                }}
              >
                {d}D
              </button>
            ))}
          </div>

          {/* Refresh Button */}
          <button
            onClick={loadDashboard}
            disabled={refreshing}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '8px',
              border: '1px solid var(--border)',
              backgroundColor: 'var(--bg-card)',
              color: 'var(--text-main)',
              fontSize: '0.85rem',
              fontWeight: '500',
              cursor: refreshing ? 'not-allowed' : 'pointer'
            }}
          >
            <RefreshCw size={14} className={refreshing ? 'spin' : ''} />
            <span>Refresh</span>
          </button>

          {/* Export Excel Button */}
          <a
            href={api.getExcelDownloadUrl()}
            download
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: '6px',
              padding: '6px 12px',
              borderRadius: '8px',
              border: '1px solid #16A34A',
              backgroundColor: '#DCFCE7',
              color: '#15803D',
              fontSize: '0.85rem',
              fontWeight: '600',
              textDecoration: 'none'
            }}
          >
            <FileSpreadsheet size={15} />
            <span>Excel Log</span>
          </a>
        </div>
      </div>

      {/* Alerts / Banners */}
      {errorMsg && (
        <div style={{ padding: '10px 14px', marginBottom: '1rem', borderRadius: '8px', backgroundColor: '#FEE2E2', border: '1px solid #EF4444', color: '#991B1B', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
          <AlertTriangle size={16} />
          <span>{errorMsg}</span>
        </div>
      )}

      {successMsg && (
        <div style={{ padding: '10px 14px', marginBottom: '1rem', borderRadius: '8px', backgroundColor: '#DCFCE7', border: '1px solid #22C55E', color: '#166534', display: 'flex', alignItems: 'center', gap: '8px', fontSize: '0.85rem' }}>
          <CheckCircle2 size={16} />
          <span>{successMsg}</span>
        </div>
      )}

      {/* Sub Navigation Bar */}
      <div style={{ display: 'flex', gap: '0.5rem', borderBottom: '1px solid var(--border)', marginBottom: '1.25rem', overflowX: 'auto', paddingBottom: '2px' }}>
        {[
          { id: 'overview', label: 'Executive Overview', icon: TrendingUp },
          { id: 'inventory', label: 'Inventory Intelligence', icon: Package },
          { id: 'audit', label: 'Audit & Scan Logs', icon: Scan },
          { id: 'database', label: 'Database & Diagnostics', icon: Database },
        ].map((tab) => {
          const Icon = tab.icon;
          const isActive = activeSubTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveSubTab(tab.id)}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '8px 16px',
                fontSize: '0.875rem',
                fontWeight: isActive ? '600' : '500',
                border: 'none',
                borderBottom: isActive ? '2px solid var(--primary-dark)' : '2px solid transparent',
                backgroundColor: 'transparent',
                color: isActive ? 'var(--primary-dark)' : 'var(--text-muted)',
                cursor: 'pointer',
                whiteSpace: 'nowrap'
              }}
            >
              <Icon size={16} />
              <span>{tab.label}</span>
            </button>
          );
        })}
      </div>

      {/* TAB 1: EXECUTIVE OVERVIEW */}
      {activeSubTab === 'overview' && (
        <div>
          {/* KPI Grid */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))', gap: '1rem', marginBottom: '1.5rem' }}>
            {/* Card 1: Gross Revenue */}
            <div className="card" style={{ padding: '1.1rem', borderRadius: '12px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Gross Revenue</span>
                <span style={{ padding: '4px', borderRadius: '6px', backgroundColor: '#E0F2FE', color: '#0369A1' }}><TrendingUp size={16} /></span>
              </div>
              <div style={{ fontSize: '1.6rem', fontWeight: '800', color: 'var(--text-main)' }}>₹{(kpis.totalRevenue || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>Net: ₹{(kpis.netRevenue || 0).toFixed(2)} | GST: ₹{(kpis.taxCollected || 0).toFixed(2)}</div>
            </div>

            {/* Card 2: Completed Orders */}
            <div className="card" style={{ padding: '1.1rem', borderRadius: '12px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Completed Orders</span>
                <span style={{ padding: '4px', borderRadius: '6px', backgroundColor: '#DCFCE7', color: '#15803D' }}><CheckCircle2 size={16} /></span>
              </div>
              <div style={{ fontSize: '1.6rem', fontWeight: '800', color: 'var(--text-main)' }}>{kpis.orderCount || 0}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>Avg Order: ₹{(kpis.avgOrderValue || 0).toFixed(2)}</div>
            </div>

            {/* Card 3: Scanner Reliability */}
            <div className="card" style={{ padding: '1.1rem', borderRadius: '12px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase' }}>POS Accuracy</span>
                <span style={{ padding: '4px', borderRadius: '6px', backgroundColor: '#FEF3C7', color: '#B45309' }}><Scan size={16} /></span>
              </div>
              <div style={{ fontSize: '1.6rem', fontWeight: '800', color: 'var(--text-main)' }}>{kpis.scanReliability ?? 100}%</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>{kpis.totalScans || 0} scans ({kpis.unknownScans || 0} unknown)</div>
            </div>

            {/* Card 4: Inventory Valuation */}
            <div className="card" style={{ padding: '1.1rem', borderRadius: '12px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
                <span style={{ fontSize: '0.8rem', fontWeight: '600', color: 'var(--text-muted)', textTransform: 'uppercase' }}>Stock Valuation</span>
                <span style={{ padding: '4px', borderRadius: '6px', backgroundColor: '#F3E8FF', color: '#7E22CE' }}><Package size={16} /></span>
              </div>
              <div style={{ fontSize: '1.6rem', fontWeight: '800', color: 'var(--text-main)' }}>₹{(kpis.totalInventoryValuation || 0).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginTop: '4px' }}>{kpis.totalProducts || 0} Store SKUs ({kpis.totalCatalogItems || 0} in Master)</div>
            </div>
          </div>

          {/* Main Visuals Row: Sales Chart + Category Breakdown */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(400px, 1fr))', gap: '1.25rem', marginBottom: '1.5rem' }}>
            {/* Sales Trend SVG Chart */}
            <div className="card" style={{ padding: '1.25rem', borderRadius: '12px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <div>
                  <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: '700' }}>Daily Sales Trend</h3>
                  <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Revenue (₹) and order counts across last {daysFilter} days</span>
                </div>
              </div>

              {timeline.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>No sales recorded in this timeframe yet.</div>
              ) : (
                <div style={{ width: '100%', height: '200px', display: 'flex', alignItems: 'flex-end', gap: '8px', paddingTop: '20px' }}>
                  {timeline.map((t, idx) => {
                    const heightPct = Math.max(6, Math.round((t.revenue / maxRevenue) * 100));
                    return (
                      <div key={idx} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', height: '100%', justifyContent: 'flex-end' }}>
                        <div
                          title={`${t.date}: ₹${t.revenue.toFixed(2)} (${t.orders} orders)`}
                          style={{
                            width: '100%',
                            height: `${heightPct}%`,
                            backgroundColor: t.revenue > 0 ? 'var(--primary-dark)' : 'var(--border)',
                            borderRadius: '4px 4px 0 0',
                            transition: 'height 0.3s ease',
                            position: 'relative'
                          }}
                        />
                        <span style={{ fontSize: '0.65rem', color: 'var(--text-muted)', marginTop: '6px', whiteSpace: 'nowrap' }}>
                          {t.date.slice(5)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Category Revenue Distribution */}
            <div className="card" style={{ padding: '1.25rem', borderRadius: '12px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
              <h3 style={{ margin: '0 0 0.5rem', fontSize: '1.05rem', fontWeight: '700' }}>Category Sales Distribution</h3>
              <p style={{ margin: '0 0 1rem', fontSize: '0.75rem', color: 'var(--text-muted)' }}>Revenue contribution by product department</p>

              {categories.length === 0 ? (
                <div style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>No category sales data yet.</div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '12px' }}>
                  {categories.map((c, i) => (
                    <div key={i}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.85rem', marginBottom: '4px' }}>
                        <span style={{ fontWeight: '600' }}>{c.category}</span>
                        <span>₹{c.revenue.toFixed(2)} ({c.percentage}%)</span>
                      </div>
                      <div style={{ width: '100%', height: '8px', backgroundColor: 'var(--bg-subtle)', borderRadius: '4px', overflow: 'hidden' }}>
                        <div
                          style={{
                            width: `${c.percentage}%`,
                            height: '100%',
                            backgroundColor: i % 2 === 0 ? 'var(--primary-dark)' : 'var(--accent)',
                            borderRadius: '4px'
                          }}
                        />
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Lower Row: Hardware Fleet Monitor + Recent Stream */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(350px, 1fr))', gap: '1.25rem' }}>
            {/* Live Trolley Fleet */}
            <div className="card" style={{ padding: '1.25rem', borderRadius: '12px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: '700' }}>Active Hardware Trolley</h3>
                <span style={{ fontSize: '0.75rem', fontWeight: '600', padding: '2px 8px', borderRadius: '10px', backgroundColor: fleet?.connection === 'online' ? '#DCFCE7' : '#FEF3C7', color: fleet?.connection === 'online' ? '#166534' : '#92400E' }}>
                  {fleet?.connection || 'Standby'}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', fontSize: '0.85rem' }}>
                <div style={{ padding: '10px', backgroundColor: 'var(--bg-subtle)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Battery Status</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: '700' }}>{fleet?.telemetry?.battery_pct ?? 92}% ({fleet?.telemetry?.battery_v ?? 12.1}V)</div>
                </div>
                <div style={{ padding: '10px', backgroundColor: 'var(--bg-subtle)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Wi-Fi RSSI</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: '700' }}>{fleet?.telemetry?.rssi ?? -62} dBm</div>
                </div>
                <div style={{ padding: '10px', backgroundColor: 'var(--bg-subtle)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Current Speed</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: '700' }}>{fleet?.telemetry?.speed_mps ?? 0.0} m/s</div>
                </div>
                <div style={{ padding: '10px', backgroundColor: 'var(--bg-subtle)', borderRadius: '8px' }}>
                  <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>Obstacle Clearance</div>
                  <div style={{ fontSize: '1.1rem', fontWeight: '700' }}>{fleet?.telemetry?.obstacle_dist_cm ?? 145} cm</div>
                </div>
              </div>
            </div>

            {/* Recent Activity Audit */}
            <div className="card" style={{ padding: '1.25rem', borderRadius: '12px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
              <h3 style={{ margin: '0 0 1rem', fontSize: '1.05rem', fontWeight: '700' }}>Recent Operational Activity</h3>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px', maxHeight: '240px', overflowY: 'auto' }}>
                {recentActivity.length === 0 ? (
                  <div style={{ color: 'var(--text-muted)', fontSize: '0.85rem' }}>No recent activity.</div>
                ) : (
                  recentActivity.map((act, i) => (
                    <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '6px 10px', borderRadius: '6px', backgroundColor: 'var(--bg-subtle)', fontSize: '0.8rem' }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontWeight: '600', color: act.status === 'success' ? '#16A34A' : '#D97706' }}>[{act.type}]</span>
                        <span>{act.title} - {act.detail}</span>
                      </div>
                      <span style={{ fontSize: '0.7rem', color: 'var(--text-muted)' }}>{act.time ? new Date(act.time).toLocaleTimeString() : ''}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* TAB 2: INVENTORY INTELLIGENCE & RESTOCK */}
      {activeSubTab === 'inventory' && (
        <div>
          {/* Inventory Health Cards */}
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: '1rem', marginBottom: '1.25rem' }}>
            <div style={{ padding: '1rem', borderRadius: '10px', border: '1px solid #DCFCE7', backgroundColor: '#F0FDF4' }}>
              <div style={{ fontSize: '0.8rem', color: '#166534', fontWeight: '600' }}>HEALTHY STOCK (&gt;5)</div>
              <div style={{ fontSize: '1.8rem', fontWeight: '800', color: '#15803D' }}>{kpis.healthyStockCount || 0}</div>
            </div>
            <div style={{ padding: '1rem', borderRadius: '10px', border: '1px solid #FEF3C7', backgroundColor: '#FFFBEB' }}>
              <div style={{ fontSize: '0.8rem', color: '#92400E', fontWeight: '600' }}>LOW STOCK (1-5)</div>
              <div style={{ fontSize: '1.8rem', fontWeight: '800', color: '#B45309' }}>{kpis.lowStockCount || 0}</div>
            </div>
            <div style={{ padding: '1rem', borderRadius: '10px', border: '1px solid #FEE2E2', backgroundColor: '#FEF2F2' }}>
              <div style={{ fontSize: '0.8rem', color: '#991B1B', fontWeight: '600' }}>OUT OF STOCK (0)</div>
              <div style={{ fontSize: '1.8rem', fontWeight: '800', color: '#DC2626' }}>{kpis.outOfStockCount || 0}</div>
            </div>
          </div>

          {/* Urgent Restock Alerts Table */}
          <div className="card" style={{ padding: '1.25rem', borderRadius: '12px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
            <h3 style={{ margin: '0 0 1rem', fontSize: '1.1rem', fontWeight: '700' }}>Stock Action List (Items Requiring Immediate Restock)</h3>
            {lowStock.length === 0 ? (
              <div style={{ padding: '2rem', textAlign: 'center', color: '#16A34A' }}>
                <CheckCircle2 size={32} style={{ marginBottom: '8px' }} />
                <div>All inventory items have healthy stock levels!</div>
              </div>
            ) : (
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.875rem' }}>
                  <thead>
                    <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                      <th style={{ padding: '8px' }}>Product</th>
                      <th style={{ padding: '8px' }}>SKU / Barcode</th>
                      <th style={{ padding: '8px' }}>Category</th>
                      <th style={{ padding: '8px' }}>Current Stock</th>
                      <th style={{ padding: '8px' }}>Price</th>
                      <th style={{ padding: '8px' }}>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {lowStock.map((item) => (
                      <tr key={item.id} style={{ borderBottom: '1px solid var(--border)' }}>
                        <td style={{ padding: '10px 8px', fontWeight: '600' }}>{item.name}</td>
                        <td style={{ padding: '10px 8px', fontFamily: 'monospace', fontSize: '0.8rem' }}>{item.sku || item.barcode}</td>
                        <td style={{ padding: '10px 8px' }}>{item.category}</td>
                        <td style={{ padding: '10px 8px' }}>
                          <span style={{ padding: '2px 8px', borderRadius: '10px', fontSize: '0.75rem', fontWeight: '700', backgroundColor: item.stock === 0 ? '#FEE2E2' : '#FEF3C7', color: item.stock === 0 ? '#DC2626' : '#B45309' }}>
                            {item.stock} {item.stock === 0 ? 'Out of Stock' : 'Low Stock'}
                          </span>
                        </td>
                        <td style={{ padding: '10px 8px' }}>₹{Number(item.price).toFixed(2)}</td>
                        <td style={{ padding: '10px 8px' }}>
                          <button
                            onClick={() => handleQuickRestock(item.id, 10)}
                            disabled={restockingId === item.id}
                            style={{
                              display: 'flex',
                              alignItems: 'center',
                              gap: '4px',
                              padding: '4px 10px',
                              fontSize: '0.75rem',
                              fontWeight: '600',
                              borderRadius: '6px',
                              border: 'none',
                              backgroundColor: 'var(--primary-dark)',
                              color: '#ffffff',
                              cursor: restockingId === item.id ? 'not-allowed' : 'pointer'
                            }}
                          >
                            <Plus size={12} />
                            <span>{restockingId === item.id ? 'Restocking...' : '+10 Restock'}</span>
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 3: AUDIT & SCAN LOGS */}
      {activeSubTab === 'audit' && (
        <div>
          {/* Sub Tab Switcher */}
          <div style={{ display: 'flex', gap: '8px', marginBottom: '1rem' }}>
            <button
              onClick={() => setAuditSubTab('scans')}
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                backgroundColor: auditSubTab === 'scans' ? 'var(--primary-dark)' : 'var(--bg-card)',
                color: auditSubTab === 'scans' ? '#fff' : 'var(--text-main)',
                fontSize: '0.85rem',
                fontWeight: '600',
                cursor: 'pointer'
              }}
            >
              Barcode Scan Audit Trail
            </button>
            <button
              onClick={() => setAuditSubTab('movements')}
              style={{
                padding: '6px 14px',
                borderRadius: '6px',
                border: '1px solid var(--border)',
                backgroundColor: auditSubTab === 'movements' ? 'var(--primary-dark)' : 'var(--bg-card)',
                color: auditSubTab === 'movements' ? '#fff' : 'var(--text-main)',
                fontSize: '0.85rem',
                fontWeight: '600',
                cursor: 'pointer'
              }}
            >
              Inventory Stock Movements Trail
            </button>
          </div>

          {/* Audit Content */}
          <div className="card" style={{ padding: '1.25rem', borderRadius: '12px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
            {auditSubTab === 'scans' ? (
              <div>
                {/* Search & Filter Bar */}
                <div style={{ display: 'flex', gap: '10px', marginBottom: '1rem', flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    placeholder="Search barcode or scanId..."
                    value={scanSearch}
                    onChange={(e) => setScanSearch(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') loadScanLogs(1); }}
                    style={{ padding: '6px 12px', borderRadius: '6px', border: '1px solid var(--border)', fontSize: '0.85rem', flex: 1, minWidth: '200px' }}
                  />
                  <select
                    value={scanResultFilter}
                    onChange={(e) => setScanResultFilter(e.target.value)}
                    style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)', fontSize: '0.85rem' }}
                  >
                    <option value="">All Results</option>
                    <option value="added">Added (Success)</option>
                    <option value="unknown">Unknown Barcode</option>
                    <option value="duplicate">Duplicate (Idempotent)</option>
                    <option value="out_of_stock">Out of Stock</option>
                  </select>
                  <button
                    onClick={() => loadScanLogs(1)}
                    style={{ padding: '6px 12px', borderRadius: '6px', backgroundColor: 'var(--primary-dark)', color: '#fff', border: 'none', fontSize: '0.85rem', cursor: 'pointer' }}
                  >
                    Apply Filter
                  </button>
                </div>

                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                        <th style={{ padding: '8px' }}>Timestamp</th>
                        <th style={{ padding: '8px' }}>Barcode</th>
                        <th style={{ padding: '8px' }}>Scan ID</th>
                        <th style={{ padding: '8px' }}>Result</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scanLogs.data.length === 0 ? (
                        <tr><td colSpan="4" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>No scan records match filter.</td></tr>
                      ) : (
                        scanLogs.data.map((s) => (
                          <tr key={s.id || s.scan_id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '8px' }}>{new Date(s.created_at).toLocaleString()}</td>
                            <td style={{ padding: '8px', fontFamily: 'monospace', fontWeight: '600' }}>{s.barcode}</td>
                            <td style={{ padding: '8px', fontFamily: 'monospace', fontSize: '0.75rem', color: 'var(--text-muted)' }}>{s.scan_id}</td>
                            <td style={{ padding: '8px' }}>
                              <span style={{ padding: '2px 8px', borderRadius: '8px', fontSize: '0.75rem', fontWeight: '600', backgroundColor: s.result === 'added' ? '#DCFCE7' : (s.result === 'unknown' ? '#FEE2E2' : '#FEF3C7'), color: s.result === 'added' ? '#15803D' : (s.result === 'unknown' ? '#DC2626' : '#B45309') }}>
                                {s.result.toUpperCase()}
                              </span>
                            </td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>

                {/* Pagination */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginTop: '1rem', fontSize: '0.85rem' }}>
                  <span>Showing page {scanLogs.page} of {Math.max(1, Math.ceil(scanLogs.total / scanLogs.pageSize))} ({scanLogs.total} total)</span>
                  <div style={{ display: 'flex', gap: '6px' }}>
                    <button
                      disabled={scanLogs.page <= 1}
                      onClick={() => loadScanLogs(scanLogs.page - 1)}
                      style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border)', cursor: scanLogs.page <= 1 ? 'not-allowed' : 'pointer' }}
                    >
                      <ChevronLeft size={16} />
                    </button>
                    <button
                      disabled={scanLogs.page >= Math.ceil(scanLogs.total / scanLogs.pageSize)}
                      onClick={() => loadScanLogs(scanLogs.page + 1)}
                      style={{ padding: '4px 8px', borderRadius: '4px', border: '1px solid var(--border)', cursor: scanLogs.page >= Math.ceil(scanLogs.total / scanLogs.pageSize) ? 'not-allowed' : 'pointer' }}
                    >
                      <ChevronRight size={16} />
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div>
                {/* Movement Filter */}
                <div style={{ display: 'flex', gap: '10px', marginBottom: '1rem' }}>
                  <select
                    value={movementReasonFilter}
                    onChange={(e) => setMovementReasonFilter(e.target.value)}
                    style={{ padding: '6px 10px', borderRadius: '6px', border: '1px solid var(--border)', fontSize: '0.85rem' }}
                  >
                    <option value="">All Reasons</option>
                    <option value="sale">Sale</option>
                    <option value="restock">Restock</option>
                    <option value="adjustment">Manual Adjustment</option>
                    <option value="cancellation">Order Cancellation</option>
                  </select>
                </div>

                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '0.85rem' }}>
                    <thead>
                      <tr style={{ borderBottom: '2px solid var(--border)', textAlign: 'left', color: 'var(--text-muted)' }}>
                        <th style={{ padding: '8px' }}>Timestamp</th>
                        <th style={{ padding: '8px' }}>Product</th>
                        <th style={{ padding: '8px' }}>Change</th>
                        <th style={{ padding: '8px' }}>Reason</th>
                      </tr>
                    </thead>
                    <tbody>
                      {movementLogs.data.length === 0 ? (
                        <tr><td colSpan="4" style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted)' }}>No stock movement records.</td></tr>
                      ) : (
                        movementLogs.data.map((m) => (
                          <tr key={m.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '8px' }}>{new Date(m.created_at).toLocaleString()}</td>
                            <td style={{ padding: '8px', fontWeight: '600' }}>{m.product?.name || m.product_id}</td>
                            <td style={{ padding: '8px', fontWeight: '700', color: m.change > 0 ? '#16A34A' : '#DC2626' }}>
                              {m.change > 0 ? `+${m.change}` : m.change}
                            </td>
                            <td style={{ padding: '8px', textTransform: 'capitalize' }}>{m.reason}</td>
                          </tr>
                        ))
                      )}
                    </tbody>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB 4: DATABASE & DIAGNOSTICS */}
      {activeSubTab === 'database' && (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: '1.25rem' }}>
            {/* Supabase Table Matrix */}
            <div className="card" style={{ padding: '1.25rem', borderRadius: '12px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: '700' }}>Supabase Table Row Counts</h3>
                <span style={{ fontSize: '0.75rem', padding: '2px 8px', borderRadius: '8px', backgroundColor: '#DCFCE7', color: '#166534', fontWeight: '700' }}>
                  {healthData?.mode === 'supabase' ? 'Supabase PostgreSQL' : 'Memory Store'}
                </span>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '8px' }}>
                {healthData?.tables ? (
                  Object.entries(healthData.tables).map(([tbl, cnt]) => (
                    <div key={tbl} style={{ padding: '8px 12px', borderRadius: '6px', backgroundColor: 'var(--bg-subtle)', display: 'flex', justifyContent: 'space-between', fontSize: '0.8rem' }}>
                      <span style={{ fontFamily: 'monospace' }}>{tbl}</span>
                      <span style={{ fontWeight: '700' }}>{cnt}</span>
                    </div>
                  ))
                ) : (
                  <div style={{ color: 'var(--text-muted)' }}>Loading table metrics...</div>
                )}
              </div>
            </div>

            {/* System Runtime & Excel Logger Diagnostics */}
            <div className="card" style={{ padding: '1.25rem', borderRadius: '12px', border: '1px solid var(--border)', backgroundColor: 'var(--bg-card)' }}>
              <h3 style={{ margin: '0 0 1rem', fontSize: '1.05rem', fontWeight: '700' }}>Live Worker & Runtime Diagnostics</h3>

              <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', fontSize: '0.85rem' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', backgroundColor: 'var(--bg-subtle)', borderRadius: '6px' }}>
                  <span>Server Uptime</span>
                  <span style={{ fontWeight: '700' }}>{Math.floor((healthData?.uptimeSec || 0) / 60)} minutes</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', backgroundColor: 'var(--bg-subtle)', borderRadius: '6px' }}>
                  <span>Process Memory (RSS)</span>
                  <span style={{ fontWeight: '700' }}>{Math.round((healthData?.memory?.rss || 0) / 1024 / 1024)} MB</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', backgroundColor: 'var(--bg-subtle)', borderRadius: '6px' }}>
                  <span>Excel Buffer Pending</span>
                  <span style={{ fontWeight: '700' }}>{dashboardData?.loggerStats?.bufferSize || 0} events</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', backgroundColor: 'var(--bg-subtle)', borderRadius: '6px' }}>
                  <span>Total Cleaned Logged</span>
                  <span style={{ fontWeight: '700' }}>{dashboardData?.loggerStats?.totalCleanedWritten || 0} rows</span>
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', padding: '8px 12px', backgroundColor: 'var(--bg-subtle)', borderRadius: '6px' }}>
                  <span>Last Excel Flush</span>
                  <span style={{ fontWeight: '700' }}>{dashboardData?.loggerStats?.lastFlushTime ? new Date(dashboardData.loggerStats.lastFlushTime).toLocaleTimeString() : 'None yet'}</span>
                </div>

                <div style={{ marginTop: '8px' }}>
                  <button
                    onClick={handleFlushExcel}
                    disabled={flushLoading}
                    style={{
                      width: '100%',
                      padding: '8px 12px',
                      borderRadius: '6px',
                      border: 'none',
                      backgroundColor: 'var(--primary-dark)',
                      color: '#fff',
                      fontSize: '0.85rem',
                      fontWeight: '600',
                      cursor: flushLoading ? 'not-allowed' : 'pointer'
                    }}
                  >
                    {flushLoading ? 'Flushing Excel Buffer...' : 'Force Immediate Excel Flush & Clean'}
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

