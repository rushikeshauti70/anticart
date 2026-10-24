import React, { useState, useEffect, useRef } from 'react';
import { Camera, CameraOff, Plus, CheckCircle, AlertTriangle, ArrowRight } from 'lucide-react';
import { api } from '../api';

function generateUuid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

export function ScanView({ onNavigateToCart, onNavigateToShop }) {
  const [cameraActive, setCameraActive] = useState(false);
  const [scannerStatus, setScannerStatus] = useState('Camera idle');
  const [manualBarcode, setManualBarcode] = useState('');
  const [lastScanned, setLastScanned] = useState(null);
  const [unknownBarcode, setUnknownBarcode] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [successNotice, setSuccessNotice] = useState('');

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const lastDetectedRef = useRef({ code: '', time: 0 });

  // Cleanup camera stream on unmount
  useEffect(() => {
    return () => {
      stopCamera();
    };
  }, []);

  async function startCamera() {
    setErrorMessage('');
    setUnknownBarcode(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
      });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        videoRef.current.play();
      }
      setCameraActive(true);
      setScannerStatus('Align barcode within reticle');
      beginDetectionLoop();
    } catch (err) {
      setErrorMessage(`Camera access error: ${err.message}. Use manual barcode entry below.`);
      setCameraActive(false);
    }
  }

  function stopCamera() {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    setCameraActive(false);
    setScannerStatus('Camera idle');
  }

  function beginDetectionLoop() {
    if (typeof window.BarcodeDetector === 'undefined') {
      setScannerStatus('BarcodeDetector not natively supported. Use manual entry or Chrome/Edge.');
      return;
    }

    const detector = new window.BarcodeDetector({
      formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'],
    });

    scanIntervalRef.current = setInterval(async () => {
      if (!videoRef.current || videoRef.current.readyState < 2) return;

      try {
        const barcodes = await detector.detect(videoRef.current);
        if (barcodes.length > 0) {
          const rawValue = barcodes[0].rawValue;
          handleDetectedBarcode(rawValue);
        }
      } catch (err) {
        // frame detection error, skip
      }
    }, 400);
  }

  function handleDetectedBarcode(barcode) {
    const now = Date.now();
    const last = lastDetectedRef.current;

    // 1.5 second debounce for repeated stream detections of the exact same code
    if (last.code === barcode && now - last.time < 1500) {
      return;
    }

    lastDetectedRef.current = { code: barcode, time: now };
    submitScan(barcode);
  }

  async function submitScan(barcode) {
    if (!barcode || !barcode.trim()) return;
    const cleanCode = barcode.trim();
    setErrorMessage('');
    setUnknownBarcode(null);
    setScannerStatus(`Scanning ${cleanCode}...`);

    const scanId = generateUuid();

    try {
      const res = await api.scanBarcode({
        barcode: cleanCode,
        scanId,
        trolleyId: 'trolley-01',
      });

      setLastScanned({
        product: res.product,
        duplicate: res.duplicate,
        time: new Date().toLocaleTimeString(),
      });

      setScannerStatus(`Item added: ${res.product?.name || cleanCode}`);
      setSuccessNotice(`Added ${res.product?.name || cleanCode} (₹${Number(res.product?.price || 0).toFixed(2)})`);
      setTimeout(() => setSuccessNotice(''), 4000);
    } catch (err) {
      if (err.code === 'UNKNOWN_BARCODE') {
        setUnknownBarcode(cleanCode);
        setScannerStatus(`Barcode ${cleanCode} not found`);
      } else {
        setErrorMessage(err.message || 'Scan processing failed');
        setScannerStatus('Scan failed');
      }
    }
  }

  function handleManualSubmit(e) {
    e.preventDefault();
    if (manualBarcode.trim()) {
      submitScan(manualBarcode.trim());
      setManualBarcode('');
    }
  }

  return (
    <div>
      <div style={{ marginBottom: '14px' }}>
        <h1 style={{ fontSize: '1.4rem', fontWeight: 700 }}>Scan Product</h1>
        <p style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
          Scan barcodes using your camera or enter the number manually
        </p>
      </div>

      {/* Notifications */}
      {successNotice && (
        <div className="toast-banner toast-success">
          <span>{successNotice}</span>
          <button className="btn btn-sm" onClick={onNavigateToCart}>
            View Cart <ArrowRight size={13} />
          </button>
        </div>
      )}

      {errorMessage && (
        <div className="toast-banner toast-danger">
          <span>{errorMessage}</span>
          <button className="btn btn-sm" onClick={() => setErrorMessage('')}>Dismiss</button>
        </div>
      )}

      {/* Unknown Barcode Banner with Direct Action */}
      {unknownBarcode && (
        <div className="toast-banner toast-warning" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
          <div>
            <strong>Barcode not in catalog:</strong> {unknownBarcode}
          </div>
          <p style={{ fontSize: '0.82rem', color: 'var(--accent-dark)' }}>
            This item does not exist in the master catalog yet.
          </p>
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
            <button className="btn btn-sm btn-primary" onClick={onNavigateToShop}>
              <Plus size={13} /> Add to Catalog
            </button>
            <button className="btn btn-sm" onClick={() => setUnknownBarcode(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Camera Viewport Section */}
      <div className="card" style={{ padding: '0', overflow: 'hidden', position: 'relative' }}>
        <div style={{
          backgroundColor: '#0F172A',
          height: '280px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative'
        }}>
          {cameraActive ? (
            <>
              <video
                ref={videoRef}
                playsInline
                muted
                style={{ width: '100%', height: '100%', objectFit: 'cover' }}
              />
              {/* Targeting Reticle */}
              <div style={{
                position: 'absolute',
                width: '220px',
                height: '140px',
                border: '2px solid var(--primary)',
                borderRadius: '8px',
                boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.45)',
                pointerEvents: 'none',
              }}>
                <div style={{
                  position: 'absolute',
                  top: '50%',
                  left: '10px',
                  right: '10px',
                  height: '2px',
                  backgroundColor: 'var(--primary)',
                  opacity: 0.85,
                }} />
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', color: '#94A3B8', padding: '20px' }}>
              <Camera size={44} style={{ marginBottom: '10px', opacity: 0.6 }} />
              <div style={{ fontSize: '0.9rem', fontWeight: 500 }}>Camera is currently off</div>
              <p style={{ fontSize: '0.78rem', marginTop: '4px' }}>
                Tap Start Camera to begin automatic barcode scanning
              </p>
            </div>
          )}
        </div>

        {/* Camera Controls & Status Bar */}
        <div style={{
          padding: '12px 16px',
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          borderTop: '1px solid var(--border)',
          backgroundColor: 'var(--surface)'
        }}>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Status: <span style={{ fontWeight: 600, color: 'var(--text)' }}>{scannerStatus}</span>
          </div>

          <div>
            {cameraActive ? (
              <button className="btn btn-sm btn-danger" onClick={stopCamera}>
                <CameraOff size={14} /> Stop Camera
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={startCamera}>
                <Camera size={14} /> Start Camera
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Manual Barcode Entry Card */}
      <div className="card">
        <h3 className="card-title" style={{ marginBottom: '10px' }}>Manual Barcode Entry</h3>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
          Enter or type any barcode number directly without using the camera
        </p>

        <form onSubmit={handleManualSubmit} style={{ display: 'flex', gap: '8px' }}>
          <input
            type="text"
            className="input"
            placeholder="e.g. 8901234567890"
            value={manualBarcode}
            onChange={(e) => setManualBarcode(e.target.value)}
          />
          <button type="submit" className="btn btn-primary" disabled={!manualBarcode.trim()}>
            Add to Cart
          </button>
        </form>
      </div>

      {/* Last Scanned Item Summary */}
      {lastScanned && lastScanned.product && (
        <div className="card" style={{ borderColor: 'var(--primary-dark)', backgroundColor: 'var(--primary-soft)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: '0.75rem', color: 'var(--primary-dark)', fontWeight: 600 }}>
                LAST SCANNED ITEM ({lastScanned.time})
              </div>
              <div style={{ fontSize: '1.05rem', fontWeight: 700, marginTop: '2px' }}>
                {lastScanned.product.name}
              </div>
              <div style={{ fontSize: '0.8rem', color: 'var(--text-muted)' }}>
                Barcode: {lastScanned.product.barcode} · {lastScanned.product.category}
              </div>
            </div>

            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: '1.2rem', fontWeight: 700 }}>
                ₹{Number(lastScanned.product.price).toFixed(2)}
              </div>
              <div style={{ fontSize: '0.75rem', color: 'var(--text-muted)' }}>
                +{lastScanned.product.gst_percent}% GST
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
