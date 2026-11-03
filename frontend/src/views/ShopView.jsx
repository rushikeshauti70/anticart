import React, { useState, useEffect } from 'react';
import { Search, Plus, Upload, Trash2, Edit2, AlertCircle, ShoppingCart, FileSpreadsheet, CheckCircle2, PackagePlus, ArrowRight, Minus } from 'lucide-react';
import { api } from '../api';

const CATEGORIES = [
  'All',
  'Groceries',
  'Snacks',
  'Dairy',
  'Beverages',
  'Electronics',
  'Stationery',
  'Personal Care',
];

export function ShopView({ onSelectBarcodeForScan, initialBarcodeToAdd, onClearInitialBarcode }) {
  const [viewMode, setViewMode] = useState('catalog'); // 'catalog' (Master Catalog) | 'inventory' (Store Inventory)
  const [catalogItems, setCatalogItems] = useState([]);
  const [inventoryProducts, setInventoryProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');

  // Quantity selection state for each catalog item: { [catalogId]: number }
  const [quantities, setQuantities] = useState({});
  const [addingToCartId, setAddingToCartId] = useState(null);

  // Modals & Notices
  const [showAddModal, setShowAddModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [showStockModal, setShowStockModal] = useState(null); // catalog product to stock
  const [stockPrice, setStockPrice] = useState('');
  const [stockCount, setStockCount] = useState('15');
  const [editingProduct, setEditingProduct] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  // Form states for manual product add
  const [formBarcode, setFormBarcode] = useState('');
  const [formName, setFormName] = useState('');
  const [formSku, setFormSku] = useState('');
  const [formCategory, setFormCategory] = useState('General');
  const [formPrice, setFormPrice] = useState('');
  const [formGst, setFormGst] = useState('5.0');
  const [formStock, setFormStock] = useState('20');

  // Import state
  const [importCsv, setImportCsv] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

  useEffect(() => {
    if (initialBarcodeToAdd) {
      setFormBarcode(initialBarcodeToAdd);
      setEditingProduct(null);
      setShowAddModal(true);
      onClearInitialBarcode?.();
    }
  }, [initialBarcodeToAdd]);

  useEffect(() => {
    loadData();
  }, [category, viewMode]);

  async function loadData() {
    setLoading(true);
    setErrorMessage('');
    try {
      if (viewMode === 'catalog') {
        const res = await api.getCatalog({
          search,
          category: category === 'All' ? '' : category,
          pageSize: 60,
        });
        setCatalogItems(res.data || []);
      } else {
        const res = await api.getProducts({
          search,
          category: category === 'All' ? '' : category,
          pageSize: 60,
        });
        setInventoryProducts(res.data || []);
      }
    } catch (err) {
      setErrorMessage(err.message || 'Failed to load products');
    } finally {
      setLoading(false);
    }
  }

  function handleSearchSubmit(e) {
    e.preventDefault();
    loadData();
  }

  function getQty(id) {
    return quantities[id] || 1;
  }

  function setQty(id, val) {
    const nextVal = Math.max(1, Math.min(99, val));
    setQuantities((prev) => ({ ...prev, [id]: nextVal }));
  }

  // 1-Click Add directly from Product Catalog to Active Cart
  async function handleAddToCart(item) {
    const qty = getQty(item.id);
    setAddingToCartId(item.id);
    setErrorMessage('');
    try {
      const res = await api.addCatalogItemToCart({
        catalogId: item.id,
        productId: item.inventory_id,
        quantity: qty,
        requestId: `cat-${item.id}-${Date.now()}`,
        trolleyId: 'trolley-01',
      });

      // Sensory feedback
      playAddChime();
      setSuccessMessage(`Added ${qty}× ${item.name} to Cart`);
      setTimeout(() => setSuccessMessage(''), 3500);

      // Decrement local stock badge dynamically
      if (item.stock_qty !== null && item.stock_qty !== undefined) {
        const nextStock = Math.max(0, item.stock_qty - qty);
        setCatalogItems((prev) =>
          prev.map((c) =>
            c.id === item.id
              ? {
                  ...c,
                  stock_qty: nextStock,
                  stock_status: nextStock === 0 ? 'out_of_stock' : (nextStock <= 5 ? 'low_stock' : 'in_stock'),
                }
              : c
          )
        );
      }
    } catch (err) {
      setErrorMessage(err.message || 'Could not add product to cart');
    } finally {
      setAddingToCartId(null);
    }
  }

  // Stock unstocked catalog item into store inventory
  async function handleStockCatalogItem(e) {
    e.preventDefault();
    if (!showStockModal) return;
    try {
      await api.linkCatalogToInventory(showStockModal.id, {
        price: stockPrice || showStockModal.default_price,
        stock: parseInt(stockCount, 10) || 15,
        gst_percent: 5.0,
      });
      setShowStockModal(null);
      setSuccessMessage(`Stocked ${showStockModal.name} into store inventory!`);
      setTimeout(() => setSuccessMessage(''), 3000);
      loadData();
    } catch (err) {
      setErrorMessage(err.message || 'Failed to stock product into inventory');
    }
  }

  function openStockModal(item) {
    setShowStockModal(item);
    setStockPrice(String(item.default_price || ''));
    setStockCount('15');
  }

  function playAddChime() {
    try {
      const AudioCtx = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(987, ctx.currentTime);
      osc.frequency.setValueAtTime(1318, ctx.currentTime + 0.06);
      gain.gain.setValueAtTime(0.18, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.16);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.16);
    } catch (e) {}
  }

  async function handleAiLookup() {
    if (!formBarcode.trim()) return;
    setAiLoading(true);
    try {
      const res = await api.aiBarcodeLookup(formBarcode.trim(), formName.trim());
      if (res.suggestion) {
        if (res.suggestion.name && !formName) setFormName(res.suggestion.name);
        if (res.suggestion.category) setFormCategory(res.suggestion.category);
        if (res.suggestion.price && !formPrice) setFormPrice(String(res.suggestion.price));
        if (res.suggestion.gst_percent !== undefined) setFormGst(String(res.suggestion.gst_percent));
        setSuccessMessage('Auto-filled product suggestions via AI');
        setTimeout(() => setSuccessMessage(''), 3000);
      }
    } catch (err) {
      console.warn('AI lookup warning:', err.message);
    } finally {
      setAiLoading(false);
    }
  }

  async function handleSaveProduct(e) {
    e.preventDefault();
    try {
      const payload = {
        barcode: formBarcode.trim() || undefined,
        name: formName.trim(),
        sku: formSku.trim() || `SKU-${Date.now().toString(36).toUpperCase()}`,
        category: formCategory,
        price: parseFloat(formPrice),
        default_price: parseFloat(formPrice),
        gst_percent: parseFloat(formGst),
        stock: formStock ? parseInt(formStock, 10) : null,
      };

      if (editingProduct) {
        await api.updateProduct(editingProduct.id, payload);
        setSuccessMessage('Product updated successfully');
      } else {
        await api.createProduct(payload);
        setSuccessMessage('Product created successfully');
      }

      setShowAddModal(false);
      loadData();
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to save product');
    }
  }

  async function handleDeleteProduct(id) {
    if (!window.confirm('Are you sure you want to delete this product?')) return;
    try {
      await api.deleteProduct(id);
      setSuccessMessage('Product removed');
      loadData();
      setTimeout(() => setSuccessMessage(''), 3000);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to delete product');
    }
  }

  async function handleImportSubmit(e) {
    e.preventDefault();
    if (!importCsv.trim()) return;
    try {
      const res = await api.importProducts(importCsv, true);
      setSuccessMessage(`Successfully imported ${res.added} products (${res.failed} failed)`);
      setShowImportModal(false);
      setImportCsv('');
      loadData();
      setTimeout(() => setSuccessMessage(''), 4000);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to import CSV');
    }
  }

  return (
    <div>
      {/* Header with Mode Toggle & Excel Export */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', flexWrap: 'wrap', gap: '12px' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Store & Catalog</h1>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Browse master product catalog or manage store inventory stock
          </p>
        </div>

        {/* Action Controls */}
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
          {/* Download Live Excel Activity Report */}
          <a
            href={api.getExcelDownloadUrl()}
            className="btn btn-sm"
            download
            title="Download live 5-second cleaned Excel activity report with Activity, Alerts & Summary sheets"
            style={{ display: 'inline-flex', alignItems: 'center', gap: '6px', backgroundColor: '#065F46', color: '#ECFDF5', borderColor: '#059669' }}
          >
            <FileSpreadsheet size={15} /> Export Excel Log (.xlsx)
          </a>

          <button className="btn btn-sm" onClick={() => setShowImportModal(true)}>
            <Upload size={14} /> Import CSV
          </button>

          <button
            className="btn btn-sm btn-primary"
            onClick={() => {
              setEditingProduct(null);
              setFormBarcode('');
              setFormName('');
              setFormSku('');
              setFormPrice('');
              setFormStock('20');
              setShowAddModal(true);
            }}
          >
            <Plus size={14} /> Add Product
          </button>
        </div>
      </div>

      {/* View Mode Tabs: Master Catalog vs Store Inventory */}
      <div style={{ display: 'flex', gap: '8px', marginBottom: '16px', borderBottom: '1px solid var(--border)', paddingBottom: '8px' }}>
        <button
          className={`btn btn-sm ${viewMode === 'catalog' ? 'btn-primary' : ''}`}
          onClick={() => setViewMode('catalog')}
          style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <ShoppingCart size={15} /> Master Catalog (1-Click Add)
        </button>
        <button
          className={`btn btn-sm ${viewMode === 'inventory' ? 'btn-primary' : ''}`}
          onClick={() => setViewMode('inventory')}
          style={{ display: 'flex', alignItems: 'center', gap: '6px' }}
        >
          <PackagePlus size={15} /> Inventory Management
        </button>
      </div>

      {/* Notifications */}
      {successMessage && (
        <div className="toast-banner toast-success" style={{ marginBottom: '12px' }}>
          <span>{successMessage}</span>
          <button className="btn btn-sm" onClick={() => setSuccessMessage('')}>Dismiss</button>
        </div>
      )}

      {errorMessage && (
        <div className="toast-banner toast-danger" style={{ marginBottom: '12px' }}>
          <span>{errorMessage}</span>
          <button className="btn btn-sm" onClick={() => setErrorMessage('')}>Dismiss</button>
        </div>
      )}

      {/* Search and Category Filters */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '10px', marginBottom: '18px' }}>
        <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: '8px' }}>
          <div style={{ position: 'relative', flex: 1 }}>
            <Search size={16} style={{ position: 'absolute', left: '12px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
            <input
              type="text"
              className="input"
              style={{ paddingLeft: '36px', width: '100%' }}
              placeholder={viewMode === 'catalog' ? 'Search master catalog by Name, Brand, SKU, or Barcode...' : 'Search store inventory...'}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
            />
          </div>
          <button type="submit" className="btn btn-primary">Search</button>
        </form>

        {/* Category Pills */}
        <div style={{ display: 'flex', gap: '6px', overflowX: 'auto', paddingBottom: '4px' }}>
          {CATEGORIES.map((cat) => (
            <button
              key={cat}
              className={`btn btn-sm ${category === cat ? 'btn-primary' : ''}`}
              style={{ borderRadius: '20px', padding: '4px 12px', whiteSpace: 'nowrap' }}
              onClick={() => setCategory(cat)}
            >
              {cat}
            </button>
          ))}
        </div>
      </div>

      {/* LOADING STATE */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          Loading products...
        </div>
      ) : viewMode === 'catalog' ? (
        /* ========================================================================= */
        /* MODE 1: MASTER PRODUCT CATALOG (Browse & 1-Click Add with Quantity)      */
        /* ========================================================================= */
        catalogItems.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
            <AlertCircle size={32} style={{ margin: '0 auto 10px', color: 'var(--text-muted)' }} />
            <p>No catalog products match your search.</p>
          </div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))', gap: '16px' }}>
            {catalogItems.map((item) => {
              const qty = getQty(item.id);
              const isOut = item.stock_status === 'out_of_stock';
              const isNotStocked = item.stock_status === 'not_stocked';
              const isLow = item.stock_status === 'low_stock';

              return (
                <div key={item.id} className="card" style={{ display: 'flex', flexDirection: 'column', justifyContent: 'space-between', padding: '16px', position: 'relative' }}>
                  {/* Stock Status Badge */}
                  <div style={{ position: 'absolute', top: '12px', right: '12px' }}>
                    {isNotStocked ? (
                      <span style={{ fontSize: '0.72rem', backgroundColor: '#F1F5F9', color: '#475569', padding: '3px 8px', borderRadius: '12px', fontWeight: 600 }}>
                        Not in Inventory
                      </span>
                    ) : isOut ? (
                      <span style={{ fontSize: '0.72rem', backgroundColor: '#FEE2E2', color: '#991B1B', padding: '3px 8px', borderRadius: '12px', fontWeight: 600 }}>
                        Out of Stock
                      </span>
                    ) : isLow ? (
                      <span style={{ fontSize: '0.72rem', backgroundColor: '#FEF3C7', color: '#92400E', padding: '3px 8px', borderRadius: '12px', fontWeight: 600 }}>
                        Low Stock ({item.stock_qty})
                      </span>
                    ) : (
                      <span style={{ fontSize: '0.72rem', backgroundColor: '#DCFCE7', color: '#166534', padding: '3px 8px', borderRadius: '12px', fontWeight: 600 }}>
                        In Stock ({item.stock_qty})
                      </span>
                    )}
                  </div>

                  <div>
                    {/* Category & Brand */}
                    <div style={{ fontSize: '0.75rem', color: 'var(--primary)', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.5px' }}>
                      {item.brand ? `${item.brand} • ` : ''}{item.category}
                    </div>

                    {/* Product Name */}
                    <h3 style={{ fontSize: '1.05rem', fontWeight: 700, margin: '4px 0 6px' }}>
                      {item.name}
                    </h3>

                    {/* SKU & Barcode */}
                    <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)', marginBottom: '8px' }}>
                      SKU: <strong>{item.sku}</strong> {item.barcode ? `| Barcode: ${item.barcode}` : ''}
                    </div>

                    {/* Description */}
                    {item.description && (
                      <p style={{ fontSize: '0.8rem', color: 'var(--text-muted)', marginBottom: '12px', display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden' }}>
                        {item.description}
                      </p>
                    )}
                  </div>

                  {/* Price & Action Row */}
                  <div style={{ borderTop: '1px solid var(--border)', paddingTop: '12px', marginTop: 'auto' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
                      <div style={{ fontSize: '1.2rem', fontWeight: 800, color: 'var(--text-main)' }}>
                        ₹{Number(item.inventory_price || item.default_price).toFixed(2)}
                        <span style={{ fontSize: '0.75rem', color: 'var(--text-muted)', fontWeight: 400 }}> /{item.unit}</span>
                      </div>

                      {/* Quantity Stepper (+/-) */}
                      {!isNotStocked && !isOut && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: '6px', backgroundColor: 'var(--bg-main)', border: '1px solid var(--border)', borderRadius: '6px', padding: '2px 4px' }}>
                          <button
                            type="button"
                            onClick={() => setQty(item.id, qty - 1)}
                            disabled={qty <= 1}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '3px' }}
                          >
                            <Minus size={13} />
                          </button>
                          <span style={{ fontSize: '0.85rem', fontWeight: 700, minWidth: '18px', textAlign: 'center' }}>
                            {qty}
                          </span>
                          <button
                            type="button"
                            onClick={() => setQty(item.id, qty + 1)}
                            disabled={item.stock_qty !== null && qty >= item.stock_qty}
                            style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '3px' }}
                          >
                            <Plus size={13} />
                          </button>
                        </div>
                      )}
                    </div>

                    {/* Action Button */}
                    {isNotStocked ? (
                      <button
                        className="btn btn-sm"
                        style={{ width: '100%', justifyContent: 'center' }}
                        onClick={() => openStockModal(item)}
                      >
                        <PackagePlus size={14} /> Add to Store Inventory
                      </button>
                    ) : (
                      <button
                        className="btn btn-sm btn-primary"
                        style={{ width: '100%', justifyContent: 'center' }}
                        disabled={isOut || addingToCartId === item.id}
                        onClick={() => handleAddToCart(item)}
                      >
                        <ShoppingCart size={14} />
                        {isOut ? 'Out of Stock' : (addingToCartId === item.id ? 'Adding...' : `Add ${qty > 1 ? `${qty} items` : ''} to Cart`)}
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )
      ) : (
        /* ========================================================================= */
        /* MODE 2: STORE INVENTORY MANAGEMENT TABLE                                  */
        /* ========================================================================= */
        inventoryProducts.length === 0 ? (
          <div className="card" style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
            <AlertCircle size={32} style={{ margin: '0 auto 10px', color: 'var(--text-muted)' }} />
            <p>No products in store inventory.</p>
          </div>
        ) : (
          <div className="card" style={{ padding: '0', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', textAlign: 'left', fontSize: '0.88rem' }}>
              <thead>
                <tr style={{ backgroundColor: 'var(--bg-main)', borderBottom: '1px solid var(--border)' }}>
                  <th style={{ padding: '12px 16px' }}>Barcode</th>
                  <th style={{ padding: '12px 16px' }}>Name</th>
                  <th style={{ padding: '12px 16px' }}>Category</th>
                  <th style={{ padding: '12px 16px' }}>Price</th>
                  <th style={{ padding: '12px 16px' }}>Stock</th>
                  <th style={{ padding: '12px 16px', textAlign: 'right' }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {inventoryProducts.map((p) => (
                  <tr key={p.id} style={{ borderBottom: '1px solid var(--border)' }}>
                    <td style={{ padding: '12px 16px', fontFamily: 'monospace' }}>{p.barcode}</td>
                    <td style={{ padding: '12px 16px', fontWeight: 600 }}>{p.name}</td>
                    <td style={{ padding: '12px 16px' }}>{p.category}</td>
                    <td style={{ padding: '12px 16px' }}>₹{Number(p.price).toFixed(2)}</td>
                    <td style={{ padding: '12px 16px' }}>
                      {p.stock === null || p.stock === undefined ? (
                        <span style={{ color: 'var(--text-muted)' }}>Unlimited</span>
                      ) : p.stock === 0 ? (
                        <span style={{ color: 'var(--danger)', fontWeight: 600 }}>0 (Out of stock)</span>
                      ) : p.stock <= 5 ? (
                        <span style={{ color: '#D97706', fontWeight: 600 }}>{p.stock} (Low)</span>
                      ) : (
                        <span>{p.stock}</span>
                      )}
                    </td>
                    <td style={{ padding: '12px 16px', textAlign: 'right' }}>
                      <button
                        className="btn btn-sm"
                        style={{ marginRight: '6px' }}
                        onClick={() => {
                          setEditingProduct(p);
                          setFormBarcode(p.barcode || '');
                          setFormName(p.name || '');
                          setFormSku(p.sku || '');
                          setFormCategory(p.category || 'General');
                          setFormPrice(String(p.price || ''));
                          setFormGst(String(p.gst_percent || '5.0'));
                          setFormStock(p.stock !== null && p.stock !== undefined ? String(p.stock) : '');
                          setShowAddModal(true);
                        }}
                      >
                        <Edit2 size={13} />
                      </button>
                      <button
                        className="btn btn-sm"
                        style={{ color: 'var(--danger)' }}
                        onClick={() => handleDeleteProduct(p.id)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      )}

      {/* MODAL: Stock a Catalog Product into Store Inventory */}
      {showStockModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h2>Add to Store Inventory</h2>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '14px' }}>
              Stocking <strong>{showStockModal.name}</strong> ({showStockModal.sku}) into your local inventory.
            </p>
            <form onSubmit={handleStockCatalogItem}>
              <div className="form-group">
                <label>Selling Price (₹)</label>
                <input
                  type="number"
                  step="0.01"
                  className="input"
                  required
                  value={stockPrice}
                  onChange={(e) => setStockPrice(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label>Initial Stock Quantity</label>
                <input
                  type="number"
                  className="input"
                  required
                  value={stockCount}
                  onChange={(e) => setStockCount(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
                <button type="button" className="btn" onClick={() => setShowStockModal(null)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Confirm & Stock Item</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Add / Edit Product */}
      {showAddModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h2>{editingProduct ? 'Edit Product' : 'Add New Product'}</h2>
            <form onSubmit={handleSaveProduct}>
              <div className="form-group">
                <label>Barcode</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    className="input"
                    value={formBarcode}
                    onChange={(e) => setFormBarcode(e.target.value)}
                    placeholder="e.g. 051111407592"
                  />
                  <button type="button" className="btn btn-sm" onClick={handleAiLookup} disabled={aiLoading || !formBarcode}>
                    {aiLoading ? 'Looking up...' : 'AI Autofill'}
                  </button>
                </div>
              </div>
              <div className="form-group">
                <label>Product Name</label>
                <input
                  type="text"
                  className="input"
                  required
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                  placeholder="e.g. Organic Whole Milk 1L"
                />
              </div>
              <div className="form-group">
                <label>SKU (Stock Keeping Unit)</label>
                <input
                  type="text"
                  className="input"
                  value={formSku}
                  onChange={(e) => setFormSku(e.target.value)}
                  placeholder="e.g. DAIRY-MILK-1L"
                />
              </div>
              <div className="form-group">
                <label>Category</label>
                <select className="input" value={formCategory} onChange={(e) => setFormCategory(e.target.value)}>
                  {CATEGORIES.filter((c) => c !== 'All').map((c) => (
                    <option key={c} value={c}>{c}</option>
                  ))}
                </select>
              </div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-group">
                  <label>Price (₹)</label>
                  <input
                    type="number"
                    step="0.01"
                    className="input"
                    required
                    value={formPrice}
                    onChange={(e) => setFormPrice(e.target.value)}
                  />
                </div>
                <div className="form-group">
                  <label>Stock Qty</label>
                  <input
                    type="number"
                    className="input"
                    placeholder="Leave empty for unlimited"
                    value={formStock}
                    onChange={(e) => setFormStock(e.target.value)}
                  />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
                <button type="button" className="btn" onClick={() => setShowAddModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Save Product</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* MODAL: Import CSV */}
      {showImportModal && (
        <div className="modal-backdrop">
          <div className="modal-card">
            <h2>Bulk Import Products via CSV</h2>
            <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Paste CSV text with headers: <code>barcode,name,category,price,stock,sku</code>
            </p>
            <form onSubmit={handleImportSubmit}>
              <div className="form-group">
                <textarea
                  className="input"
                  rows={8}
                  style={{ fontFamily: 'monospace', fontSize: '0.82rem' }}
                  placeholder="barcode,name,category,price,stock,sku&#10;8901030383700,Maggi Noodles,Groceries,14.00,50,GROC-MAGGI"
                  value={importCsv}
                  onChange={(e) => setImportCsv(e.target.value)}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
                <button type="button" className="btn" onClick={() => setShowImportModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Start Import</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
