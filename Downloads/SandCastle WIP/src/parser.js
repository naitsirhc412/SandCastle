/**
 * FinancialOS Revenue Parser — v8
 *
 * ANCHOR-FIRST PHILOSOPHY (user-requested):
 *   1. Find "Gross Revenue", "Net Revenue", "Net Sales" etc. — these are the ground-truth total
 *   2. Category rows (Food, Alcohol, "Food Sales", etc.) are a BREAKDOWN to check against it
 *   3. Payment rows (Cash, Card) are an independent verification
 *   4. If breakdown and anchor disagree >10%: flag conflict, give user 3 choices
 *
 * KEY SUMMARY-ROW FIX:
 *   "Food Sales", "Alcohol Sales", "Bar Revenue" = PRODUCT CATEGORIES (revenue by product type)
 *   "Net Sales", "Gross Revenue", "Total" = SUMMARY ANCHORS (total of everything)
 *   Rule: summary word as PREFIX or ALONE = anchor. As SUFFIX = just a category qualifier.
 *
 * CONFLICT OPTIONS (returned in preview.revenueConflict):
 *   anchor     — use the stated total row (safest, default when conflict)
 *   categories — use the category breakdown sum (better breakdown if data is clean)
 *   average    — average of anchor and category sum (flagged for manual review)
 */
'use strict';

// ── Taxonomy ──────────────────────────────────────────────────────────────────
// Canonicalize category labels at parse time so every downstream consumer
// (calculations.js, db.js, charts) sees consistent names regardless of POS
// or expense CSV format.
const { canonicalizeCategory } = require('./taxonomy');

// ─── Number cleaner ───────────────────────────────────────────────────────────
function toNum(v) {
  if (v == null) return 0;
  const raw = String(v).trim();
  // Percentage values (e.g. "8.9%", "40.1%", "3.3% (non-F&B)") are NOT money — return 0.
  // Match: optional sign, digits, optional decimal, %, then anything (notes, labels, parens).
  if (/^-?\d+\.?\d*\s*%/.test(raw)) return 0;
  const s = raw.replace(/[$,\s]/g, '').replace(/\(([^)]+)\)/, '-$1');
  const n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

// ─── DEDUCTION / TAX ──────────────────────────────────────────────────────────
const DEDUCTION_WORDS = new Set([
  'tax','taxes','sales tax','tax collected','tax liability',
  'discount','discounts','discount amount',
  'refund','refunds','void','voids','comp','comps','comped',
  'promo','promotion','coupon','coupons',
  'employee discount','manager comp','waste','spillage',
  'tip','tips','gratuity','gratuities',
  'electronic tip','electronic tips','charged tip','charged tips',
  'cash tip','cash tips','service charge','service fee',
]);
const DEDUCTION_PATTERNS = [/\btax\b/i, /\bdiscount\b/i, /\brefund\b/i, /\bvoid\b/i, /\bcomp\b/i, /\btip[s]?\b/i, /\bgratuity\b/i];

function isDeduction(cat) {
  const low = (cat || '').toLowerCase().trim();
  if (DEDUCTION_WORDS.has(low)) return true;
  if (low.split(/[\s,\-\/&+]+/).some(p => DEDUCTION_WORDS.has(p))) return true;
  return DEDUCTION_PATTERNS.some(p => p.test(low));
}

// ─── PAYMENT METHOD ───────────────────────────────────────────────────────────
const PAYMENT_WORDS = new Set([
  'cash','credit card','credit','debit card','debit',
  'visa','mastercard','amex','american express','discover',
  'gift card','gift certificate','store credit','house account',
  'check','cheque','card','card payment','card not present',
  'contactless','tap','nfc',
  'third party','doordash','uber eats','grubhub','postmates',
  'caviar','square','stripe','paypal','venmo','toast',
  'online payment','manual card','other payment','other tender',
  'tender','tenders','total tender','cash tip','charged tip',
  'coin','coins',
]);
const PAYMENT_PATTERNS = [/\bcard\b/i, /\btender\b/i, /^cash\b/i, /\bpayment\b/i, /^(visa|mc|amex)\b/i];

function isPaymentMethod(cat) {
  const low = (cat || '').toLowerCase().trim();
  if (PAYMENT_WORDS.has(low)) return true;
  if (low.split(/[\s,\-\/&+]+/).some(p => PAYMENT_WORDS.has(p))) return true;
  return PAYMENT_PATTERNS.some(p => p.test(low));
}

// ─── SUMMARY / ANCHOR DETECTION ───────────────────────────────────────────────
//
// CORRECT:  "Net Sales"       → starts with "net"    → anchor
//           "Gross Revenue"   → starts with "gross"  → anchor
//           "Total Food"      → starts with "total"  → anchor (it's a subtotal)
//           "Revenue"         → exactly "revenue"    → anchor
//
// CORRECT:  "Food Sales"      → "sales" is a SUFFIX  → NOT anchor, it's a product category
//           "Alcohol Revenue" → "revenue" is SUFFIX  → NOT anchor, it's a product category
//           "Bar Revenue"     → "revenue" is SUFFIX  → NOT anchor
//
// The key: summary word at the START or ALONE = anchor.
//          summary word at the END after a product noun = product category.

const SUMMARY_PREFIXES = [
  'gross', 'net', 'total', 'grand', 'subtotal', 'sub-total',
  'overall', 'aggregate', 'combined', 'cumulative', 'summary',
  'ventes', 'ventas', 'gesamt', 'netto',  // multilingual (common in US restaurant POS)
];
const SUMMARY_ALONE = new Set([
  'gross','net','total','revenue','sales','income','receipts',
  'grand total','net total','total net','overall total',
  'subtotal','sub-total','net amount','gross amount',
  'total amount','total sales','total revenue',
  'gross sales','net sales','gross revenue','net revenue',
  'revenue total','sales total','period total','daily total',

  // Common multilingual summary labels found in US restaurant POS software
  'ventes nettes','ventes totales','total des ventes',          // French (TouchBistro Canada)
  'ventas netas','ventas totales','total neto','total ventas',  // Spanish (Clover/Square Latin markets)
  'gesamtumsatz','nettoumsatz',                                 // German (Micros Oracle)
]);

function isSummaryRow(cat) {
  const low = (cat || '').toLowerCase().trim();
  if (!low) return false;
  if (SUMMARY_ALONE.has(low)) return true;
  // Summary word as a PREFIX (beginning of label) = derived total
  if (SUMMARY_PREFIXES.some(w => low.startsWith(w + ' ') || low.startsWith(w + '-'))) return true;
  return false;
  // Note: "Food Sales", "Alcohol Revenue" etc. do NOT match because
  // "sales"/"revenue" appear as suffixes, not prefixes.
}

// ─── SERVICE CHANNEL ──────────────────────────────────────────────────────────
const SERVICE_CHANNEL_WORDS = new Set([
  'dine in','dine-in','dinein','dine in service',
  'table service','table','tables','seated','seated dining',
  'full service','quick service','qsr',
  'takeout','take out','take-out','to go','to-go','togo',
  'carry out','carry-out','carryout',
  'pickup','pick up','pick-up',
  'walk up','walk-up','walk in','walk-in',
  'online','online order','online orders','online ordering',
  'web order','web orders','website',
  'delivery','deliveries','3rd party delivery','third party delivery',
  'drive thru','drive-thru','drive through','drive-through',
  'counter','counter service','counter orders',
  'kiosk','self service','self-service',
  'catering','catering order','catering orders',
  'bar service','lounge service',
  'curbside','curbside pickup',
  'phone order','phone orders','call in','call-in',
  'in store','in-store',
  // Venue / location type revenue centers (common in full-service restaurants)
  'bar','bars','lounge','bar & lounge','bar and lounge',
  'patio','terrace','rooftop','outdoor','outdoor seating','garden',
  'dining room','main dining','main dining room','dining area',
  'private dining','private dining room','private room',
  'private events','private event','event room','banquet','banquet room','banquet hall',
  'pool bar','pool deck','beach bar','beach club',
  'hotel restaurant','hotel bar','lobby bar',
  'mezzanine','balcony','deck',
]);
const SERVICE_CHANNEL_PATTERNS = [
  /^dine.?in/i,/^take.?out/i,/^to.?go/i,/^pick.?up/i,/^carry.?out/i,
  /^walk.?up/i,/^walk.?in/i,/^drive.?thr/i,
  /\bonline\s*order/i,/\bdelivery\b/i,/\bcatering\b/i,
  /^curbside/i,/\bkiosk\b/i,
];

