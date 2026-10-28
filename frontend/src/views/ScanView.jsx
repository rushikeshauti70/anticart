import React, { useState, useEffect, useRef, useCallback } from 'react';
import { Camera, CameraOff, Plus, CheckCircle, AlertTriangle, ArrowRight, Zap, ZapOff, Sparkles, RefreshCw } from 'lucide-react';
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

// Modulo-10 checksum validator for EAN-13, EAN-8, UPC-A, and ITF-14
function validateEanUpcChecksum(barcode) {
  if (!barcode || typeof barcode !== 'string') return false;
  const digits = barcode.trim();
  // If not standard numeric barcode, allow through (e.g. Code 128 / Code 39 / QR)
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(digits)) return true;

  const len = digits.length;
  let sum = 0;
  for (let i = 0; i < len - 1; i++) {
    const digit = parseInt(digits[i], 10);
    const weight = ((len - 1 - i) % 2 === 1) ? 3 : 1;
    sum += digit * weight;
  }
  const calcCheck = (10 - (sum % 10)) % 10;
  return calcCheck === parseInt(digits[len - 1], 10);
}

// Immediate audio chime via Web Audio API on successful barcode detection
function playPosChime() {
  try {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtx) return;
    const ctx = new AudioCtx();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(880, ctx.currentTime);
    osc.frequency.setValueAtTime(1320, ctx.currentTime + 0.05);
    gain.gain.setValueAtTime(0.2, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + 0.14);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start();
    osc.stop(ctx.currentTime + 0.14);
  } catch (e) {
    // Handled silently if autoplay audio context policy requires user gesture
  }
}

// Immediate haptic confirmation on mobile devices
function triggerHaptic() {
  try {
    if (typeof navigator !== 'undefined' && navigator.vibrate) {
      navigator.vibrate([45]);
    }
  } catch (e) {}
}

// Dynamic ZXing module loader for resilient software fallback on iOS / Safari / Firefox
let zxingModulePromise = null;
async function getZxingModule() {
  if (!zxingModulePromise) {
    zxingModulePromise = import('@zxing/library').then((mod) => {
      const {
        MultiFormatReader,
        DecodeHintType,
        BarcodeFormat,
        BinaryBitmap,
        HybridBinarizer,
        GlobalHistogramBinarizer,
        HTMLCanvasElementLuminanceSource,
      } = mod;

      const hints = new Map();
      hints.set(DecodeHintType.TRY_HARDER, true);
      hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.EAN_13,
        BarcodeFormat.EAN_8,
        BarcodeFormat.UPC_A,
        BarcodeFormat.UPC_E,
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.QR_CODE,
      ]);

      const reader = new MultiFormatReader();
      reader.setHints(hints);

      return {
        reader,
        BinaryBitmap,
        HybridBinarizer,
        GlobalHistogramBinarizer,
        HTMLCanvasElementLuminanceSource,
      };
    });
  }
  return zxingModulePromise;
}

