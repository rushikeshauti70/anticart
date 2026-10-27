import React, { useState, useEffect, useRef, memo, useCallback } from 'react';
import { Camera, CameraOff, Plus, ArrowRight, RefreshCw, Zap, ZapOff, Image as ImageIcon, AlertCircle } from 'lucide-react';
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

// Lazy-load ZXing reader only when required to keep the initial bundle ultra-fast
let zxingModulePromise = null;
async function getZxingReader() {
  if (!zxingModulePromise) {
    zxingModulePromise = import('@zxing/library').then((mod) => new mod.BrowserMultiFormatReader());
  }
  return zxingModulePromise;
}

function ScanViewComponent({ onNavigateToCart, onNavigateToShop }) {
  const [cameraActive, setCameraActive] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [scannerStatus, setScannerStatus] = useState('Camera idle');
  const [manualBarcode, setManualBarcode] = useState('');
  const [lastScanned, setLastScanned] = useState(null);
  const [unknownBarcode, setUnknownBarcode] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [successNotice, setSuccessNotice] = useState('');

  // Device & torch states
  const [availableCameras, setAvailableCameras] = useState([]);
  const [selectedCameraIndex, setSelectedCameraIndex] = useState(0);
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const zxingReaderRef = useRef(null);
  const lastDetectedRef = useRef({ code: '', time: 0 });
  const isMountedRef = useRef(true);
  const fileInputRef = useRef(null);

  useEffect(() => {
    isMountedRef.current = true;
    updateAvailableCameras();

    return () => {
      isMountedRef.current = false;
      stopCamera();
    };
  }, []);

  async function updateAvailableCameras() {
    if (!navigator?.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter((d) => d.kind === 'videoinput');
      if (isMountedRef.current && videoInputs.length > 0) {
        setAvailableCameras(videoInputs);
      }
    } catch (e) {
      // Ignore enumeration permission restrictions before user interaction
    }
  }

  // Progressive stream acquisition with timeout & 3 resilient tiers
  async function acquireMediaStream(deviceId = null) {
    if (!navigator?.mediaDevices?.getUserMedia) {
      if (typeof window !== 'undefined' && !window.isSecureContext) {
        throw new Error('Camera access requires HTTPS or localhost. Please open via HTTPS or use manual barcode entry.');
      }
      throw new Error('Camera access is not supported by this browser. Use manual barcode entry.');
    }

    const requestWithTimeout = (constraints, ms = 9000) => {
      return Promise.race([
        navigator.mediaDevices.getUserMedia(constraints),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error('Camera request timed out. Please check browser permissions.')), ms)
        ),
      ]);
    };

    // Tier 1: Rear camera with 720p ideal constraint
    try {
      const tier1 = {
        video: deviceId
          ? { deviceId: { exact: deviceId } }
          : {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
        audio: false,
      };
      return await requestWithTimeout(tier1, 5000);
    } catch (err1) {
      if (err1.name === 'NotAllowedError' || err1.name === 'PermissionDeniedError') {
        throw err1;
      }
      console.warn('[CAMERA] Tier 1 constraint rejected, attempting Tier 2:', err1.message);
    }

    // Tier 2: Basic environment facing camera
    try {
      const tier2 = {
        video: deviceId
          ? { deviceId: { exact: deviceId } }
          : { facingMode: 'environment' },
        audio: false,
      };
      return await requestWithTimeout(tier2, 5000);
    } catch (err2) {
      if (err2.name === 'NotAllowedError' || err2.name === 'PermissionDeniedError') {
        throw err2;
      }
      console.warn('[CAMERA] Tier 2 rejected, attempting Tier 3 universal video:', err2.message);
    }

    // Tier 3: Universal fallback (webcam / front camera / any video device)
    return await requestWithTimeout({ video: true, audio: false }, 7000);
  }

  async function startCamera(targetDeviceId = null) {
    if (isStarting) return;
    setIsStarting(true);
    setErrorMessage('');
    setUnknownBarcode(null);
    setScannerStatus('Opening camera...');

    // Release any previous hardware stream with slight pause to allow OS driver recovery
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try { track.stop(); } catch (e) {}
      });
      streamRef.current = null;
      await new Promise((r) => setTimeout(r, 60));
    }

    try {
      const stream = await acquireMediaStream(targetDeviceId);
      if (!isMountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;

      // Check for torch capability
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack?.getCapabilities) {
        const caps = videoTrack.getCapabilities();
        setTorchSupported(Boolean(caps.torch));
      } else {
        setTorchSupported(false);
      }
      setTorchOn(false);

      const video = videoRef.current;
      if (video) {
        // Essential for iOS Safari / Mobile webkit
        video.setAttribute('playsinline', 'true');
        video.setAttribute('autoplay', 'true');
        video.setAttribute('muted', 'true');
        video.playsInline = true;
        video.muted = true;
        video.srcObject = stream;

        // Wait for metadata ready before issuing play() to prevent AbortError
        await new Promise((resolve) => {
          let resolved = false;
          const onReady = async () => {
            if (resolved) return;
            resolved = true;
            video.removeEventListener('loadedmetadata', onReady);
            video.removeEventListener('canplay', onReady);
            try {
              await video.play();
            } catch (playErr) {
              console.warn('[CAMERA] Play interrupted, continuing:', playErr.message);
            }
            resolve();
          };

          if (video.readyState >= 2) {
            onReady();
          } else {
            video.addEventListener('loadedmetadata', onReady, { once: true });
            video.addEventListener('canplay', onReady, { once: true });
            setTimeout(onReady, 2500); // Failsafe timeout
          }
        });
      }

      setCameraActive(true);
      setIsStarting(false);
      setScannerStatus('Align barcode within reticle');

      updateAvailableCameras();
      beginDetectionLoop();
    } catch (err) {
      console.error('[CAMERA ERROR]', err);
      if (!isMountedRef.current) return;

      setIsStarting(false);
      setCameraActive(false);

      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setErrorMessage('Camera permission was denied. Click the lock/camera icon in your address bar to allow camera access.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setErrorMessage('No camera device found on this system. Please use manual barcode entry or photo upload.');
      } else if (err.name === 'NotReadableError' || err.name === 'TrackStartError') {
        setErrorMessage('Camera is currently busy or being used by another application. Please close other camera tabs and try again.');
      } else {
        setErrorMessage(err.message || 'Unable to open camera. You can still enter barcodes manually.');
      }
      setScannerStatus('Camera unavailable');
    }
  }

  function stopCamera() {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }

    if (zxingReaderRef.current) {
      try {
        zxingReaderRef.current.reset();
      } catch (e) {}
      zxingReaderRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try { track.stop(); } catch (e) {}
      });
      streamRef.current = null;
    }

    if (videoRef.current) {
      videoRef.current.srcObject = null;
    }

    setCameraActive(false);
    setIsStarting(false);
    setTorchOn(false);
    setTorchSupported(false);
    setScannerStatus('Camera idle');
  }

  async function handleSwitchCamera() {
    if (availableCameras.length <= 1) return;
    const nextIndex = (selectedCameraIndex + 1) % availableCameras.length;
    setSelectedCameraIndex(nextIndex);
    const nextCamera = availableCameras[nextIndex];
    await startCamera(nextCamera.deviceId);
  }

  async function handleToggleTorch() {
    if (!streamRef.current) return;
    const track = streamRef.current.getVideoTracks()[0];
    if (!track) return;
    try {
      const nextTorch = !torchOn;
      await track.applyConstraints({
        advanced: [{ torch: nextTorch }],
      });
      setTorchOn(nextTorch);
    } catch (e) {
      console.warn('[CAMERA] Torch error:', e.message);
    }
  }

  async function beginDetectionLoop() {
    const hasNativeDetector = typeof window.BarcodeDetector !== 'undefined';

    if (hasNativeDetector) {
      // ENGINE 1: Hardware native detector (instantaneous, zero overhead)
      const detector = new window.BarcodeDetector({
        formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'],
      });

      scanIntervalRef.current = setInterval(async () => {
        if (!videoRef.current || videoRef.current.readyState < 2) return;

        try {
          const barcodes = await detector.detect(videoRef.current);
          if (barcodes.length > 0 && barcodes[0].rawValue) {
            handleDetectedBarcode(barcodes[0].rawValue);
          }
        } catch (err) {
          // Skip frame glitches
        }
      }, 300);
    } else {
      // ENGINE 2: On-demand ZXing fallback (dynamically loaded)
      setScannerStatus('Using ZXing compatibility scanner');
      try {
        const reader = await getZxingReader();
        zxingReaderRef.current = reader;

        scanIntervalRef.current = setInterval(async () => {
          if (!videoRef.current || videoRef.current.readyState < 2) return;

          try {
            const result = await reader.decodeFromVideoElement(videoRef.current);
            if (result && result.getText()) {
              handleDetectedBarcode(result.getText());
            }
          } catch (err) {
            // Normal when frame has no barcode
          }
        }, 320);
      } catch (loadErr) {
        setErrorMessage('Scanner engine failed to load. Please use manual entry.');
      }
    }
  }

  function handleDetectedBarcode(barcode) {
    const now = Date.now();
    const last = lastDetectedRef.current;

    // 1.5s debounce for stream duplicates
    if (last.code === barcode && now - last.time < 1500) {
      return;
    }

    lastDetectedRef.current = { code: barcode, time: now };
    submitScan(barcode);
  }

  // Backup photo decoder: scan directly from captured image file
  async function handleFileScan(e) {
    const file = e.target.files?.[0];
    if (!file) return;

    setScannerStatus('Decoding barcode from image...');
    setErrorMessage('');

    try {
      const img = new Image();
      const objectUrl = URL.createObjectURL(file);
      img.src = objectUrl;

      await new Promise((resolve, reject) => {
        img.onload = resolve;
        img.onerror = () => reject(new Error('Failed to load image'));
      });

      let detectedCode = null;

      if (typeof window.BarcodeDetector !== 'undefined') {
        const detector = new window.BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'],
        });
        const barcodes = await detector.detect(img);
        if (barcodes.length > 0 && barcodes[0].rawValue) {
          detectedCode = barcodes[0].rawValue;
        }
      }

      if (!detectedCode) {
        const reader = await getZxingReader();
        const result = await reader.decodeFromImageElement(img);
        if (result && result.getText()) {
          detectedCode = result.getText();
        }
      }

      URL.revokeObjectURL(objectUrl);

      if (detectedCode) {
        submitScan(detectedCode);
      } else {
        setErrorMessage('No clear barcode recognized in this image. Try capturing closer or enter number manually.');
        setScannerStatus('No barcode found in image');
      }
    } catch (err) {
      setErrorMessage('Could not read barcode from image. Please enter the number manually.');
      setScannerStatus('Image scan failed');
    }

    // Reset input value so same file can be re-selected if needed
    e.target.value = '';
  }

  const submitScan = useCallback(async (barcode) => {
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
      setTimeout(() => {
        if (isMountedRef.current) setSuccessNotice('');
      }, 4000);
    } catch (err) {
      if (err.code === 'UNKNOWN_BARCODE') {
        setUnknownBarcode(cleanCode);
        setScannerStatus(`Barcode ${cleanCode} not found`);
      } else {
        setErrorMessage(err.message || 'Scan processing failed');
        setScannerStatus('Scan failed');
      }
    }
  }, []);

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
          position: 'relative',
          overflow: 'hidden',
        }}>
          {/* Video is always mounted in the DOM to eliminate ref timing issues */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              display: cameraActive ? 'block' : 'none',
            }}
          />

          {cameraActive ? (
            <>
              {/* Targeting Reticle */}
              <div style={{
                position: 'absolute',
                width: '230px',
                height: '140px',
                border: '2px solid var(--primary)',
                borderRadius: '8px',
                boxShadow: '0 0 0 9999px rgba(15, 23, 42, 0.45)',
                pointerEvents: 'none',
              }}>
                {/* Animated Sweeping Laser */}
                <div className="scanner-laser" />
              </div>

              {/* In-view Camera Toolbar */}
              <div style={{
                position: 'absolute',
                top: '12px',
                right: '12px',
                display: 'flex',
                gap: '8px',
                zIndex: 10,
              }}>
                {torchSupported && (
                  <button
                    className="btn btn-sm"
                    onClick={handleToggleTorch}
                    title="Toggle Flashlight"
                    style={{
                      backgroundColor: torchOn ? 'var(--accent)' : 'rgba(15, 23, 42, 0.7)',
                      color: torchOn ? '#0F172A' : '#FFFFFF',
                      border: 'none',
                      padding: '6px 10px',
                    }}
                  >
                    {torchOn ? <Zap size={14} /> : <ZapOff size={14} />}
                  </button>
                )}

                {availableCameras.length > 1 && (
                  <button
                    className="btn btn-sm"
                    onClick={handleSwitchCamera}
                    title="Switch Camera"
                    style={{
                      backgroundColor: 'rgba(15, 23, 42, 0.7)',
                      color: '#FFFFFF',
                      border: 'none',
                      padding: '6px 10px',
                    }}
                  >
                    <RefreshCw size={14} />
                  </button>
                )}
              </div>
            </>
          ) : (
            <div style={{ textAlign: 'center', color: '#94A3B8', padding: '20px' }}>
              <Camera size={44} style={{ marginBottom: '10px', opacity: 0.6 }} />
              <div style={{ fontSize: '0.9rem', fontWeight: 500 }}>
                {isStarting ? 'Opening camera...' : 'Camera is currently off'}
              </div>
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
          backgroundColor: 'var(--surface)',
          flexWrap: 'wrap',
          gap: '8px',
        }}>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Status: <span style={{ fontWeight: 600, color: 'var(--text)' }}>{scannerStatus}</span>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            {/* Hidden file input for photo upload scan */}
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              capture="environment"
              onChange={handleFileScan}
              style={{ display: 'none' }}
            />

            <button
              className="btn btn-sm"
              onClick={() => fileInputRef.current?.click()}
              title="Upload photo of barcode"
            >
              <ImageIcon size={14} /> Scan Photo
            </button>

            {cameraActive ? (
              <button className="btn btn-sm btn-danger" onClick={stopCamera}>
                <CameraOff size={14} /> Stop Camera
              </button>
            ) : (
              <button
                className="btn btn-sm btn-primary"
                onClick={() => startCamera()}
                disabled={isStarting}
              >
                <Camera size={14} /> {isStarting ? 'Starting...' : 'Start Camera'}
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

export const ScanView = memo(ScanViewComponent);