function isServiceChannel(cat) {
  const low = (cat || '').toLowerCase().trim();
  if (SERVICE_CHANNEL_WORDS.has(low)) return true;
  if (SERVICE_CHANNEL_PATTERNS.some(p => p.test(low))) return true;
  // Multi-word names: "Patio Bar", "Rooftop Bar", "Hotel Bar", "Pool Lounge" etc.
  // If EVERY word-token (≥3 chars) in the name is a service-channel word, treat as service.
  const tokens = low.split(/[\s\-\/&,]+/).filter(t => t.length >= 3);
  return tokens.length >= 2 && tokens.every(t => SERVICE_CHANNEL_WORDS.has(t));
}

function classifyPOS(cat) {
  if (isDeduction(cat))      return 'deduction';
  if (isPaymentMethod(cat))  return 'payment';
  if (isSummaryRow(cat))     return 'summary';
  if (isServiceChannel(cat)) return 'service';
  return 'product';
}

// ─── COLUMN HEADER CLASSIFIER (for wide/transposed layouts) ───────────────────
//
// POS exports often use column headers like "food_sales", "card_sales",
// "gross_sales", "electronic_tips" where underscores and suffixes prevent the
// normal word-match logic from working.  We normalize first, then classify.
//
// Examples:
//   "gross_sales"      → strip "_sales" → "gross"       → summary
//   "food_sales"       → strip "_sales" → "food"        → product
//   "card_sales"       → strip "_sales" → "card"        → payment
//   "electronic_tips"  → replace "_"   → "electronic tips" → deduction

function normalizeColumnHeader(h) {
  return String(h || '')
    .toLowerCase()
    .replace(/_/g, ' ')
    // Strip trailing measurement/type words that don't change the category
    .replace(/\s+(sales|revenue|amount|total|payments?|transactions?|count|qty|quantity)\s*$/i, '')
    .trim();
}

function classifyColumn(header) {
  const raw  = String(header || '').toLowerCase().replace(/_/g, ' ').trim();
  const norm = normalizeColumnHeader(header);
  // Test both the raw (with spaces) and the stripped form
  if (isDeduction(raw)  || isDeduction(norm))     return 'deduction';
  if (isPaymentMethod(raw) || isPaymentMethod(norm)) return 'payment';
  if (isSummaryRow(raw) || isSummaryRow(norm))    return 'summary';
  if (isServiceChannel(raw) || isServiceChannel(norm)) return 'service';
  return 'product';
}

// ─── DATE HELPERS ─────────────────────────────────────────────────────────────
const MONTH_ABBR = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };
const MONTH_FULL = { january:1,february:2,march:3,april:4,may:5,june:6,
                     july:7,august:8,september:9,october:10,november:11,december:12 };
const QUARTER_END = { 1:'03-31', 2:'06-30', 3:'09-30', 4:'12-31' };

function lastDayOfMonth(yyyy, mm) {
  return new Date(yyyy, mm, 0).getDate();
}

