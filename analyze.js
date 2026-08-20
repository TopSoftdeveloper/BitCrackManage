// analyze.js — Test the "almost-constant ratio" hypothesis for the Bitcoin puzzle keys
// and, if it holds, derive a narrowed search window for puzzles 71-74.
//
// The Bitcoin puzzle creator placed each private key inside [2^(bits-1), 2^bits).
// If there is a consistent relationship between solved keys (e.g. ratio between
// consecutive keys, or position-within-range), we can shrink the search space.
//
// Usage: node analyze.js

const SOLVED = [
  // [puzzleNo, bits, keyHex]
  [1, 1, '1'],
  [2, 2, '3'],
  [3, 3, '7'],
  [4, 4, '8'],
  [5, 5, '15'],
  [6, 6, '31'],
  [7, 7, '4c'],
  [8, 8, 'e0'],
  [9, 9, '1d3'],
  [10, 10, '202'],
  [11, 11, '483'],
  [12, 12, 'a7b'],
  [13, 13, '1460'],
  [14, 14, '2930'],
  [15, 15, '68f3'],
  [16, 16, 'c936'],
  [17, 17, '1764f'],
  [18, 18, '3080d'],
  [19, 19, '5749f'],
  [20, 20, 'd2c55'],
  [21, 21, '1ba534'],
  [22, 22, '2de40f'],
  [23, 23, '556e52'],
  [24, 24, 'dc2a04'],
  [25, 25, '1fa5ee5'],
  [26, 26, '340326e'],
  [27, 27, '6ac3875'],
  [28, 28, 'd916ce8'],
  [29, 29, '17e2551e'],
  [30, 30, '3d94cd64'],
  [31, 31, '7d4fe747'],
  [32, 32, 'b862a62e'],
  [33, 33, '1a96ca8d8'],
  [34, 34, '34a65911d'],
  [35, 35, '4aed21170'],
  [36, 36, '9de820a7c'],
  [37, 37, '1757756a93'],
  [38, 38, '22382facd0'],
  [39, 39, '4b5f8303e9'],
  [40, 40, 'e9ae4933d6'],
  [41, 41, '153869acc5b'],
  [42, 42, '2a221c58d8f'],
  [43, 43, '6bd3b27c591'],
  [44, 44, 'e02b35a358f'],
  [45, 45, '122fca143c05'],
  [46, 46, '2ec18388d544'],
  [47, 47, '6cd610b53cba'],
  [48, 48, 'ade6d7ce3b9b'],
  [49, 49, '174176b015f4d'],
  [50, 50, '22bd43c2e9354'],
  [51, 51, '75070a1a009d4'],
  [52, 52, 'efae164cb9e3c'],
  [53, 53, '180788e47e326c'],
  [54, 54, '236fb6d5ad1f43'],
  [55, 55, '6abe1f9b67e114'],
  [56, 56, '9d18b63ac4ffdf'],
  [57, 57, '1eb25c90795d61c'],
  [58, 58, '2c675b852189a21'],
  [59, 59, '7496cbb87cab44f'],
  [60, 60, 'fc07a1825367bbe'],
  [61, 61, '13c96a3742f64906'],
  [62, 62, '363d541eb611abee'],
  [63, 63, '7cce5efdaccf6808'],
  [64, 64, 'f7051f27b09112d4'],
  [65, 65, '1a838b13505b26867'],
  [66, 66, '2832ed74f2b5e35ee'],
  [67, 67, '730fc235c1942c1ae'],
  [68, 68, 'bebb3940cd0fc1491'],
  [69, 69, '101d83275fb2bc7e0c'],
  [70, 70, '349b84b6431a6c4ef1'],
  [75, 75, '4c5ce114686a1336e07'],
  [80, 80, 'ea1a5c66dcc11b5ad180'],
  [85, 85, '11720c4f018d51b8cebba8'],
  [90, 90, '2ce00bb2136a445c71e85bf'],
  [95, 95, '527a792b183c7f64a0e8b1f4'],
  [100, 100, 'af55fc59c335c8ec67ed24826'],
  [105, 105, '16f14fc2054cd87ee6396b33df3'],
  [110, 110, '35c0d7234df7deb0f20cf7062444'],
  [115, 115, '60f4d11574f5deee49961d9609ac6'],
  [120, 120, 'b10f22572c497a836ea187f2e1fc23'],
  [125, 125, '1c533b6bb7f0804e09960225e44877ac'],
  [130, 130, '33e7665705359f04f28b88cf897c603c9'],
];

