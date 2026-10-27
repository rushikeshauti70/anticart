import React, { useState, useEffect, memo } from 'react';
import { Search, Plus, Upload, Trash2, Edit2, AlertCircle } from 'lucide-react';
import { api } from '../api';

const CATEGORIES = [
  'All',
  'Groceries',
  'Snacks',
  'Dairy',
  'Beverages',
  'Electronics',
  'Stationery',
];

function ShopViewComponent({ onSelectBarcodeForScan }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState('');
  const [category, setCategory] = useState('All');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showImportModal, setShowImportModal] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [successMessage, setSuccessMessage] = useState('');

  // Form states
  const [formBarcode, setFormBarcode] = useState('');
  const [formName, setFormName] = useState('');
  const [formCategory, setFormCategory] = useState('General');
  const [formPrice, setFormPrice] = useState('');
  const [formGst, setFormGst] = useState('5.0');
  const [formStock, setFormStock] = useState('');

  // Import state
  const [importCsv, setImportCsv] = useState('');
  const [aiLoading, setAiLoading] = useState(false);

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
      } else if (!res.configured) {
        setErrorMessage('AI features require GOOGLE_API_KEY configured in backend environment.');
      }
    } catch (err) {
      console.warn('AI lookup warning:', err.message);
    } finally {
      setAiLoading(false);
    }
  }

  useEffect(() => {
    loadProducts();
  }, [category]);

  async function loadProducts() {
    setLoading(true);
    setErrorMessage('');
    try {
      const res = await api.getProducts({
        search,
        category: category === 'All' ? '' : category,
      });
      setProducts(res.data || []);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to load products');
    } finally {
      setLoading(false);
    }
  }

  function handleSearchSubmit(e) {
    e.preventDefault();
    loadProducts();
  }

  function openCreateModal() {
    setEditingProduct(null);
    setFormBarcode('');
    setFormName('');
    setFormCategory('General');
    setFormPrice('');
    setFormGst('5.0');
    setFormStock('');
    setShowAddModal(true);
  }

  function openEditModal(prod) {
    setEditingProduct(prod);
    setFormBarcode(prod.barcode);
    setFormName(prod.name);
    setFormCategory(prod.category);
    setFormPrice(String(prod.price));
    setFormGst(String(prod.gst_percent));
    setFormStock(prod.stock !== null ? String(prod.stock) : '');
    setShowAddModal(true);
  }

  async function handleSaveProduct(e) {
    e.preventDefault();
    setErrorMessage('');
    try {
      const payload = {
        barcode: formBarcode.trim(),
        name: formName.trim(),
        category: formCategory.trim(),
        price: parseFloat(formPrice),
        gst_percent: parseFloat(formGst) || 0,
        stock: formStock.trim() !== '' ? parseInt(formStock, 10) : null,
      };

      if (editingProduct) {
        await api.updateProduct(editingProduct.id, payload);
        setSuccessMessage('Product updated successfully');
      } else {
        await api.createProduct(payload);
        setSuccessMessage('Product added to catalog');
      }

      setShowAddModal(false);
      loadProducts();
      setTimeout(() => setSuccessMessage(''), 4000);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to save product');
    }
  }

  async function handleDeleteProduct(id) {
    if (!window.confirm('Are you sure you want to remove this product from the catalog?')) return;
    try {
      await api.deleteProduct(id);
      setSuccessMessage('Product removed');
      loadProducts();
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
      setShowImportModal(false);
      setImportCsv('');
      setSuccessMessage(`Import complete: ${res.added} added, ${res.failed} skipped.`);
      loadProducts();
      setTimeout(() => setSuccessMessage(''), 5000);
    } catch (err) {
      setErrorMessage(err.message || 'Import failed');
    }
  }

  return (
    <div>
      {/* Top Banners */}
      {errorMessage && (
        <div className="toast-banner toast-danger">
          <span>{errorMessage}</span>
          <button className="btn btn-sm" onClick={() => setErrorMessage('')}>Dismiss</button>
        </div>
      )}
      {successMessage && (
        <div className="toast-banner toast-success">
          <span>{successMessage}</span>
          <button className="btn btn-sm" onClick={() => setSuccessMessage('')}>Close</button>
        </div>
      )}

      {/* Header and Controls */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '14px', flexWrap: 'wrap', gap: '10px' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Catalog</h1>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Manage master items, prices and GST rates
          </p>
        </div>

        <div style={{ display: 'flex', gap: '8px' }}>
          <button className="btn btn-sm" onClick={() => setShowImportModal(true)}>
            <Upload size={14} /> Import CSV
          </button>
          <button className="btn btn-sm btn-primary" onClick={openCreateModal}>
            <Plus size={14} /> Add Product
          </button>
        </div>
      </div>

      {/* Search Input */}
      <form onSubmit={handleSearchSubmit} style={{ display: 'flex', gap: '8px', marginBottom: '14px' }}>
        <div style={{ position: 'relative', flex: 1 }}>
          <input
            type="text"
            className="input"
            placeholder="Search catalog by name or barcode..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ paddingLeft: '34px' }}
          />
          <Search size={16} style={{ position: 'absolute', left: '10px', top: '10px', color: 'var(--text-muted)' }} />
        </div>
        <button type="submit" className="btn">Search</button>
      </form>

      {/* Category Chips */}
      <div className="chips-container">
        {CATEGORIES.map((cat) => (
          <button
            key={cat}
            className={`chip ${category === cat ? 'active' : ''}`}
            onClick={() => setCategory(cat)}
          >
            {cat}
          </button>
        ))}
      </div>

      {/* Products Grid or Empty State */}
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-muted)' }}>
          Loading catalog items...
        </div>
      ) : products.length === 0 ? (
        <div className="empty-state">
          <div className="empty-state-title">No products in catalog</div>
          <p className="empty-state-text">
            The catalog is currently empty. Add products manually or bulk import a CSV list.
          </p>
          <button className="btn btn-primary" onClick={openCreateModal}>
            <Plus size={16} /> Add First Product
          </button>
        </div>
      ) : (
        <div className="products-grid">
          {products.map((p) => (
            <div key={p.id} className="product-card">
              <div>
                <div className="product-category-tag">{p.category || 'General'}</div>
                <div className="product-title">{p.name}</div>
                <div className="product-barcode">Barcode: {p.barcode}</div>
                {p.stock !== null && (
                  <div style={{ fontSize: '0.78rem', color: p.stock > 0 ? 'var(--text-muted)' : 'var(--danger)', marginBottom: '8px' }}>
                    Stock: {p.stock > 0 ? `${p.stock} units` : 'Out of stock'}
                  </div>
                )}
              </div>

              <div className="product-footer">
                <div>
                  <div className="product-price">₹{Number(p.price).toFixed(2)}</div>
                  <span className="product-gst">+{p.gst_percent}% GST</span>
                </div>

                <div style={{ display: 'flex', gap: '4px' }}>
                  <button
                    className="btn btn-sm"
                    title="Edit Product"
                    onClick={() => openEditModal(p)}
                  >
                    <Edit2 size={13} />
                  </button>
                  <button
                    className="btn btn-sm"
                    title="Delete Product"
                    onClick={() => handleDeleteProduct(p.id)}
                  >
                    <Trash2 size={13} style={{ color: 'var(--danger)' }} />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Add / Edit Product Modal */}
      {showAddModal && (
        <div className="modal-overlay" onClick={() => setShowAddModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <h3 className="card-title">{editingProduct ? 'Edit Product' : 'Add New Product'}</h3>
              <button className="btn btn-sm" onClick={() => setShowAddModal(false)}>✕</button>
            </div>

            <form onSubmit={handleSaveProduct}>
              <div className="form-group">
                <label className="form-label">Barcode Number *</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="text"
                    required
                    className="input"
                    placeholder="e.g. 8901030383921"
                    value={formBarcode}
                    onChange={(e) => setFormBarcode(e.target.value)}
                  />
                  <button
                    type="button"
                    className="btn btn-sm"
                    style={{ whiteSpace: 'nowrap' }}
                    disabled={!formBarcode.trim() || aiLoading}
                    onClick={handleAiLookup}
                  >
                    {aiLoading ? 'Looking up...' : 'AI Suggest'}
                  </button>
                </div>
              </div>

              <div className="form-group">
                <label className="form-label">Product Name *</label>
                <input
                  type="text"
                  required
                  className="input"
                  placeholder="e.g. Amul Butter 100g"
                  value={formName}
                  onChange={(e) => setFormName(e.target.value)}
                />
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-group">
                  <label className="form-label">Category</label>
                  <select
                    className="select"
                    value={formCategory}
                    onChange={(e) => setFormCategory(e.target.value)}
                  >
                    {CATEGORIES.filter(c => c !== 'All').map(c => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                    <option value="General">General</option>
                  </select>
                </div>

                <div className="form-group">
                  <label className="form-label">Price (₹) *</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    required
                    className="input"
                    placeholder="0.00"
                    value={formPrice}
                    onChange={(e) => setFormPrice(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px' }}>
                <div className="form-group">
                  <label className="form-label">GST Rate (%)</label>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="100"
                    className="input"
                    placeholder="5.0"
                    value={formGst}
                    onChange={(e) => setFormGst(e.target.value)}
                  />
                </div>

                <div className="form-group">
                  <label className="form-label">Stock Quantity (optional)</label>
                  <input
                    type="number"
                    min="0"
                    className="input"
                    placeholder="Unlimited if blank"
                    value={formStock}
                    onChange={(e) => setFormStock(e.target.value)}
                  />
                </div>
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '16px' }}>
                <button type="button" className="btn" onClick={() => setShowAddModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">
                  {editingProduct ? 'Save Changes' : 'Create Product'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Bulk Import Modal */}
      {showImportModal && (
        <div className="modal-overlay" onClick={() => setShowImportModal(false)}>
          <div className="modal-content" onClick={(e) => e.stopPropagation()}>
            <div className="card-header">
              <h3 className="card-title">Bulk Import Products</h3>
              <button className="btn btn-sm" onClick={() => setShowImportModal(false)}>✕</button>
            </div>

            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
              Paste CSV text with header: <code>barcode,name,category,price,gst_percent,stock</code>
            </p>

            <form onSubmit={handleImportSubmit}>
              <div className="form-group">
                <textarea
                  className="textarea"
                  rows={8}
                  placeholder={`barcode,name,category,price,gst_percent,stock\n890100,Amul Taaza Milk,Dairy,27.00,5,30\n890101,Lays Classic Salted,Snacks,20.00,12,50`}
                  value={importCsv}
                  onChange={(e) => setImportCsv(e.target.value)}
                />
              </div>

              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: '8px', marginTop: '14px' }}>
                <button type="button" className="btn" onClick={() => setShowImportModal(false)}>Cancel</button>
                <button type="submit" className="btn btn-primary">Process Import</button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}

export const ShopView = memo(ShopViewComponent);