// Convert any recognizable date string to YYYY-MM-DD, or return the input unchanged.
// Uses end-of-month/period convention (period-end accounting standard).
// yearHint: year to assume when only a month name is given (inferred from sibling rows).
function normaliseDate(val, yearHint) {
  if (!val) return val;
  const s = String(val).trim();
  if (!s) return s;

  // Date range "01/01/2024-01/31/2024" or "2024-01-01 to 2024-01-31" — take start date
  const rangeMatch = s.match(/^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})\s*[-–—to]+\s*\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4}$/) ||
                     s.match(/^(\d{4}-\d{2}-\d{2})\s*[-–—to]+\s*\d{4}-\d{2}-\d{2}$/);
  if (rangeMatch) return normaliseDate(rangeMatch[1], yearHint);

  // Already ISO YYYY-MM-DD — pass through
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;

  // YYYY-MM — append last day of month
  const ymMatch = s.match(/^(\d{4})-(\d{1,2})$/);
  if (ymMatch) {
    const y = +ymMatch[1], m = +ymMatch[2];
    return `${y}-${String(m).padStart(2,'0')}-${String(lastDayOfMonth(y, m)).padStart(2,'0')}`;
  }

  // MM/YYYY or MM-YYYY
  const myMatch = s.match(/^(\d{1,2})[\/\-](\d{4})$/);
  if (myMatch) {
    const m = +myMatch[1], y = +myMatch[2];
    return `${y}-${String(m).padStart(2,'0')}-${String(lastDayOfMonth(y, m)).padStart(2,'0')}`;
  }

  // MM/DD/YYYY or M/D/YYYY
  const mdyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (mdyMatch) {
    const m = +mdyMatch[1], d = +mdyMatch[2], y = +mdyMatch[3];
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  // YYYY/MM/DD
  const ymdSlash = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/);
  if (ymdSlash) {
    const y = +ymdSlash[1], m = +ymdSlash[2], d = +ymdSlash[3];
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  // DD/MM/YYYY (European) — only if first number > 12 (unambiguous)
  const dmyMatch = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (dmyMatch && +dmyMatch[1] > 12) {
    const d = +dmyMatch[1], m = +dmyMatch[2], y = +dmyMatch[3];
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  // "Q1 2024", "Q2-2024", "q3 2024"
  const qMatch = s.match(/^[Qq]([1-4])[\s\-](\d{4})$/);
  if (qMatch) {
    return `${qMatch[2]}-${QUARTER_END[+qMatch[1]]}`;
  }

  // "Jan 2024", "January 2024", "jan-2024"
  const monYrMatch = s.match(/^([A-Za-z]+)[\s\-\/](\d{4})$/);
  if (monYrMatch) {
    const mname = monYrMatch[1].toLowerCase();
    const y = +monYrMatch[2];
    const m = MONTH_ABBR[mname.slice(0,3)] || MONTH_FULL[mname];
    if (m) return `${y}-${String(m).padStart(2,'0')}-${String(lastDayOfMonth(y, m)).padStart(2,'0')}`;
  }

  // "2024 Jan", "2024 January"
  const yrMonMatch = s.match(/^(\d{4})[\s\-]([A-Za-z]+)$/);
  if (yrMonMatch) {
    const y = +yrMonMatch[1];
    const mname = yrMonMatch[2].toLowerCase();
    const m = MONTH_ABBR[mname.slice(0,3)] || MONTH_FULL[mname];
    if (m) return `${y}-${String(m).padStart(2,'0')}-${String(lastDayOfMonth(y, m)).padStart(2,'0')}`;
  }

  // "Jan 31, 2024" or "January 31 2024"
  const monDayYr = s.match(/^([A-Za-z]+)\s+(\d{1,2})[,\s]+(\d{4})$/);
  if (monDayYr) {
    const mname = monDayYr[1].toLowerCase();
    const d = +monDayYr[2], y = +monDayYr[3];
    const m = MONTH_ABBR[mname.slice(0,3)] || MONTH_FULL[mname];
    if (m) return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }

  // Month name alone — "May", "January", "jan"
  // Requires yearHint; maps to last day of that month
  const mname = s.toLowerCase();
  const m = MONTH_ABBR[mname.slice(0,3)] || MONTH_FULL[mname];
  if (m) {
    const y = yearHint || new Date().getFullYear();
    return `${y}-${String(m).padStart(2,'0')}-${String(lastDayOfMonth(y, m)).padStart(2,'0')}`;
  }

  // Unrecognised — return as-is (parser will ignore it for date-splitting purposes)
  return s;
}

// Infer a year hint from a batch of raw date strings — takes the most common 4-digit year found.
function inferYear(rawDates) {
  const years = {};
  for (const d of rawDates) {
    const m = String(d || '').match(/\b(20\d{2}|19\d{2})\b/);
    if (m) years[m[1]] = (years[m[1]] || 0) + 1;
  }
  const sorted = Object.entries(years).sort((a,b) => b[1]-a[1]);
  return sorted.length ? +sorted[0][0] : null;
}

function isDateLike(val) {
  if (!val) return false;
  const s = String(val).trim();
  return (
    /\d{4}[-\/]\d{1,2}[-\/]\d{1,2}/.test(s) ||
    /\d{1,2}[-\/]\d{1,2}[-\/]\d{2,4}/.test(s) ||
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{1,2}[,\s]+\d{4}/i.test(s) ||
    /^(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\s+\d{4}/i.test(s) ||
    /^q[1-4]\s+\d{4}/i.test(s)
  );
}

function isNumericCol(values) {
  const ne = values.filter(v => v != null && String(v).trim() !== '');
  if (!ne.length) return false;
  if (ne.filter(v => isDateLike(String(v))).length / ne.length > 0.5) return false;
  const num = ne.filter(v => {
    const c = String(v).trim().replace(/[$,\s]/g, '').replace(/\(([^)]+)\)/, '-$1');
    return !isNaN(parseFloat(c));
  });
  return num.length / ne.length > 0.6;
}

// Returns true if a column contains percentage values (e.g. "8.9%", "40.1%").
// Percentage columns are NOT monetary amounts and must be excluded from revenue detection.
function isPercentCol(values) {
  const ne = values.filter(v => v != null && String(v).trim() !== '').slice(0, 20);
  if (!ne.length) return false;
  const pct = ne.filter(v => /^-?\d+\.?\d*\s*%/.test(String(v).trim()));
  return pct.length / ne.length >= 0.5;
}

function isTotalRow(val) {
  const low = String(val || '').toLowerCase().trim();
  if (['total','totals','subtotal','subtotals','grand total','grand totals',
    'sub-total','sub-totals','sum','sums','net total','overall total',
    'average','total row','summary row','---','──','***'].includes(low)) return true;
  // "Total Expenses", "Total Sales", "Total Labor", "Expenses Total", etc.
  // Any label that starts or ends with a summary word + another word is a derived row.
  if (/^(total|totals|grand|subtotal|sub-total|sum|overall)\s+\S/.test(low)) return true;
  if (/\s+(total|totals|subtotal|sum|combined|aggregate)$/.test(low)) return true;
  return false;
}

// ─── CSV TOKENISER ────────────────────────────────────────────────────────────
function parseRaw(content) {
  const lines = content.replace(/^\uFEFF/, '').trim().split(/\r?\n/).filter(l => l.trim());
  return lines.map(line => {
    const cells = []; let cur = '', inQ = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') { inQ = !inQ; continue; }
      if (!inQ && ch === ',') { cells.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    cells.push(cur.trim());
    return cells;
  }).filter(row => row.some(c => c !== ''));
}

function findHeaderRow(rows) {
  for (let i = 0; i < Math.min(rows.length, 8); i++) {
    const row = rows[i].filter(c => c !== '');
    const nonNum = row.filter(c => isNaN(parseFloat(c.replace(/[$,]/g, ''))) || isDateLike(c));
    if (row.length >= 2 && nonNum.length >= 2) return i;
  }
  return 0;
}

function findCol(headers, candidates) {
  const lower = headers.map(h => String(h).toLowerCase().trim());
  for (const n of candidates) {
    const i = lower.indexOf(n.toLowerCase());
    if (i >= 0) return i;
  }
  for (const n of candidates) {
    const i = lower.findIndex(h => new RegExp('\\b' + n.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\b').test(h));
    if (i >= 0) return i;
  }
  return -1;
}

// Prefer "net" columns over "gross" — net is after discounts, more accurate
function pickBestAmtCol(headers, dataRows, excludeIdx) {
  const lower = headers.map(h => String(h).toLowerCase().trim());
  const HOUR_COL  = /\b(hours?|hrs?|count|qty|quantity|headcount|shifts?|days?)\b/i;
  const MONEY_HDR = /\b(revenue|amount|sales|income|turnover|receipts|total|gross|net)\b/i;
  const PCT_HDR   = /\b(pct|percent|percentage)\b/i;

  const numericCols = headers.map((_, i) => {
    if (i === excludeIdx || !dataRows.length) return -1;
    const hdr  = lower[i];
    const vals = dataRows.map(r => r[i]);
    if (PCT_HDR.test(hdr) || hdr === '%' || hdr.endsWith('%')) return -1;
    // Strongly-named money header: trust it even if some rows show % (multi-section CSV)
    if (MONEY_HDR.test(hdr.replace(/_/g,' ')) && !HOUR_COL.test(hdr.replace(/_/g,' '))) {
      const hasMoneyVals = vals.some(v => {
        const s = String(v || '').trim();
        return !s.endsWith('%') && !isNaN(parseFloat(s.replace(/[$,\s]/g,''))) && parseFloat(s.replace(/[$,\s]/g,'')) > 0;
      });
      return hasMoneyVals ? i : -1;
    }
    return (isNumericCol(vals) && !isPercentCol(vals)) ? i : -1;
  }).filter(i => i >= 0);

  // Normalise snake_case headers for matching (net_sales → net sales, total_gross → total gross)
  // JS word boundaries don't fire at underscore boundaries since _ is a word character.
  const norm = i => lower[i].replace(/_/g, ' ');

  const netSales = numericCols.find(i => /\bnet\s*(sales|amount|revenue)\b/i.test(norm(i)));
  if (netSales !== undefined) return netSales;
  const net = numericCols.find(i => /\bnet\b/i.test(norm(i)) && !HOUR_COL.test(norm(i)));
  if (net !== undefined) return net;
  const amount = numericCols.find(i => /\b(amount|total|revenue|sales|compensation|earnings|wages)\b/i.test(norm(i)) &&
    !HOUR_COL.test(norm(i)));
  if (amount !== undefined) return amount;
  const nonHour = numericCols.find(i => !HOUR_COL.test(lower[i]));
  if (nonHour !== undefined) return nonHour;
  return numericCols[0] !== undefined ? numericCols[0] : -1;
}

// ─── LAYOUT DETECTION ─────────────────────────────────────────────────────────
function detectLayout(headers, dataRows) {
  const hDateCols = headers.slice(1).filter(h => isDateLike(h));
  if (hDateCols.length >= 2)
    return { layout: 'transposed', dateCols: hDateCols, labelCol: 0 };

  const DATE_CANDIDATES = ['date','day','sale date','transaction date',
    'pay date','pay period','period','week','month','invoice date'];
  const dateColIdx = findCol(headers, DATE_CANDIDATES);
  const firstIsDate = dateColIdx >= 0 || (dataRows.length && isDateLike(dataRows[0][0]));

  if (firstIsDate) {
    const dc = dateColIdx >= 0 ? dateColIdx : 0;
    const numCols = headers.map((_, i) => i)
      .filter(i => i !== dc && dataRows.length && isNumericCol(dataRows.map(r => r[i])));
    if (numCols.length >= 2) {
      const ai = pickBestAmtCol(headers, dataRows, dc);
      const ci = findCol(headers, ['category','type','item','department','menu category','revenue type']);
      if (ai >= 0 && ci >= 0) return { layout: 'tall', dateCol: dc, amtCol: ai, extraCol: ci };
      return { layout: 'wide', dateCol: dc, valueCols: numCols };
    }
    return { layout: 'tall', dateCol: dc, amtCol: -1, extraCol: -1 };
  }

  const numCols = headers.map((_, i) =>
    dataRows.length && isNumericCol(dataRows.map(r => r[i])) ? i : -1).filter(i => i >= 0);
  if (numCols.length) return { layout: 'summary', labelCol: 0, amtCol: numCols[0] };
  return { layout: 'tall', dateCol: -1, amtCol: -1, extraCol: -1 };
}

// ─── NORMALISER ───────────────────────────────────────────────────────────────
function normalise(rawRows, extraCandidates, defaultExtra, preferAmtKeywords) {
  defaultExtra = defaultExtra || 'Unknown';
  if (!rawRows.length) return { rows: [], layout: 'empty', headers: [] };
  const hi = findHeaderRow(rawRows);
  const headers = rawRows[hi];
  const data = rawRows.slice(hi + 1).filter(r => r.some(c => c.trim() !== '') && !isTotalRow(r[0]));
  const info = detectLayout(headers, data);
  const out = [];

  // Scan the first few rows for a date range (e.g. "01/01/2024-01/31/2024").
  // Covers formats where the period appears in a title row that findHeaderRow may
  // itself identify as the header row (hi = 0), so we can't rely on hi > 0.
  const DATE_RANGE_RE = /(\d{1,2})\/(\d{1,2})\/(\d{4})[–\-—](\d{1,2})\/(\d{1,2})\/(\d{4})/;
  let titleDateEnd = null;
  for (let i = 0; i < Math.min(rawRows.length, 5) && !titleDateEnd; i++) {
    for (const cell of rawRows[i]) {
      const m = String(cell).match(DATE_RANGE_RE);
      if (m) {
        const endMo  = String(m[4]).padStart(2, '0');
        const endDay = String(m[5]).padStart(2, '0');
        const endYr  = m[6];
        titleDateEnd = `${endYr}-${endMo}-${endDay}`;
        break;
      }
    }
  }


  if (info.layout === 'tall') {
    let { dateCol, amtCol, extraCol } = info;
    if (preferAmtKeywords) {
      // Override column selection: prefer specified keywords (e.g. 'gross pay' for payroll).
      // This runs unconditionally so it overrides whatever detectLayout picked.
      const lower = headers.map(h => String(h).toLowerCase().trim());
      // Also block columns that are hours/counts, not money — they're numeric but not wages.
      const HOUR_PATTERN = /\b(hours?|hrs?|count|qty|quantity|headcount|shifts?|days?)\b/i;
      for (const kw of preferAmtKeywords) {
        const idx = lower.findIndex(h => h.includes(kw));
        if (idx >= 0 && idx !== (dateCol < 0 ? -99 : dateCol) &&
            !HOUR_PATTERN.test(lower[idx]) &&
            data.length && isNumericCol(data.map(r => r[idx]))) {
          amtCol = idx; break;
        }
      }
    }
    if (amtCol < 0) amtCol = pickBestAmtCol(headers, data, dateCol >= 0 ? dateCol : -99);
    if (amtCol < 0) amtCol = headers.findIndex((_, i) =>
      i !== (dateCol < 0 ? -99 : dateCol) && data.length && isNumericCol(data.map(r => r[i])));
    if (amtCol < 0) return { rows: [], layout: info.layout, headers };
    if (extraCol < 0) extraCol = findCol(headers, extraCandidates);
    const _yearHint = inferYear(dateCol >= 0 ? data.map(r => r[dateCol]) : []);
    for (const row of data) {
      const label = extraCol >= 0 ? row[extraCol] : row[0];
      if (isTotalRow(label)) continue;
      out.push({
        date:   dateCol >= 0 ? normaliseDate(row[dateCol], _yearHint) : null,
        amount: toNum(row[amtCol]),
        extra:  extraCol >= 0 ? (row[extraCol] || defaultExtra) : defaultExtra,
      });
    }
  } else if (info.layout === 'wide') {
    const { dateCol, valueCols } = info;

    const colClasses = valueCols.map(i => ({
      idx: i, name: headers[i], cls: classifyColumn(headers[i]),
    }));

    const summaryCols = colClasses.filter(c => c.cls === 'summary');
    const productCols = colClasses.filter(c => c.cls === 'product');
    const serviceCols = colClasses.filter(c => c.cls === 'service');

    // Strip '_sales'/'_revenue' suffixes and title-case for display labels.
    // 'food_sales' → 'Food',  'alcohol_sales' → 'Alcohol',  'gross_sales' → 'Gross Sales'
    function prettyColName(h) {
      return String(h).replace(/_/g, ' ')
        .replace(/\b(sales|revenue)\b/gi, '').trim()
        .replace(/\b\w/g, c => c.toUpperCase()) || String(h);
    }

    // Net anchor preferred over gross (e.g. net_sales beats gross_sales)
    const anchorCol = summaryCols.length > 0
      ? (summaryCols.find(c => /net/i.test(c.name)) || summaryCols[0])
      : null;
    const activeProdCols = productCols.length > 0 ? productCols : serviceCols;

    const _paymentBreakdown = {};

    const _wideYearHint = inferYear(data.map(r => r[dateCol]));
    for (const row of data) {
      if (isTotalRow(row[dateCol])) continue;
      const date = normaliseDate(row[dateCol] || null, _wideYearHint);

      for (const c of colClasses) {
        if (c.cls === 'payment') {
          const amt = toNum(row[c.idx]);
          if (amt > 0) _paymentBreakdown[c.name] = (_paymentBreakdown[c.name] || 0) + amt;
        }
      }

      if (anchorCol && activeProdCols.length > 0) {
        // ── Anchor + product columns ───────────────────────────────────────────
        // Product sub-columns (food_sales, alcohol_sales) may NOT reconcile with the
        // anchor (gross_sales) — they can overlap, double-count tips, or be from a
        // different tracking system.  Treat them as PROPORTIONAL labels only:
        // scale each product's share of (food+alc+...) against the anchor total so
        // that every day's emitted rows always sum to gross_sales (the authoritative total).
        const gross = toNum(row[anchorCol.idx]);
        if (gross === 0) continue;

        const prodAmts = activeProdCols.map(c => ({ name: prettyColName(c.name), raw: Math.max(0, toNum(row[c.idx])) }));
        const prodRawSum = prodAmts.reduce((s, p) => s + p.raw, 0);

        if (prodRawSum > 0) {
          // Proportionally scale product amounts to sum to gross
          for (const p of prodAmts) {
            const scaled = gross * (p.raw / prodRawSum);
            if (scaled > 0.005) out.push({ date, amount: scaled, extra: p.name });
          }
        } else {
          // No product detail for this row — emit as a single "Sales" row
          out.push({ date, amount: gross, extra: prettyColName(anchorCol.name) });
        }

      } else if (anchorCol) {
        // Anchor only — emit daily total with a clean label
        const gross = toNum(row[anchorCol.idx]);
        if (gross !== 0) out.push({ date, amount: gross, extra: prettyColName(anchorCol.name) });

      } else {
        // No anchor: sum all non-payment, non-deduction columns
        const fallback = colClasses.filter(c => c.cls !== 'payment' && c.cls !== 'deduction');
        for (const { idx, name } of fallback) {
          const amt = toNum(row[idx]);
          if (amt !== 0) out.push({ date, amount: amt, extra: prettyColName(name) });
        }
      }
    }

    // Rows now carry meaningful category labels (Food, Alcohol, etc.) and sum to gross_sales.
    // No separate product breakdown metadata needed.
    out._productBreakdown = null;
    out._paymentBreakdown = Object.keys(_paymentBreakdown).length ? _paymentBreakdown : null;
  } else if (info.layout === 'transposed') {
    const { labelCol, dateCols } = info;
    const dIdxs = dateCols.map(d => headers.indexOf(d));
    const _yearHint = inferYear(dateCols);
    for (const row of data) {
      if (isTotalRow(row[labelCol])) continue;
      for (let di = 0; di < dateCols.length; di++) {
        const amt = dIdxs[di] >= 0 ? toNum(row[dIdxs[di]]) : 0;
        if (amt !== 0) out.push({ date: normaliseDate(dateCols[di], _yearHint), amount: amt, extra: row[labelCol] || defaultExtra });
      }
    }
  } else if (info.layout === 'summary') {
    let labelCol = info.labelCol;
    const betterLabel = findCol(headers, extraCandidates);
    if (betterLabel >= 0) labelCol = betterLabel;
    let amtCol = -1;
    if (preferAmtKeywords) {
      // Prefer specified columns (e.g. gross pay over net pay for payroll)
      const lower = headers.map(h => String(h).toLowerCase().trim());
      for (const kw of preferAmtKeywords) {
        const idx = lower.findIndex(h => h.includes(kw));
        if (idx >= 0 && idx !== labelCol && data.length && isNumericCol(data.map(r => r[idx]))) {
          amtCol = idx; break;
        }
      }
    }
    if (amtCol < 0) amtCol = pickBestAmtCol(headers, data, labelCol);
    // For multi-section CSVs (e.g. Lightspeed with Revenue Centers + Product Mix sections),
    // detect embedded header rows mid-data and switch amtCol per section.
    function isHeaderLikeRow(row) {
      // A row that looks like a new section header: all non-empty cells are text (not numeric),
      // and at least one cell matches a known column header pattern.
      const ne = row.filter(c => c && String(c).trim() !== '');
      if (ne.length < 2) return false;
      const allText = ne.every(c => isNaN(toNum(c)) || toNum(c) === 0);
      const hasHdrWord = ne.some(c => /\b(category|qty|quantity|sold|revenue|amount|sales|total|percentage|percent|%|type|department|group|item)\b/i.test(String(c)));
      return allText && hasHdrWord;
    }

    let curAmtCol = amtCol >= 0 ? amtCol : info.amtCol;
    // Find an "annual total" column as fallback for rows where monthly is "varies"/non-numeric
    const annualColIdx = findCol(headers, ['annual total','annual','yearly total','yearly','total annual']);
    // Month names for lump-sum detection in notes/description columns
    const MONTH_NAME_RE = /\b(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:tember)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)\b/i;
    const MONTH_NAME_TO_NUM = { jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12 };

    for (const row of data) {
      if (isTotalRow(row[labelCol])) continue;
      // Detect embedded section header — re-pick amtCol for this section
      if (isHeaderLikeRow(row)) {
        const sectionAmt = pickBestAmtCol(row, data.slice(data.indexOf(row) + 1, data.indexOf(row) + 8), labelCol);
        if (sectionAmt >= 0) curAmtCol = sectionAmt;
        continue; // Don't emit the header row itself
      }
      // When the row has fewer columns than curAmtCol (e.g. "Net Revenue,241840" in a 4-col table),
      // fall back to the last non-empty numeric cell in the row.
      let _rawAmt = row[curAmtCol];
      if ((_rawAmt === undefined || _rawAmt === '') && row.length < curAmtCol + 1) {
        const lastNum = row.slice(1).filter(c => c && c.trim() !== '' && toNum(c) !== 0);
        if (lastNum.length) _rawAmt = lastNum[lastNum.length - 1];
      }

      let amount = toNum(_rawAmt);
      let lumpSumMonth = null;

      // Monthly Amount is non-numeric (e.g. "varies") — try Annual Total column
      if (amount === 0 && annualColIdx >= 0) {
        const annualAmt = toNum(row[annualColIdx]);
        if (annualAmt > 0) {
          amount = annualAmt;
          // Look for a specific month in any other column (notes, description, etc.)
          for (let ci = 0; ci < row.length; ci++) {
            if (ci === labelCol || ci === annualColIdx) continue;
            const cell = String(row[ci] || '');
            const mMatch = cell.match(MONTH_NAME_RE);
            if (mMatch) {
              const key = mMatch[1].toLowerCase().slice(0, 3);
              lumpSumMonth = MONTH_NAME_TO_NUM[key] || null;
              break;
            }
          }
        }
      }

      if (amount !== 0) {
        const rowOut = { date: null, amount, extra: row[labelCol] || defaultExtra };
        if (lumpSumMonth) rowOut.lumpSumMonth = lumpSumMonth;
        out.push(rowOut);
      }
    }
  }

  // Apply titleDateEnd to any null-date rows (summary POS formats with header date range)
  if (titleDateEnd) {
    for (let i = 0; i < out.length; i++) {
      if (!out[i].date) out[i] = { ...out[i], date: titleDateEnd };
    }
  }

  const filtered = out.filter(r => Math.abs(r.amount) > 0);
  filtered._productBreakdown = out._productBreakdown || null;
  filtered._paymentBreakdown = out._paymentBreakdown || null;
  return { rows: filtered, layout: info.layout, headers,
    productBreakdown: out._productBreakdown || null,
    paymentBreakdown: out._paymentBreakdown || null };
}

// ─── REVENUE SELECTION — ANCHOR-FIRST ─────────────────────────────────────────
//
// Philosophy: anchor (Gross Revenue, Net Sales) = the truth.
// Categories (Food, Alcohol, "Food Sales") = a breakdown view of that truth.
// Payments (Cash, Card) = another view of that same truth.
// If views disagree with anchor by >10%: flag conflict, give user 3 choices.
//
function selectRevenue(rows) {
  const positive = rows.filter(r => r.amount > 0);

  const products   = positive.filter(r => classifyPOS(r.extra) === 'product');
  const services   = positive.filter(r => classifyPOS(r.extra) === 'service');
  const summaries  = positive.filter(r => classifyPOS(r.extra) === 'summary');
  const payments   = positive.filter(r => classifyPOS(r.extra) === 'payment');
  const deductions = positive.filter(r => classifyPOS(r.extra) === 'deduction');

  const productTotal = products.reduce((s, r) => s + r.amount, 0);
  const serviceTotal = services.reduce((s, r) => s + r.amount, 0);
  const paymentTotal = payments.reduce((s, r) => s + r.amount, 0);

  // ── STEP 1: Find best anchor (prefer net over gross, explicit over generic) ──
  function fa(...pats) { return summaries.find(r => pats.some(p => p.test(r.extra))); }
  const anchor =
    fa(/^net\s*revenue$/i)   || fa(/net\s*revenue/i)   ||
    fa(/^net\s*sales$/i)     || fa(/net\s*sales/i)      ||
    fa(/^net$/i)             ||
    fa(/^gross\s*revenue$/i) || fa(/gross\s*revenue/i)  ||
    fa(/^gross\s*sales$/i)   || fa(/gross\s*sales/i)    ||
    fa(/^revenue$/i)         || fa(/^sales$/i)          ||
    (summaries.length ? summaries.slice().sort((a, b) => b.amount - a.amount)[0] : null);

  const anchorVal = anchor ? anchor.amount : 0;

  // ── STEP 2: If anchor found, cross-check against every available view ───────
  if (anchorVal > 0) {
    // Thresholds: flag any gap > 3% between anchor and cross-check views.
    // 3% on $370k = ~$11k — meaningful enough to surface but not noise-triggering.
    const CAT_THRESHOLD = 0.03;
    const PAY_THRESHOLD = 0.03;

    // Three independent views of the same revenue number:
    //   anchor   = the stated summary total (gross_sales, Net Revenue, etc.)
    //   catTotal = sum of product categories (Food, Alcohol, etc.)
    //   payTotal = sum of payment methods (Cash + Card) — a separate cross-check
    const catRows  = products.length > 0 ? products : services;
    const catTotal = products.length > 0 ? productTotal : serviceTotal;
    const payTotal = paymentTotal; // cash + card + etc.

    const hasCat = catTotal > 0;
    const hasPay = payTotal > 0;

    // Check each view against the anchor
    const catRatio    = hasCat ? catTotal / anchorVal : 0;
    const payRatio    = hasPay ? payTotal / anchorVal : 0;
    const catOk       = hasCat && Math.abs(catRatio - 1) <= CAT_THRESHOLD;
    const payOk       = hasPay && Math.abs(payRatio - 1) <= PAY_THRESHOLD;
    const catConflict = hasCat && !catOk;
    const payConflict = hasPay && !payOk;

    // Conflict exists if ANY cross-check disagrees with anchor
    const conflict = catConflict || payConflict;

    // ── Build conflict message ─────────────────────────────────────────────
    let conflictMessage = null;
    if (conflict) {
      const parts = [];
      if (catConflict) {
        const sign = catRatio > 1 ? '+' : '';
        parts.push('Product categories (' + _fd(catTotal) + ') differ by ' +
          sign + ((catRatio - 1) * 100).toFixed(1) + '%');
      }
      if (payConflict) {
        const sign = payRatio > 1 ? '+' : '';
        parts.push('Payment methods (' + _fd(payTotal) + ') differ by ' +
          sign + ((payRatio - 1) * 100).toFixed(1) + '%');
      }
      conflictMessage = anchor.extra + ' states ' + _fd(anchorVal) + '. ' +
        parts.join('; ') + '. ' +
        'Average has been pre-selected. Choose which figure to use below.';
    }

    // ── Build all three options for the UI ────────────────────────────────
    const options = [];

    // Option 1: anchor (stated total)
    options.push({
      id: 'anchor',
      label: anchor.extra + ' — stated total' + (payOk ? ' ✓ confirmed by payments' : catOk ? ' ✓ confirmed by categories' : ''),
      amount: anchorVal,
      rows: [anchor],
    });

    // Option 2: category breakdown (if available)
    if (hasCat && catTotal > 0) {
      options.push({
        id: 'categories',
        label: catRows.map(r => r.extra).join(' + ') + ' — category breakdown'
          + (catOk ? ' ✓' : ''),
        amount: catTotal,
        rows: catRows,
      });
    }

    // Option 2b: payment method sum (if available and no categories, or as additional option)
    if (hasPay && payTotal > 0 && (!hasCat || payConflict)) {
      options.push({
        id: 'payments',
        label: 'Cash + Card total — payment method sum' + (payOk ? ' ✓' : ''),
        amount: payTotal,
        rows: payments,
      });
    }

    // Option 3: average — uses the most divergent cross-check for meaningful midpoint
    // If payment conflicts but categories match: average anchor with payment total
    // If categories conflict: average anchor with category total
    // If both conflict: average anchor with category total (products are more reliable)
    const avgBase = payConflict && !catConflict ? payTotal
                  : hasCat ? catTotal
                  : payTotal;
    if (avgBase > 0 && avgBase !== anchorVal) {
      const avg = (anchorVal + avgBase) / 2;
      options.push({
        id: 'average',
        label: '⚑ Average of stated total & ' + (payConflict && !catConflict ? 'payment sum' : 'category breakdown') + ' — flagged for review',
        amount: avg,
        rows: [{ ...anchor, amount: avg, extra: 'Average (flagged for review)' }],
      });
    } else if (avgBase > 0 && avgBase === anchorVal && hasPay && payConflict) {
      // Categories match anchor but payments don't — show anchor/payment average
      const avg = (anchorVal + payTotal) / 2;
      options.push({
        id: 'average',
        label: '⚑ Average of stated total & payment sum — flagged for review',
        amount: avg,
        rows: [{ ...anchor, amount: avg, extra: 'Average (flagged for review)' }],
      });
    }

    // ── Auto-select ────────────────────────────────────────────────────────
    // No conflict → use categories (best breakdown) or anchor
    // Conflict    → pre-select average so the user sees it immediately
    let selectedId, used, strategy;

    if (!conflict) {
      if (catOk && hasCat) {
        // Categories confirm anchor — use categories for product breakdown detail
        used = catRows;
        selectedId = 'categories';
        strategy = anchor.extra + ' (' + _fd(anchorVal) + ') confirmed by category breakdown (' +
          _fd(catTotal) + '). Using categories for detail.';
      } else if (payOk && hasPay) {
        // Payment sum confirms anchor
        used = [anchor];
        selectedId = 'anchor';
        strategy = anchor.extra + ' (' + _fd(anchorVal) + ') confirmed by payment method sum (' +
          _fd(payTotal) + ').';
      } else {
        // Anchor only — no cross-check available
        used = [anchor];
        selectedId = 'anchor';
        strategy = 'Using ' + anchor.extra + ' (' + _fd(anchorVal) + ') as total revenue.';
      }
    } else {
      // CONFLICT: default to average, flag for user review
      const avgOpt = options.find(o => o.id === 'average');
      if (avgOpt) {
        used = avgOpt.rows;
        selectedId = 'average';
      } else {
        // No average option (e.g. only payments exist with no categories)
        used = [anchor];
        selectedId = 'anchor';
      }
      strategy = '⚠️ CONFLICT: ' + conflictMessage;
    }

    const usedSet = new Set(used);
    const excluded = _buildExcluded(deductions, payments, summaries, services, products, usedSet, anchor);

    return { used, strategy, warning: conflict ? conflictMessage : null, excluded,
             options, conflict, conflictMessage, selectedId };
  }

  // ── STEP 3: No anchor — use best available category view ─────────────────
  let used, strategy;

  if (products.length > 0 && services.length > 0) {
    // Both views present = same money two ways; prefer product breakdown
    used = products;
    strategy = 'No anchor row found. File has product categories (' + _fd(productTotal) +
      ') and service channels (' + _fd(serviceTotal) + ') — same revenue grouped two ways. ' +
      'Using product categories (' + products.map(r => r.extra).join(', ') + ').';
  } else if (products.length > 0) {
    used = products;
    strategy = 'No anchor row found. Summing ' + products.length +
      ' product category rows = ' + _fd(productTotal) + '.';
  } else if (services.length > 0) {
    used = services;
    strategy = 'No anchor row found. Summing ' + services.length +
      ' service channel rows = ' + _fd(serviceTotal) + '.';
  } else if (payments.length > 0) {
    used = payments;
    strategy = 'Only payment method rows found (' + _fd(paymentTotal) + '). ' +
      'Upload a category-level sales report for a better breakdown.';
  } else {
    used = positive.filter(r => classifyPOS(r.extra) !== 'deduction');
    strategy = 'Could not classify rows — summing all positive non-deduction values.';
  }

  const usedSet = new Set(used);
  const excluded = _buildExcluded(deductions, payments, summaries, services, products, usedSet, null);
  const usedTotal = used.reduce((s, r) => s + r.amount, 0);
  const options = [{ id: 'categories', label: 'Category total (no anchor found)', amount: usedTotal, rows: used }];

  return { used, strategy, warning: null, excluded, options, conflict: false,
           conflictMessage: null, selectedId: 'categories' };
}

function _buildExcluded(deductions, payments, summaries, services, products, usedSet, anchor) {
  return [
    ...deductions.map(r => ({ category: r.extra, amount: r.amount, reason: 'Tax/deduction — not counted as revenue' })),
    ...payments.filter(r => !usedSet.has(r)).map(r => ({ category: r.extra, amount: r.amount, reason: 'Payment method — HOW money was collected, not WHAT was sold' })),
    ...summaries.filter(r => !usedSet.has(r)).map(r => ({ category: r.extra, amount: r.amount, reason: 'Summary/total row — used as cross-check anchor only' })),
    ...services.filter(r => !usedSet.has(r)).map(r => ({ category: r.extra, amount: r.amount, reason: 'Service channel — same revenue as product categories (Dine-In, Takeout, etc.)' })),
    ...products.filter(r => !usedSet.has(r)).map(r => ({ category: r.extra, amount: r.amount, reason: 'Excluded: anchor cross-check' })),
  ];
}

function _fd(v) {
  return '$' + (v || 0).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 0 });
}

// ─── PUBLIC: Parse CSV string ──────────────────────────────────────────────────
function parseCSV(content, csvType) {
  return _parseFromRaws(parseRaw(content), csvType);
}

// ─── PUBLIC: Parse file path (CSV or Excel) ───────────────────────────────────
async function parseFilePath(filePath, csvType) {
  const path = require('path');
  const ext  = path.extname(filePath).toLowerCase();

  if (ext === '.xlsx' || ext === '.xls') {
    const ExcelJS = require('exceljs');
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.readFile(filePath);
    const ws = wb.worksheets[0];
    if (!ws) throw new Error('No worksheets found in Excel file');
    const rawRows = [];
    ws.eachRow({ includeEmpty: false }, (row) => {
      rawRows.push(row.values.slice(1).map(v => {
        if (v == null) return '';
        if (v instanceof Date) return v.toISOString().slice(0, 10);
        if (typeof v === 'object') {
          if (v.result != null) return String(v.result);
          if (v.text   != null) return v.text;
          if (v.richText)       return v.richText.map(t => t.text).join('');
          return '';
        }
        return String(v);
      }));
    });
    return _parseFromRaws(rawRows, csvType);
  }

  const fs      = require('fs');
  const content = fs.readFileSync(filePath, 'utf8');
  return parseCSV(content, csvType);
}

// ─── INTERNAL: parse from raw rows ───────────────────────────────────────────
function _parseFromRaws(rawRows, csvType) {

  if (csvType === 'pos') {
    const normaliseResult = normalise(rawRows,
      ['category','type','revenue type','location','source','item','department','menu category'], 'Sales');
    const { rows, layout } = normaliseResult;

    const { used, strategy, warning, excluded, options: srOptions,
            conflict: srConflict, conflictMessage: srMsg, selectedId: srSel } = selectRevenue(rows);

    const productBd = normaliseResult.productBreakdown;
    const paymentBd = normaliseResult.paymentBreakdown;

    // For chart display: prefer product breakdown (food/alcohol) over raw row extras.
    // Canonicalize all keys so 'beer_sales', 'BEER', 'Beer Revenue' → 'Beer'.
    const byCategory = {};
    if (productBd && Object.keys(productBd).length > 0) {
      for (const [k, v] of Object.entries(productBd)) {
        const canon = canonicalizeCategory(k, 'revenue');
        byCategory[canon] = (byCategory[canon] || 0) + v;
      }
    } else {
      for (const r of used) {
        const canon = canonicalizeCategory(r.extra, 'revenue');
        byCategory[canon] = (byCategory[canon] || 0) + r.amount;
      }
    }
    const anchorTotal = used.reduce((s, r) => s + r.amount, 0);

    // ── Wide-layout conflict check ──────────────────────────────────────────
    // Wide-layout cross-check is no longer needed: the new wide handler emits rows
    // with product category names (Food, Alcohol, Other) so total = gross_sales and
    // revenueSplits is meaningful without any conflict resolution.
    let conflict = srConflict, conflictMessage = srMsg,
        selectedId = srSel, options = srOptions, finalUsed = used;

    if (!srConflict && anchorTotal > 0 && normaliseResult.layout !== 'wide') {
      const prodBdTotal = Object.values(productBd || {}).reduce((a, v) => a + v, 0);
      const payBdTotal  = Object.values(paymentBd  || {}).reduce((a, v) => a + v, 0);
      const CAT_T = 0.03, PAY_T = 0.03;
      const catR = prodBdTotal > 0 ? prodBdTotal / anchorTotal : 0;
      const payR = payBdTotal  > 0 ? payBdTotal  / anchorTotal : 0;
      const catC = prodBdTotal > 0 && Math.abs(catR - 1) > CAT_T;
      const payC = payBdTotal  > 0 && Math.abs(payR - 1) > PAY_T;

      if (catC || payC) {
        conflict = true;
        const parts = [];
        if (catC) {
          const sign = catR > 1 ? '+' : '';
          const pct = ((catR - 1) * 100).toFixed(1);
          parts.push('Product categories (' + _fd(prodBdTotal) + ') differ by ' + sign + pct + '%');
        }
        if (payC) {
          const sign = payR > 1 ? '+' : '';
          const pct = ((payR - 1) * 100).toFixed(1);
          parts.push('Payment methods (' + _fd(payBdTotal) + ') differ by ' + sign + pct + '%');
        }
        const anchorLabel = used[0] ? used[0].extra : 'Revenue';
        conflictMessage = anchorLabel + ' states ' + _fd(anchorTotal) + '. ' +
          parts.join('; ') + '. ' +
          'Average has been pre-selected. Choose which figure to use below.';

        // Build options with scaled anchor rows so dates are always preserved
        const scaleRows = (scale) =>
          used.map(r => ({ ...r, amount: r.amount * scale, extra: 'Average (flagged for review)' }));

        options = [];
        options.push({
          id: 'anchor',
          label: anchorLabel + ' — stated total',
          amount: anchorTotal,
          rows: used,
        });

        // For the comparison view, prefer the CONFLICTING breakdown so the average is meaningful.
        // If payments conflict but categories match, use payment total as the basis.
        // If categories conflict, use category total.
        const altTotal = (payC && !catC) ? payBdTotal
                       : (prodBdTotal > 0 ? prodBdTotal : payBdTotal);
        const altLabel = (payC && !catC) ? 'Payment method sum'
                       : (prodBdTotal > 0 ? 'Product category breakdown' : 'Payment method sum');
        if (altTotal > 0) {
          // 'categories' option: scale anchor rows to category total (preserves dates)
          options.push({
            id: 'categories',
            label: altLabel,
            amount: altTotal,
            rows: used.map(r => ({ ...r, amount: r.amount * (altTotal / anchorTotal), extra: altLabel })),
          });
        }
        if (payBdTotal > 0 && prodBdTotal > 0) {
          // Also show payment option separately when both exist
          options.push({
            id: 'payments',
            label: 'Payment method sum (Cash + Card)',
            amount: payBdTotal,
            rows: used.map(r => ({ ...r, amount: r.amount * (payBdTotal / anchorTotal), extra: 'Payment sum' })),
          });
        }
        const avgBase = altTotal > 0 ? altTotal : payBdTotal;
        const avg = (anchorTotal + avgBase) / 2;
        options.push({
          id: 'average',
          label: '⚑ Average of stated total & ' + (prodBdTotal > 0 ? 'categories' : 'payments') + ' — flagged for review',
          amount: avg,
          rows: scaleRows(avg / anchorTotal),
        });

        // Default to average
        const avgOpt = options.find(o => o.id === 'average');
        finalUsed = avgOpt ? avgOpt.rows : used;
        selectedId = 'average';
      }
    }

    const total = finalUsed.reduce((s, r) => s + r.amount, 0);

    return {
      rows: finalUsed.map(r => ({ date: r.date, amount: r.amount, category: canonicalizeCategory(r.extra, 'revenue') })),
      paymentBreakdown: paymentBd || null,
      // Date range from the original anchor rows (before conflict scaling) for period detection
      dateRange: used.length ? {
        start: used.map(r => r.date).filter(Boolean).sort()[0] || null,
        end:   used.map(r => r.date).filter(Boolean).sort().slice(-1)[0] || null,
      } : null,
      preview: {
        layout, count: finalUsed.length, byCategory, total,
        audit: {
          note: strategy, warning: conflict ? conflictMessage : (warning || null),
          excluded, rows_before_filter: rows.filter(r => r.amount > 0).length,
        },
        revenueConflict: conflict ? {
          conflict: true,
          message: conflictMessage,
          selectedId,
          options: options.map(o => ({ id: o.id, label: o.label, amount: o.amount })),
          optionRows: options.reduce((acc, o) => {
            acc[o.id] = o.rows.map(r => ({ date: r.date, amount: r.amount, category: r.extra }));
            return acc;
          }, {}),
        } : null,
      },
    };
  }

  if (csvType === 'payroll') {
    // Prefer gross pay columns — that's the actual labor cost before employee withholdings.
    // Net pay understates real payroll expense since it excludes employee tax withholdings.
    const { rows, layout } = normalise(rawRows,
      ['employee','name','employee name','staff','worker','team member'], 'Staff',
      [
        'gross pay','gross wages','gross earnings','gross compensation',
        'total gross','total gross wages','total gross pay',
        'total labor cost','total labour cost',
        'total pay','total wages','total compensation',
        'gross',
        'reg labor cost','reg labour cost',
        'wages','wage','compensation',
      ]);

    const processed = rows.map(r => ({ ...r, amount: Math.abs(r.amount) })).filter(r => r.amount > 0);
    const byEmployee = {};
    for (const r of processed) byEmployee[r.extra] = (byEmployee[r.extra] || 0) + r.amount;
    return {
      rows: processed.map(r => ({ date: r.date, amount: r.amount, employee: r.extra })),
      preview: { layout, count: processed.length, byEmployee, total: processed.reduce((s, r) => s + r.amount, 0) },
    };
  }

  if (csvType === 'expenses') {
    // Try category column first; if values are all generic labels (Fixed/Variable/Expense/Other),
    // fall back to merchant/vendor/description for a meaningful display name.
    const GENERIC_CATS = /^(fixed|variable|expense|other|misc|miscellaneous|operating|cost|debit|charge|payment)$/i;
    let normaliseResult = normalise(rawRows,
      ['category','type','expense type','account','gl account'], 'Other');
    let { rows, layout } = normaliseResult;

    // Check if the chosen extra column is too generic — if >60% of rows have generic values,
    // try to find a more descriptive column (merchant, vendor, description, payee, name).
    const nonEmpty = rows.filter(r => r.extra && r.extra !== 'Other');
    const genericCount = nonEmpty.filter(r => GENERIC_CATS.test(r.extra)).length;
    if (nonEmpty.length > 0 && genericCount / nonEmpty.length > 0.6) {
      const hiAlt = findHeaderRow(rawRows);
      const hdrs  = rawRows[hiAlt].map(h => String(h).toLowerCase().trim());
      const SPECIFIC_COLS = ['merchant','vendor','payee','description','name','expense name','memo'];
      const specificIdx = SPECIFIC_COLS.reduce((found, kw) => {
        if (found >= 0) return found;
        const exact = hdrs.indexOf(kw);
        if (exact >= 0) return exact;
        return hdrs.findIndex(h => h.includes(kw));
      }, -1);

      if (specificIdx >= 0) {
        // Re-normalise preferring the specific column for extra, but keep original classification
        const altResult = normalise(rawRows,
          [rawRows[hiAlt][specificIdx], 'category','type','account'], 'Other');
        // Merge: use alt extra (display name) but keep original category for classification hint
        const origExtraByIdx = {};
        rows.forEach((r, i) => { origExtraByIdx[i] = r.extra; });
        rows = altResult.rows.map((r, i) => ({
          ...r,
          extra: r.extra || origExtraByIdx[i] || 'Other',
          _classHint: origExtraByIdx[i] || r.extra, // preserve generic label for classification
        }));
        layout = altResult.layout;
      }
    }

    // Keep negative amounts (vendor credits, returns) — they net down the bucket.
    // Only drop true zero-amount rows (test entries, blank lines).
    const nonZero = rows.filter(r => r.amount !== 0 && r.amount != null);
    const byCategory = {};
    for (const r of nonZero) {
      const canon = canonicalizeCategory(r.extra, 'expense');
      byCategory[canon] = (byCategory[canon] || 0) + r.amount;
    }
    // For the preview total show the net (credits reduce it); drop fully-netted categories
    const previewTotal = nonZero.reduce((s, r) => s + r.amount, 0);
    return {
      rows: nonZero.map(r => {
        const displayCat = canonicalizeCategory(r.extra, 'expense');
        const classHint  = r._classHint ? canonicalizeCategory(r._classHint, 'expense') : null;
        const row = {
          date: r.date, amount: r.amount,
          category: displayCat,
          _classHint: classHint || undefined,
          description: ''
        };
        if (r.lumpSumMonth) row.lumpSumMonth = r.lumpSumMonth;
        return row;
      }),
      preview: { layout, count: nonZero.length, byCategory, total: previewTotal },
    };
  }

  if (csvType === 'bank') {
    const hi      = findHeaderRow(rawRows);
    const headers = rawRows[hi];
    const data    = rawRows.slice(hi + 1);

    // ── Inflow column synonyms ─────────────────────────────────────────────
    // Covers: standard bank exports, QuickBooks, Square, Gusto, custom labels
    const INFLOW_SYNONYMS = [
      'credit','credits','deposit','deposits',
      'money in','cash in','inflow','inflows',
      'amount in','amount credited','paid in','received',
      'proceeds','receipts','income','revenue',
      'deposit amount','credit amount',
      'money_in','cash_in','amount_in','inflow','credit_amount',
    ];

    // ── Outflow column synonyms ────────────────────────────────────────────
    // "operating expenses" is the key one that was missing before
    const OUTFLOW_SYNONYMS = [
      'debit','debits','withdrawal','withdrawals',
      'money out','cash out','outflow','outflows',
      'amount out','amount debited','paid out',
      'expense','expenses','operating expense','operating expenses',
      'operating costs','disbursement','disbursements',
      'payment','payments','charge','charges',
      'checks','checks written','check amount',
      'fees','fees paid','debit amount','withdrawal amount',
      'purchases','purchase amount',
      'money_out','cash_out','amount_out','outflow','debit_amount','withdrawal_amount',
    ];

    const crIdx  = findCol(headers, INFLOW_SYNONYMS);
    const drIdx  = findCol(headers, OUTFLOW_SYNONYMS);
    const dtIdx  = findCol(headers, ['date','transaction date','posted date','value date','effective date','settlement date']);
    const dscIdx = findCol(headers, ['description','memo','payee','narrative','details','reference','note']);

    // ── Split-column path (preferred) ─────────────────────────────────────
    // Works when we find EITHER an inflow OR outflow column (not requiring both)
    if (crIdx >= 0 || drIdx >= 0) {
      const rows = data.map(row => {
        const inAmt  = crIdx >= 0 ? toNum(row[crIdx]) : 0;
        const outAmt = drIdx >= 0 ? Math.abs(toNum(row[drIdx])) : 0;
        // If only one column found: inflow col → positive, outflow col → negative
        const amount = inAmt - outAmt;
        return {
          date:        dtIdx  >= 0 ? row[dtIdx]  : null,
          amount,
          description: dscIdx >= 0 ? row[dscIdx] : '',
        };
      }).filter(r => r.amount !== 0);
      const layout = (crIdx >= 0 && drIdx >= 0) ? 'split_credit_debit'
                   : crIdx >= 0 ? 'inflow_only' : 'outflow_only';
      return {
        rows,
        preview: {
          layout, count: rows.length,
          totalIn:  rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0),
          totalOut: rows.filter(r => r.amount < 0).reduce((s, r) => s + Math.abs(r.amount), 0),
        },
      };
    }

    // ── Single-amount fallback ─────────────────────────────────────────────
    // No named inflow/outflow columns — look for a single amount column
    // Positive = inflow, negative = outflow (common in many bank exports)
    const amtIdx = findCol(headers, ['amount','transaction amount','net amount','balance change']);
    if (amtIdx >= 0) {
      const rows = data.map(row => ({
        date:        dtIdx  >= 0 ? row[dtIdx]  : null,
        amount:      toNum(row[amtIdx]),
        description: dscIdx >= 0 ? row[dscIdx] : '',
      })).filter(r => r.amount !== 0);
      return {
        rows,
        preview: {
          layout: 'single_amount', count: rows.length,
          totalIn:  rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0),
          totalOut: rows.filter(r => r.amount < 0).reduce((s, r) => s + Math.abs(r.amount), 0),
        },
      };
    }

    // ── Last resort: normalise ─────────────────────────────────────────────
    const { rows, layout } = normalise(rawRows, ['description','memo','payee','narrative'], '');
    return {
      rows: rows.map(r => ({ date: r.date, amount: r.amount, description: r.extra })),
      preview: {
        layout, count: rows.length,
        totalIn:  rows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0),
        totalOut: rows.filter(r => r.amount < 0).reduce((s, r) => s + Math.abs(r.amount), 0),
      },
    };
  }

  throw new Error('Unknown csvType: ' + csvType);
}

module.exports = { parseCSV, parseFilePath, classifyPOS, isSummaryRow };