const rows = SOLVED.map(([no, bits, hex]) => {
  const key = BigInt('0x' + hex);
  const start = 1n << BigInt(bits - 1); // 2^(bits-1)
  const end = (1n << BigInt(bits)) - 1n; // 2^bits - 1
  const span = end - start + 1n;
  // fraction of the way through the range, 0.0 (at start) .. 1.0 (at end)
  // note: full-range fraction key/2^bits also reported
  const fracRange = Number((key - start)) / Number(span);
  const fracTotal = Number(key) / Number(1n << BigInt(bits));
  return { no, bits, key, start, fracRange, fracTotal };
});

console.log('=== Position of each solved key inside its own bit range ===');
console.log('puzzle  bits   fracInRange(0=start,1=end)  fracOfFull(0..1)  top-bits(key/2^(bits-1))');
for (const r of rows) {
  const topBits = (r.key / r.start).toString();
  console.log(
    `${String(r.no).padStart(6)} ${String(r.bits).padStart(4)}   ` +
    `${r.fracRange.toFixed(6).padStart(10)}          ${r.fracTotal.toFixed(6).padStart(10)}   ${topBits}`
  );
}

console.log('\n=== Consecutive ratio key[n+1]/key[n] ===');
for (let i = 1; i < rows.length; i++) {
  const ratio = Number(rows[i].key) / Number(rows[i - 1].key);
  const step = rows[i].bits - rows[i - 1].bits;
  console.log(
    `key${String(rows[i - 1].no).padStart(3)} -> key${String(rows[i].no).padStart(3)} ` +
    `(step ${step}) ratio=${ratio.toFixed(4)}`
  );
}

// -------- Focus on the 5-step series 70,75,80,85,90,95,100,105,110,115,120,125,130 --------
console.log('\n=== The 5-step series (70,75,80,...,130) — "7.0, 7.5, 8.0, 8.5, ..." ===');
const five = rows.filter((r) => r.bits >= 70 && r.bits % 5 === 0);
for (let i = 1; i < five.length; i++) {
  const prev = five[i - 1];
  const cur = five[i];
  const ratio = Number(cur.key) / Number(prev.key);
  console.log(
    `key${String(prev.no).padStart(3)} -> key${String(cur.no).padStart(3)} ` +
    `ratio=${ratio.toFixed(4)}  fracInRange: ${prev.fracRange.toFixed(4)} -> ${cur.fracRange.toFixed(4)}`
  );
}

console.log('\n=== Prediction for puzzles 71-74 using the median 5-step ratio ===');
// Compute median ratio of the 5-step series
const ratios = [];
for (let i = 1; i < five.length; i++) {
  ratios.push(Number(five[i].key) / Number(five[i - 1].key));
}
ratios.sort((a, b) => a - b);
const medianRatio = ratios[Math.floor(ratios.length / 2)];
console.log(`Median ratio between consecutive 5-step keys: ${medianRatio.toFixed(6)}`);

// If the keys are generated by an LCG-like recurrence k[n] = C * k[n-1] mod 2^160
// (or the relationship is: each key is ~ratio * previous), then for puzzles 71-74
// (between key70 and key75) we can interpolate.
const k70 = rows.find((r) => r.no === 70).key;
const k75 = rows.find((r) => r.no === 75).key;
console.log(`key70 = ${k70.toString(16)}`);
console.log(`key75 = ${k75.toString(16)}`);

