import { EventEmitter } from 'events';
import { v4 as uuidv4 } from 'uuid';

/**
 * Validates Modulo-10 checksum for EAN-13, EAN-8, and UPC-A barcodes.
 * @param {string} barcode
 * @returns {boolean}
 */
export function validateEanUpcChecksum(barcode) {
  if (!barcode || typeof barcode !== 'string') return false;
  const digits = barcode.trim();
  if (!/^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(digits)) {
    return false;
  }

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

/**
 * Trims control characters, spaces, and normalizes barcodes.
 * @param {string} raw
 * @returns {string}
 */
export function normalizeBarcode(raw) {
  if (typeof raw !== 'string') return '';
  // Remove ASCII control characters (0x00-0x1F, 0x7F) and whitespace
  return raw.replace(/[\x00-\x1F\x7F]/g, '').trim();
}

/**
 * Detects probable barcode symbology.
 * @param {string} code
 * @returns {string}
 */
export function detectBarcodeFormat(code) {
  if (!code) return 'UNKNOWN';
  if (/^\d{8}$/.test(code)) return 'EAN-8';
  if (/^\d{12}$/.test(code)) return 'UPC-A';
  if (/^\d{13}$/.test(code)) return 'EAN-13';
  if (/^\d{14}$/.test(code)) return 'ITF-14';
  if (/^([A-Z0-9\-\.\ \$\/\+\%]{1,})$/.test(code)) return 'CODE-39';
  if (/^[\x20-\x7E]{1,}$/.test(code)) return 'CODE-128';
  return 'GENERIC';
}

/**
 * BarcodeScanner: Non-blocking scanner core supporting keyboard-wedge buffers,
 * checksum validation, debounce windows, and sequential UUID tracking.
 */
export class BarcodeScanner extends EventEmitter {
  constructor(options = {}) {
    super();
    this.deviceId = options.deviceId || 'trolley-01';
    this.debounceMs = options.debounceMs ?? 1500;
    this.wedgeTimingThresholdMs = options.wedgeTimingThresholdMs ?? 50;

    // Keystroke wedge buffer state
    this.wedgeBuffer = '';
    this.lastKeystrokeTime = 0;
    this.isHumanTyping = false;

    // Debounce state: barcode -> lastTimestamp
    this.lastScans = new Map();

    // Monotonic sequence counter
    this.sequence = 0;
  }

  /**
   * Feed raw character from keyboard wedge (e.g. stdin keypress event).
   * Verifies timing threshold (<50ms) to reject slow human keyboard entry.
   * @param {string} char
   * @param {number} [now]
   * @returns {object|null} scan event if Enter was encountered and accepted
   */
  feedKeystroke(char, now = Date.now()) {
    if (!char) return null;

    // Check terminator
    if (char === '\r' || char === '\n' || char === '\x03') {
      const buffered = this.wedgeBuffer;
      const isHuman = this.isHumanTyping;
      this.wedgeBuffer = '';
      this.lastKeystrokeTime = 0;
      this.isHumanTyping = false;

      if (!buffered) return null;

      if (isHuman) {
        this.emit('invalid_scan', {
          raw: buffered,
          reason: `Keystroke timing exceeded threshold (${this.wedgeTimingThresholdMs}ms). Human typing rejected.`,
          timestamp: new Date(now).toISOString(),
        });
        return null;
      }

      return this.processBarcode(buffered, now);
    }

    // Inter-keystroke timing analysis
    if (this.wedgeBuffer.length > 0) {
      const elapsed = now - this.lastKeystrokeTime;
      if (elapsed > this.wedgeTimingThresholdMs) {
        this.isHumanTyping = true;
      }
    }

    this.wedgeBuffer += char;
    this.lastKeystrokeTime = now;
    return null;
  }

  /**
   * Process a complete barcode string directly (from camera, serial port, or wedge buffer).
   * @param {string} rawBarcode
   * @param {number} [now]
   * @returns {object|null}
   */
  processBarcode(rawBarcode, now = Date.now()) {
    const clean = normalizeBarcode(rawBarcode);
    if (!clean) {
      this.emit('invalid_scan', {
        raw: rawBarcode,
        reason: 'Empty barcode read',
        timestamp: new Date(now).toISOString(),
      });
      return null;
    }

    // Checksum validation for standard GS1 numeric barcodes
    const isNumericStandard = /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/.test(clean);
    if (isNumericStandard && !validateEanUpcChecksum(clean)) {
      this.emit('invalid_scan', {
        raw: clean,
        reason: 'Checksum validation failed (Modulo-10 check digit mismatch)',
        timestamp: new Date(now).toISOString(),
      });
      return null;
    }

    // Debounce sliding window
    const lastTime = this.lastScans.get(clean) || 0;
    const diff = now - lastTime;
    if (diff < this.debounceMs) {
      this.emit('debounced', {
        barcode: clean,
        lastScanTime: lastTime,
        timeDiffMs: diff,
        debounceThresholdMs: this.debounceMs,
      });
      return null;
    }

    // Accept scan
    this.lastScans.set(clean, now);
    this.sequence += 1;

    // Prune stale debounce map entries
    if (this.lastScans.size > 200) {
      for (const [code, time] of this.lastScans.entries()) {
        if (now - time > this.debounceMs * 3) {
          this.lastScans.delete(code);
        }
      }
    }

    const format = detectBarcodeFormat(clean);
    const scanEvent = {
      scan_id: uuidv4(),
      barcode: clean,
      format,
      timestamp: new Date(now).toISOString(),
      device_id: this.deviceId,
      seq: this.sequence,
    };

    this.emit('scan', scanEvent);
    return scanEvent;
  }

  /**
   * Clear state & debounce cache
   */
  reset() {
    this.wedgeBuffer = '';
    this.lastKeystrokeTime = 0;
    this.isHumanTyping = false;
    this.lastScans.clear();
  }
}