export function ScanView({ onNavigateToCart, onNavigateToShop }) {
  const [cameraActive, setCameraActive] = useState(false);
  const [isStarting, setIsStarting] = useState(false);
  const [scannerStatus, setScannerStatus] = useState('Camera idle');
  const [manualBarcode, setManualBarcode] = useState('');
  const [lastScanned, setLastScanned] = useState(null);
  const [unknownBarcode, setUnknownBarcode] = useState(null);
  const [errorMessage, setErrorMessage] = useState('');
  const [successNotice, setSuccessNotice] = useState('');
  const [scanFlash, setScanFlash] = useState(false);

  // Hardware controls
  const [availableCameras, setAvailableCameras] = useState([]);
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [torchSupported, setTorchSupported] = useState(false);
  const [torchOn, setTorchOn] = useState(false);

  // AI Vision fallback state
  const [isAiScanning, setIsAiScanning] = useState(false);
  const [aiSuggestion, setAiSuggestion] = useState(null);

  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const scanIntervalRef = useRef(null);
  const lastDetectedRef = useRef({ code: '', time: 0 });
  const consecutiveReadRef = useRef({ code: '', count: 0, time: 0 });
  const isMountedRef = useRef(true);

  useEffect(() => {
    isMountedRef.current = true;
    updateAvailableCameras();
    return () => {
      isMountedRef.current = false;
      stopCamera();
    };
  }, []);

  // Guaranteed synchronization between active camera stream and the video element
  useEffect(() => {
    if (cameraActive && streamRef.current && videoRef.current) {
      if (videoRef.current.srcObject !== streamRef.current) {
        videoRef.current.srcObject = streamRef.current;
      }
      videoRef.current.play().catch((e) => console.warn('[CAMERA] Play sync note:', e.message));
    }
  }, [cameraActive]);

  async function updateAvailableCameras() {
    if (!navigator?.mediaDevices?.enumerateDevices) return;
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoInputs = devices.filter((d) => d.kind === 'videoinput');
      if (isMountedRef.current && videoInputs.length > 0) {
        setAvailableCameras(videoInputs);
        if (!selectedCameraId && streamRef.current) {
          const track = streamRef.current.getVideoTracks()[0];
          const settings = track?.getSettings?.();
          if (settings?.deviceId) {
            setSelectedCameraId(settings.deviceId);
          }
        }
      }
    } catch (e) {}
  }

  async function startCamera(targetDeviceId = null) {
    if (isStarting) return;
    setIsStarting(true);
    setErrorMessage('');
    setUnknownBarcode(null);
    setAiSuggestion(null);
    setScannerStatus('Opening camera...');

    // Clean up any existing stream cleanly
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try { track.stop(); } catch (e) {}
      });
      streamRef.current = null;
    }

    try {
      if (!navigator?.mediaDevices?.getUserMedia) {
        throw new Error('Camera access not supported by browser. Please use manual entry.');
      }

      const isMobile = /Android|iPhone|iPad|iPod|Mobile/i.test(navigator?.userAgent || '');
      let stream = null;

      if (targetDeviceId) {
        // Explicitly selected device
        stream = await navigator.mediaDevices.getUserMedia({
          video: { deviceId: { exact: targetDeviceId } },
          audio: false,
        });
        setSelectedCameraId(targetDeviceId);
      } else if (isMobile) {
        // Mobile device: prioritize rear environment camera for barcodes
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              facingMode: { ideal: 'environment' },
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
        } catch (eMobile) {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
      } else {
        // Desktop / Laptop: use default webcam directly without environment facingMode constraint
        try {
          stream = await navigator.mediaDevices.getUserMedia({
            video: {
              width: { ideal: 1280 },
              height: { ideal: 720 },
            },
            audio: false,
          });
        } catch (eDesk) {
          stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        }
      }

      if (!isMountedRef.current) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      streamRef.current = stream;

      // Inspect hardware capabilities (torch, focus)
      const videoTrack = stream.getVideoTracks()[0];
      if (videoTrack?.getCapabilities) {
        const caps = videoTrack.getCapabilities();
        setTorchSupported(Boolean(caps.torch));

        const advanced = [];
        if (caps.focusMode && Array.isArray(caps.focusMode) && caps.focusMode.includes('continuous')) {
          advanced.push({ focusMode: 'continuous' });
        }
        if (advanced.length > 0) {
          try {
            await videoTrack.applyConstraints({ advanced });
          } catch (e) {}
        }
      } else {
        setTorchSupported(false);
      }
      setTorchOn(false);

      // Attach stream to permanently mounted video element
      const video = videoRef.current;
      if (video) {
        video.setAttribute('playsinline', 'true');
        video.setAttribute('autoplay', 'true');
        video.setAttribute('muted', 'true');
        video.playsInline = true;
        video.muted = true;
        video.srcObject = stream;

        video.onloadedmetadata = async () => {
          try {
            await video.play();
          } catch (e) {
            console.warn('[CAMERA] Auto-play gesture warning:', e.message);
          }
        };

        try {
          await video.play();
        } catch (playErr) {
          console.warn('[CAMERA] Auto-play waiting for user gesture:', playErr.message);
        }
      }

      setCameraActive(true);
      setIsStarting(false);
      setScannerStatus('Align barcode within reticle');
      updateAvailableCameras();
      beginDetectionLoop();
    } catch (err) {
      if (!isMountedRef.current) return;
      setIsStarting(false);
      setCameraActive(false);

      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setErrorMessage('Camera access was denied. Please allow camera permissions in your browser or enter barcodes manually.');
      } else if (err.name === 'NotFoundError' || err.name === 'DevicesNotFoundError') {
        setErrorMessage('No camera found on this device. Please use manual barcode entry.');
      } else {
        setErrorMessage(`Camera error: ${err.message || 'Unable to open camera'}. Use manual barcode entry.`);
      }
      setScannerStatus('Camera unavailable');
    }
  }

  function stopCamera() {
    if (scanIntervalRef.current) {
      clearInterval(scanIntervalRef.current);
      scanIntervalRef.current = null;
    }

    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => {
        try { track.stop(); } catch (e) {}
      });
      streamRef.current = null;
    }

    if (videoRef.current) {
      try { videoRef.current.pause(); } catch (e) {}
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
      console.warn('[CAMERA] Torch toggle error:', e.message);
    }
  }

  // Multi-tier detection loop with Reticle Cropping and Checksum Verification
  async function beginDetectionLoop() {
    let nativeDetector = null;
    if (typeof window.BarcodeDetector !== 'undefined') {
      try {
        nativeDetector = new window.BarcodeDetector({
          formats: ['ean_13', 'ean_8', 'upc_a', 'upc_e', 'code_128', 'code_39', 'qr_code'],
        });
      } catch (e) {
        nativeDetector = null;
      }
    }

    let zxingModule = null;
    try {
      zxingModule = await getZxingModule();
    } catch (e) {
      console.warn('[SCANNER] ZXing load note:', e.message);
    }

    // Dedicated offscreen canvas for centered reticle cropping (640x360)
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = 640;
    cropCanvas.height = 360;
    const cropCtx = cropCanvas.getContext('2d', { willReadFrequently: true });

    let isDecoding = false;
    scanIntervalRef.current = setInterval(async () => {
      const video = videoRef.current;
      if (!video || video.readyState < 2 || video.videoWidth === 0 || isDecoding) return;

      isDecoding = true;
      try {
        const vw = video.videoWidth;
        const vh = video.videoHeight;

        // Crop central 70% width and 50% height (matching the visual reticle)
        const cropW = Math.floor(vw * 0.70);
        const cropH = Math.floor(vh * 0.50);
        const cropX = Math.floor((vw - cropW) / 2);
        const cropY = Math.floor((vh - cropH) / 2);

        cropCtx.drawImage(video, cropX, cropY, cropW, cropH, 0, 0, 640, 360);

        let detectedCode = null;

        // Stage 1: Hardware-accelerated native detector on crop canvas
        if (nativeDetector) {
          try {
            const results = await nativeDetector.detect(cropCanvas);
            if (results && results.length > 0 && results[0].rawValue) {
              detectedCode = results[0].rawValue;
            }
          } catch (e) {}
        }

        // Stage 2: ZXing software decoder fallback with dual binarizers
        if (!detectedCode && zxingModule) {
          const { reader, BinaryBitmap, HybridBinarizer, GlobalHistogramBinarizer, HTMLCanvasElementLuminanceSource } = zxingModule;
          try {
            const lum = new HTMLCanvasElementLuminanceSource(cropCanvas);
            try {
              const res = reader.decodeWithState(new BinaryBitmap(new HybridBinarizer(lum)));
              if (res && res.getText()) detectedCode = res.getText();
            } catch (eNotFound1) {
              // Try GlobalHistogramBinarizer (superior for reflections & glossy labels)
              const res = reader.decodeWithState(new BinaryBitmap(new GlobalHistogramBinarizer(lum)));
              if (res && res.getText()) detectedCode = res.getText();
            }
          } catch (eZxing) {}
        }

        if (detectedCode) {
          handleDetectedBarcode(detectedCode);
        }
      } catch (err) {
        // Routine frame tick error
      } finally {
        isDecoding = false;
      }
    }, 160); // 160ms throttle (fast responsiveness without CPU thermal lag)
  }

  function handleDetectedBarcode(barcode) {
    if (!barcode) return;
    const cleanCode = barcode.trim();
    if (!cleanCode) return;

    // Step 1: EAN-13 / UPC-A Checksum Validation & Consecutive Read Guard
    const isEanUpc = /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(cleanCode);
    const hasValidChecksum = isEanUpc ? validateEanUpcChecksum(cleanCode) : true;
    const now = Date.now();

    // If barcode is non-checksummed (Code 128 / Code 39) OR has custom non-GS1 format,
    // require 2 consecutive matching reads within 400ms to eliminate optical noise.
    if (!hasValidChecksum || !isEanUpc) {
      const cr = consecutiveReadRef.current;
      if (cr.code === cleanCode && now - cr.time < 400) {
        cr.count += 1;
      } else {
        consecutiveReadRef.current = { code: cleanCode, count: 1, time: now };
        return; // Wait for consecutive confirmation read
      }
      if (consecutiveReadRef.current.count < 2) {
        return;
      }
    }

    // Step 2: 1.5s Cooldown Debounce for the exact same physical barcode
    const last = lastDetectedRef.current;
    if (last.code === cleanCode && now - last.time < 1500) {
      return;
    }

    lastDetectedRef.current = { code: cleanCode, time: now };

    // Step 3: POS Sensory Feedback
    playPosChime();
    triggerHaptic();
    setScanFlash(true);
    setTimeout(() => {
      if (isMountedRef.current) setScanFlash(false);
    }, 300);

    submitScan(cleanCode);
  }

  const submitScan = useCallback(async (barcode) => {
    if (!barcode || !barcode.trim()) return;
    const cleanCode = barcode.trim();
    setErrorMessage('');
    setUnknownBarcode(null);
    setAiSuggestion(null);
    setScannerStatus(`Adding ${cleanCode}...`);

    const scanId = generateUuid();

    try {
      const res = await api.scanBarcode({
        barcode: cleanCode,
        scanId,
        trolleyId: 'trolley-01',
      });

      if (!isMountedRef.current) return;

      setLastScanned({
        product: res.product,
        duplicate: res.duplicate,
        time: new Date().toLocaleTimeString(),
      });

      const productName = res.product?.name || cleanCode;
      const productPrice = Number(res.product?.price || 0).toFixed(2);
      setScannerStatus(`Item added: ${productName}`);
      setSuccessNotice(`Added ${productName} (₹${productPrice})`);
      setTimeout(() => {
        if (isMountedRef.current) setSuccessNotice('');
      }, 4000);
    } catch (err) {
      if (!isMountedRef.current) return;
      if (err.code === 'UNKNOWN_BARCODE') {
        setUnknownBarcode(cleanCode);
        setScannerStatus(`Barcode ${cleanCode} not found in catalog`);
      } else {
        setErrorMessage(err.message || 'Scan processing failed. Please check network connection.');
        setScannerStatus('Scan failed');
      }
    }
  }, []);

  // Gemini Multimodal AI Vision Fallback: captures a high-resolution snapshot of the package
  async function handleAiVisionScan() {
    const video = videoRef.current;
    if (!video || !cameraActive) {
      setErrorMessage('Please turn on the camera before using AI Vision scan.');
      return;
    }

    setIsAiScanning(true);
    setErrorMessage('');
    setUnknownBarcode(null);
    setAiSuggestion(null);
    setScannerStatus('Analyzing package with Gemini AI...');

    try {
      const snapCanvas = document.createElement('canvas');
      const vw = video.videoWidth || 640;
      const vh = video.videoHeight || 480;

      const maxDim = 1024;
      const scale = Math.min(1, maxDim / Math.max(vw, vh));
      snapCanvas.width = Math.floor(vw * scale);
      snapCanvas.height = Math.floor(vh * scale);

      const ctx = snapCanvas.getContext('2d');
      ctx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);

      const imageBase64 = snapCanvas.toDataURL('image/jpeg', 0.85);

      const res = await api.geminiVisionScan({
        imageBase64,
        trolleyId: 'trolley-01',
      });

      if (!isMountedRef.current) return;

      if (!res.identified) {
        setErrorMessage('Gemini could not clearly identify the product or barcode. Try holding it closer and clearer.');
        setScannerStatus('AI Vision: No match found');
        return;
      }

      // If high confidence and matched in our DB, auto-add to cart
      if (!res.requiresConfirmation && res.matchedProduct) {
        playPosChime();
        triggerHaptic();
        setScanFlash(true);
        setTimeout(() => setScanFlash(false), 300);
        await submitScan(res.matchedProduct.barcode);
      } else {
        // Present suggestion for customer confirmation
        setAiSuggestion(res.suggestion);
        setScannerStatus(`AI detected: ${res.suggestion?.name || 'Item'} (Confidence: ${(res.confidence * 100).toFixed(0)}%)`);
      }
    } catch (err) {
      if (!isMountedRef.current) return;
      setErrorMessage(err.message || 'AI Vision scan request failed. Please enter the barcode manually.');
      setScannerStatus('AI Vision failed');
    } finally {
      if (isMountedRef.current) {
        setIsAiScanning(false);
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
          Position barcode within the reticle for instant POS detection or scan package with AI
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

      {/* Unknown Barcode Banner with Direct Actions */}
      {unknownBarcode && (
        <div className="toast-banner toast-warning" style={{ flexDirection: 'column', alignItems: 'flex-start', gap: '8px' }}>
          <div>
            <strong>Barcode not in catalog:</strong> {unknownBarcode}
          </div>
          <p style={{ fontSize: '0.82rem', color: 'var(--accent-dark)' }}>
            This item does not exist in the store catalog yet.
          </p>
          <div style={{ display: 'flex', gap: '8px', marginTop: '4px', flexWrap: 'wrap' }}>
            <button className="btn btn-sm btn-primary" onClick={onNavigateToShop}>
              <Plus size={13} /> Add to Catalog
            </button>
            <button className="btn btn-sm" onClick={handleAiVisionScan} disabled={isAiScanning || !cameraActive}>
              <Sparkles size={13} /> Identify with AI
            </button>
            <button className="btn btn-sm" onClick={() => setUnknownBarcode(null)}>
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Gemini AI Identification Suggestion Confirmation Card */}
      {aiSuggestion && (
        <div className="card" style={{ borderColor: 'var(--primary)', backgroundColor: 'var(--primary-soft)', marginBottom: '16px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: '12px' }}>
            <div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '0.78rem', color: 'var(--primary-dark)', fontWeight: 700 }}>
                <Sparkles size={14} /> GEMINI AI VISION SUGGESTION
              </div>
              <div style={{ fontSize: '1.1rem', fontWeight: 700, marginTop: '4px' }}>
                {aiSuggestion.name || 'Identified Product'}
              </div>
              <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
                {aiSuggestion.barcode ? `Barcode: ${aiSuggestion.barcode} · ` : ''}{aiSuggestion.category}
              </div>
            </div>

            <div style={{ display: 'flex', gap: '8px' }}>
              {aiSuggestion.barcode ? (
                <button
                  className="btn btn-sm btn-primary"
                  onClick={() => {
                    const code = aiSuggestion.barcode;
                    setAiSuggestion(null);
                    submitScan(code);
                  }}
                >
                  Confirm & Add to Cart
                </button>
              ) : (
                <button className="btn btn-sm btn-primary" onClick={onNavigateToShop}>
                  <Plus size={13} /> Add to Catalog
                </button>
              )}
              <button className="btn btn-sm" onClick={() => setAiSuggestion(null)}>
                Dismiss
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Camera Viewport Section */}
      <div className="card" style={{ padding: '0', overflow: 'hidden', position: 'relative' }}>
        <div style={{
          backgroundColor: '#0F172A',
          height: 'min(55vh, 400px)',
          minHeight: '280px',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          position: 'relative',
          overflow: 'hidden',
          borderRadius: 'var(--radius)',
        }}>
          {/* Always mounted video element guaranteeing non-null ref and instant stream attachment */}
          <video
            ref={videoRef}
            playsInline
            muted
            autoPlay
            onLoadedMetadata={(e) => {
              try { e.target.play(); } catch (err) {}
            }}
            style={{
              position: 'absolute',
              top: 0,
              left: 0,
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              opacity: cameraActive ? 1 : 0,
              pointerEvents: cameraActive ? 'auto' : 'none',
              zIndex: 1,
              transition: 'opacity 0.2s ease',
            }}
          />

          {cameraActive ? (
            /* Centered High-Precision Targeting Reticle */
            <div style={{
              position: 'relative',
              width: '74%',
              maxWidth: '380px',
              height: '170px',
              border: scanFlash ? '3px solid var(--success)' : '2px dashed rgba(56, 189, 248, 0.75)',
              borderRadius: '12px',
              boxShadow: scanFlash
                ? '0 0 24px var(--success), 0 0 0 9999px rgba(15, 23, 42, 0.55)'
                : '0 0 0 9999px rgba(15, 23, 42, 0.50)',
              pointerEvents: 'none',
              zIndex: 2,
              transition: 'border-color 0.15s ease, box-shadow 0.15s ease',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}>
              {/* 4 Corner Markers */}
              <div style={{ position: 'absolute', top: '-2px', left: '-2px', width: '22px', height: '22px', borderTop: '3px solid #38BDF8', borderLeft: '3px solid #38BDF8', borderTopLeftRadius: '12px' }} />
              <div style={{ position: 'absolute', top: '-2px', right: '-2px', width: '22px', height: '22px', borderTop: '3px solid #38BDF8', borderRight: '3px solid #38BDF8', borderTopRightRadius: '12px' }} />
              <div style={{ position: 'absolute', bottom: '-2px', left: '-2px', width: '22px', height: '22px', borderBottom: '3px solid #38BDF8', borderLeft: '3px solid #38BDF8', borderBottomLeftRadius: '12px' }} />
              <div style={{ position: 'absolute', bottom: '-2px', right: '-2px', width: '22px', height: '22px', borderBottom: '3px solid #38BDF8', borderRight: '3px solid #38BDF8', borderBottomRightRadius: '12px' }} />

              {/* Center Aiming Guide Line */}
              <div style={{
                width: '85%',
                height: '2px',
                backgroundColor: scanFlash ? 'var(--success)' : 'var(--primary)',
                boxShadow: '0 0 8px var(--primary)',
                opacity: 0.9,
              }} />
            </div>
          ) : (
            <div style={{ textAlign: 'center', color: '#94A3B8', padding: '24px', zIndex: 2 }}>
              <Camera size={44} style={{ marginBottom: '10px', opacity: 0.6 }} />
              <div style={{ fontSize: '0.95rem', fontWeight: 600 }}>Camera is currently off</div>
              <p style={{ fontSize: '0.8rem', marginTop: '4px', maxWidth: '320px', margin: '4px auto 0' }}>
                Tap Start Camera to begin rapid POS barcode scanning with optical checksum verification
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
          gap: '10px',
        }}>
          <div style={{ fontSize: '0.82rem', color: 'var(--text-muted)' }}>
            Status: <span style={{ fontWeight: 600, color: 'var(--text)' }}>{scannerStatus}</span>
          </div>

          <div style={{ display: 'flex', gap: '8px', alignItems: 'center', flexWrap: 'wrap' }}>
            {/* Camera Select Dropdown (if multiple cameras detected) */}
            {cameraActive && availableCameras.length > 1 && (
              <div style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
                <select
                  className="input"
                  style={{ maxWidth: '170px', padding: '3px 6px', fontSize: '0.78rem', height: '28px' }}
                  value={selectedCameraId}
                  onChange={(e) => {
                    const devId = e.target.value;
                    setSelectedCameraId(devId);
                    startCamera(devId);
                  }}
                  title="Select video input device"
                >
                  {availableCameras.map((cam, idx) => (
                    <option key={cam.deviceId || idx} value={cam.deviceId}>
                      {cam.label || `Camera ${idx + 1}`}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {/* Torch toggle button (visible if supported) */}
            {cameraActive && torchSupported && (
              <button
                className={`btn btn-sm ${torchOn ? 'btn-primary' : ''}`}
                onClick={handleToggleTorch}
                title="Toggle Torch / Flashlight"
              >
                {torchOn ? <ZapOff size={14} /> : <Zap size={14} />}
                {torchOn ? 'Torch Off' : 'Torch On'}
              </button>
            )}

            {/* Gemini AI Vision Fallback Scan Button */}
            {cameraActive && (
              <button
                className="btn btn-sm"
                onClick={handleAiVisionScan}
                disabled={isAiScanning}
                title="Identify damaged or curved packaging using Gemini Flash Vision"
              >
                {isAiScanning ? <RefreshCw size={14} className="spin" /> : <Sparkles size={14} />}
                {isAiScanning ? 'Analyzing...' : 'AI Vision Scan'}
              </button>
            )}

            {cameraActive ? (
              <button className="btn btn-sm btn-danger" onClick={stopCamera}>
                <CameraOff size={14} /> Stop Camera
              </button>
            ) : (
              <button className="btn btn-sm btn-primary" onClick={() => startCamera()} disabled={isStarting}>
                <Camera size={14} /> {isStarting ? 'Starting...' : 'Start Camera'}
              </button>
            )}
          </div>
        </div>

        {cameraActive && (
          <div style={{ padding: '6px 16px 10px', fontSize: '0.75rem', color: 'var(--text-muted)', borderTop: '1px dashed var(--border)', backgroundColor: 'var(--surface)' }}>
            💡 Tip: If camera preview is black, check that your laptop's physical webcam privacy slider is slid open, or select your camera from the dropdown above.
          </div>
        )}
      </div>

      {/* Manual Barcode Entry Card */}
      <div className="card">
        <h3 className="card-title" style={{ marginBottom: '10px' }}>Manual Barcode Entry</h3>
        <p style={{ fontSize: '0.82rem', color: 'var(--text-muted)', marginBottom: '12px' }}>
          Type or copy any barcode number directly without using the camera
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