// ---- Interpolation: assume geometric growth k[p] = k70 * (k75/k70)^((p-70)/5) ----
console.log('\nGeometric interpolation from key70 toward key75:');
const ratio5 = Number(k75) / Number(k70);
console.log(`k75/k70 = ${ratio5.toFixed(6)}`);
for (let p = 71; p <= 74; p++) {
  const exp = (p - 70) / 5;
  const pred = Number(k70) * Math.pow(ratio5, exp);
  const predInt = BigInt(Math.floor(pred));
  const start = 1n << BigInt(p - 1);
  const frac = Number(predInt - start) / Number((1n << BigInt(p)) - start);
  console.log(
    `puzzle ${p}: predicted ~0x${predInt.toString(16)}  fracInRange=${frac.toFixed(4)}`
  );
}

// ---- Also: pure LCG guess k[n+5] = a * k[n] + b (fit from 70,75,80) ----
console.log('\nLCG fit (k[n+5] = a*k[n] + b) from pairs (70,75,80),(75,80,85),... :');
for (let i = 0; i + 2 < five.length; i++) {
  const x0 = five[i].key, x1 = five[i + 1].key, x2 = five[i + 2].key;
  // x1 = a*x0 + b, x2 = a*x1 + b  =>  x2 - x1 = a*(x1 - x0)
  const dx1 = x1 - x0, dx2 = x2 - x1;
  if (dx1 === 0n) continue;
  // a = dx2 / dx1 as a rational approximation
  const aApprox = Number(dx2) / Number(dx1);
  console.log(
    `from key${String(five[i].no).padStart(3)},${String(five[i + 1].no).padStart(3)},${String(five[i + 2].no).padStart(3)} ` +
    `a=${aApprox.toFixed(6)}`
  );
}

// ---- Summary for the target range ----
console.log('\n=== Target: puzzles 71-74 ===');
const spanInfo = (p) => {
  const start = 1n << BigInt(p - 1);
  const end = (1n << BigInt(p)) - 1n;
  return { start, end, size: end - start + 1n };
};
for (let p = 71; p <= 74; p++) {
  const s = spanInfo(p);
  console.log(`puzzle ${p}: full range [2^${p - 1}, 2^${p}) = 0x${s.start.toString(16)} .. 0x${s.end.toString(16)} (${s.size} keys)`);
}

// ---- Focus bands: point predictions +/- halfWidth of the puzzle range ----
// These are the "gamble" bands you can opt into with SEARCH_MODE='focus'.
// halfWidth is a fraction of the puzzle's own span; e.g. 0.25 covers the
// predicted point +/- 25% of the whole range (a 50% wide window).
console.log('\n=== Focus bands (experimental gamble) for puzzles 71-74 ===');
const PRED_FRAC = { 71: 0.5419, 72: 0.4462, 73: 0.3564, 74: 0.2722 };
const HALF_WIDTH = 0.25; // 25% of the range on each side of the prediction
for (let p = 71; p <= 74; p++) {
  const start = 1n << BigInt(p - 1);
  const end = (1n << BigInt(p)) - 1n;
  const span = end - start + 1n;
  const center = start + BigInt(Math.floor(PRED_FRAC[p] * Number(span)));
  const lo = center - BigInt(Math.floor(HALF_WIDTH * Number(span)));
  const hi = center + BigInt(Math.floor(HALF_WIDTH * Number(span)));
  const clampedLo = lo < start ? start : lo;
  const clampedHi = hi > end ? end : hi;
  const fracLo = Number(clampedLo - start) / Number(span);
  const fracHi = Number(clampedHi - start) / Number(span);
  console.log(
    `puzzle ${p}: band = [0x${clampedLo.toString(16)}, 0x${clampedHi.toString(16)}]  ` +
    `fracInRange ${fracLo.toFixed(4)}..${fracHi.toFixed(4)}  ` +
    `covers ${(100 * (Number(clampedHi - clampedLo) + 1) / Number(span)).toFixed(1)}% of range`
  );
}
