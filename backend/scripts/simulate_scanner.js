import readline from 'readline';
import { scanner } from '../src/system.js';
import { SAMPLE_PRODUCTS } from './seed.js';

console.log('====================================================');
console.log('       AVCOE BARCODE SCANNER HARDWARE SIMULATOR     ');
console.log('====================================================');
console.log('Available Demo Barcodes:');
SAMPLE_PRODUCTS.forEach((p, idx) => {
  console.log(`  [${idx + 1}] ${p.barcode.padEnd(14)} - ${p.name} (Stock: ${p.stock}, ₹${p.price})`);
});
console.log('  [U]  8909999999998  - Unregistered unknown barcode');
console.log('  [I]  123456789012   - Invalid checksum barcode');
console.log('  [B]  Burst Mode     - Simulate 15ms hardware wedge burst vs human typing');
console.log('  [Q]  Quit\n');

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

function prompt() {
  rl.question('Scan> Select option (1-9, U, I, B) or enter raw barcode: ', async (answer) => {
    const trimmed = answer.trim();
    if (trimmed.toLowerCase() === 'q') {
      console.log('Exiting simulator.');
      process.exit(0);
    }

    if (trimmed === 'B' || trimmed === 'b') {
      await simulateBurstWedge();
      prompt();
      return;
    }

    let barcodeToScan = trimmed;
    const num = parseInt(trimmed, 10);
    if (!isNaN(num) && num >= 1 && num <= SAMPLE_PRODUCTS.length) {
      barcodeToScan = SAMPLE_PRODUCTS[num - 1].barcode;
    } else if (trimmed.toUpperCase() === 'U') {
      barcodeToScan = '8909999999998'; // Not in catalog
    } else if (trimmed.toUpperCase() === 'I') {
      barcodeToScan = '123456789012'; // Invalid checksum
    }

    console.log(`\n[SIMULATOR] Triggering scan for barcode: ${barcodeToScan}...`);
    scanner.processBarcode(barcodeToScan);
    setTimeout(prompt, 600);
  });
}

// Simulates real USB HID keyboard wedge sending keystrokes with 15ms delays
async function simulateBurstWedge() {
  const code = '8901030383700\r';
  console.log('\n[BURST TEST 1] Fast scanner burst (15ms per char)...');
  for (const char of code) {
    scanner.feedKeystroke(char);
    await new Promise((r) => setTimeout(r, 15));
  }

  console.log('[BURST TEST 2] Slow human typing (120ms per char - should be rejected)...');
  const humanCode = '8901030383709\r';
  for (const char of humanCode) {
    scanner.feedKeystroke(char);
    await new Promise((r) => setTimeout(r, 120));
  }
}

prompt();
