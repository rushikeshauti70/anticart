import React, { useState, memo } from 'react';
import { Trash2, Plus, Minus, CheckCircle, Printer, ShoppingBag, ArrowRight } from 'lucide-react';
import { api } from '../api';

function CartViewComponent({ cart, onCartUpdated, onNavigateToShop, onNavigateToScan }) {
  const [loading, setLoading] = useState(false);
  const [bill, setBill] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');

  const items = cart?.items || [];
  const hasItems = items.length > 0;

  async function handleQuantityChange(productId, newQty) {
    setLoading(true);
    setErrorMessage('');
    try {
      const updated = await api.updateCartItemQuantity({
        productId,
        quantity: newQty,
        trolleyId: cart?.trolley_id || 'trolley-01',
      });
      onCartUpdated(updated);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to update item quantity');
    } finally {
      setLoading(false);
    }
  }

  async function handleRemoveItem(productId) {
    setLoading(true);
    setErrorMessage('');
    try {
      const updated = await api.removeCartItem({
        productId,
        trolleyId: cart?.trolley_id || 'trolley-01',
      });
      onCartUpdated(updated);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to remove item');
    } finally {
      setLoading(false);
    }
  }

  async function handleCancelCart() {
    if (!window.confirm('Are you sure you want to cancel and clear this cart?')) return;
    setLoading(true);
    setErrorMessage('');
    try {
      const res = await api.cancelCart(cart?.trolley_id || 'trolley-01');
      onCartUpdated(res.cart);
    } catch (err) {
      setErrorMessage(err.message || 'Failed to cancel cart');
    } finally {
      setLoading(false);
    }
  }

  async function handleCheckout() {
    setLoading(true);
    setErrorMessage('');
    try {
      const res = await api.checkoutCart(cart?.trolley_id || 'trolley-01');
      setBill(res.purchase);
      onCartUpdated(res.cart);
    } catch (err) {
      setErrorMessage(err.message || 'Checkout failed');
    } finally {
      setLoading(false);
    }
  }

  // Printable Bill Receipt View
  if (bill) {
    return (
      <div>
        <div className="no-print" style={{ marginBottom: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Purchase Completed</h1>
            <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
              Receipt generated. You can print or save this bill.
            </p>
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button className="btn" onClick={() => window.print()}>
              <Printer size={15} /> Print Bill
            </button>
            <button className="btn btn-primary" onClick={() => setBill(null)}>
              Start New Cart <ArrowRight size={15} />
            </button>
          </div>
        </div>

        {/* Printable Bill Area */}
        <div className="card" style={{ maxWidth: '640px', margin: '0 auto', padding: '24px' }}>
          <div style={{ textAlign: 'center', borderBottom: '1px solid var(--border)', paddingBottom: '16px', marginBottom: '16px' }}>
            <h2 style={{ fontSize: '1.25rem', fontWeight: 700, letterSpacing: '-0.02em' }}>AVCOE SMART TROLLEY SHOP</h2>
            <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginTop: '2px' }}>
              Amrutvahini College of Engineering, Sangamner
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--text-light)', marginTop: '4px' }}>
              Tax Invoice / Retail Sale Bill
            </div>
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '0.82rem', marginBottom: '16px', color: 'var(--text-muted)' }}>
            <div>
              <div><strong>Bill No:</strong> {bill.id.substring(0, 8).toUpperCase()}</div>
              <div><strong>Trolley ID:</strong> {bill.trolley_id}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div><strong>Date:</strong> {new Date(bill.created_at).toLocaleDateString()}</div>
              <div><strong>Time:</strong> {new Date(bill.created_at).toLocaleTimeString()}</div>
            </div>
          </div>

          <table className="cart-table" style={{ marginBottom: '16px' }}>
            <thead>
              <tr>
                <th>Item</th>
                <th style={{ textAlign: 'center' }}>Qty</th>
                <th style={{ textAlign: 'right' }}>Price</th>
                <th style={{ textAlign: 'right' }}>GST</th>
                <th style={{ textAlign: 'right' }}>Total</th>
              </tr>
            </thead>
            <tbody>
              {bill.items?.map((item, idx) => (
                <tr key={idx}>
                  <td>
                    <div style={{ fontWeight: 600 }}>{item.name}</div>
                    <div style={{ fontSize: '0.72rem', color: 'var(--text-muted)' }}>GST {item.gst_percent}%</div>
                  </td>
                  <td style={{ textAlign: 'center' }}>{item.quantity}</td>
                  <td style={{ textAlign: 'right' }}>₹{Number(item.price).toFixed(2)}</td>
                  <td style={{ textAlign: 'right' }}>₹{Number(item.line_gst).toFixed(2)}</td>
                  <td style={{ textAlign: 'right', fontWeight: 600 }}>₹{Number(item.line_total).toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>

          <div className="summary-box" style={{ marginTop: '0' }}>
            <div className="summary-row">
              <span>Subtotal</span>
              <span>₹{Number(bill.subtotal).toFixed(2)}</span>
            </div>
            <div className="summary-row">
              <span>Applicable GST</span>
              <span>₹{Number(bill.gst_total).toFixed(2)}</span>
            </div>
            <div className="summary-row total">
              <span>Grand Total</span>
              <span>₹{Number(bill.total).toFixed(2)}</span>
            </div>
          </div>

          <div style={{ textAlign: 'center', marginTop: '20px', fontSize: '0.78rem', color: 'var(--text-muted)' }}>
            Thank you for shopping at AVCOE Smart Trolley!
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <div style={{ marginBottom: '14px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Your Cart</h1>
          <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
            Review scanned products and finalize checkout
          </p>
        </div>

        {hasItems && (
          <button className="btn btn-sm btn-danger" onClick={handleCancelCart} disabled={loading}>
            Clear Cart
          </button>
        )}
      </div>

      {errorMessage && (
        <div className="toast-banner toast-danger">
          <span>{errorMessage}</span>
          <button className="btn btn-sm" onClick={() => setErrorMessage('')}>Dismiss</button>
        </div>
      )}

      {!hasItems ? (
        <div className="empty-state">
          <ShoppingBag size={40} style={{ margin: '0 auto 12px', color: 'var(--text-light)' }} />
          <div className="empty-state-title">Your cart is empty</div>
          <p className="empty-state-text">
            Scan product barcodes with the camera or browse the catalog to add items.
          </p>
          <div style={{ display: 'flex', justifyContent: 'center', gap: '8px' }}>
            <button className="btn btn-primary" onClick={onNavigateToScan}>
              Scan Barcode
            </button>
            <button className="btn" onClick={onNavigateToShop}>
              Browse Catalog
            </button>
          </div>
        </div>
      ) : (
        <div>
          <div className="card" style={{ padding: '0', overflowX: 'auto' }}>
            <table className="cart-table">
              <thead>
                <tr>
                  <th>Product</th>
                  <th style={{ textAlign: 'right' }}>Price</th>
                  <th style={{ textAlign: 'center' }}>Quantity</th>
                  <th style={{ textAlign: 'right' }}>Total</th>
                  <th style={{ width: '40px' }}></th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => (
                  <tr key={item.id}>
                    <td>
                      <div style={{ fontWeight: 600 }}>{item.name}</div>
                      <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                        Barcode: {item.barcode} · {item.gst_percent}% GST
                      </div>
                    </td>
                    <td style={{ textAlign: 'right' }}>
                      ₹{Number(item.price).toFixed(2)}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <div className="quantity-stepper">
                        <button
                          className="stepper-btn"
                          disabled={loading}
                          onClick={() => handleQuantityChange(item.product_id, item.quantity - 1)}
                        >
                          <Minus size={13} />
                        </button>
                        <span className="stepper-value">{item.quantity}</span>
                        <button
                          className="stepper-btn"
                          disabled={loading}
                          onClick={() => handleQuantityChange(item.product_id, item.quantity + 1)}
                        >
                          <Plus size={13} />
                        </button>
                      </div>
                    </td>
                    <td style={{ textAlign: 'right', fontWeight: 600 }}>
                      ₹{Number(item.line_total).toFixed(2)}
                    </td>
                    <td style={{ textAlign: 'center' }}>
                      <button
                        className="btn btn-sm"
                        style={{ padding: '4px', border: 'none' }}
                        title="Remove item"
                        onClick={() => handleRemoveItem(item.product_id)}
                      >
                        <Trash2 size={15} style={{ color: 'var(--danger)' }} />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {/* Totals Summary */}
          <div className="summary-box">
            <div className="summary-row">
              <span>Subtotal ({cart.item_count || 0} items)</span>
              <span>₹{Number(cart.subtotal || 0).toFixed(2)}</span>
            </div>
            <div className="summary-row">
              <span>Total GST</span>
              <span>₹{Number(cart.gst_total || 0).toFixed(2)}</span>
            </div>
            <div className="summary-row total">
              <span>Grand Total</span>
              <span>₹{Number(cart.total || 0).toFixed(2)}</span>
            </div>

            <button
              className="btn btn-primary btn-lg"
              style={{ width: '100%', marginTop: '16px' }}
              disabled={loading}
              onClick={handleCheckout}
            >
              <CheckCircle size={18} /> Checkout & Generate Bill (₹{Number(cart.total || 0).toFixed(2)})
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export const CartView = memo(CartViewComponent);

