/**
 * SandCastle — Web API
 * ─────────────────────────────────────────────────────────────────────────────
 * Implements the same window.api interface as preload.js but runs entirely in
 * the browser.  No Electron, no Node, no server.
 *
 * In Electron, preload.js sets window.api via contextBridge BEFORE this bundle
 * loads. The guard at the bottom detects this and exits without overwriting it,
 * so the desktop app's native IPC always wins.
 *
 * Storage  : IndexedDB (database "sandcastle", object store "periods")
 * Parsing  : src/parser.js + src/calculations.js (bundled by esbuild)
 * Excel in : SheetJS (xlsx global from CDN)
 * Excel out: SheetJS workbook → Blob → browser download
 * CSV out  : Blob → browser download
 */

'use strict';

const { parseCSV }                    = require('../../src/parser');
const { calculateMetrics, runWhatIf } = require('../../src/calculations');

// ── IndexedDB helpers ────────────────────────────────────────────────────────
const DB_NAME    = 'sandcastle';
const DB_VERSION = 1;
const STORE      = 'periods';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const db = e.target.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta');
      }
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror   = e => reject(e.target.error);
  });
}

function req2p(r) {
  return new Promise((res, rej) => {
    r.onsuccess = e => res(e.target.result);
    r.onerror   = e => rej(e.target.error);
  });
}

// ── Parse helpers ────────────────────────────────────────────────────────────

function parseExcelBuffer(buffer, csvType) {
  const wb  = XLSX.read(new Uint8Array(buffer), { type: 'array', cellText: true, cellDates: true });
  const ws  = wb.Sheets[wb.SheetNames[0]];
  const raw = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '', raw: false });
  const csvStr = raw.map(row => row.map(c => {
    const s = String(c == null ? '' : c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  return parseCSV(csvStr, csvType);
}

function parseAnyBuffer(buffer, filename, csvType) {
  const ext = (filename.match(/\.([^.]+)$/) || ['', ''])[1].toLowerCase();
  if (ext === 'xlsx' || ext === 'xls') {
    return parseExcelBuffer(buffer, csvType);
  }
  const text = new TextDecoder('utf-8').decode(new Uint8Array(buffer));
  return parseCSV(text, csvType);
}

// ── Metrics helpers ──────────────────────────────────────────────────────────

function daysInRange(ds, de) {
  if (!ds || !de) return 30;
  return Math.round((new Date(de) - new Date(ds)) / 86400000) + 1;
}

function getGroupLabel(p, viewBy) {
  if (viewBy === 'All Time') return 'All Time';
  if (viewBy === 'Monthly')  return p.label || '';
  if (viewBy === 'Quarterly') {
    if (!p.date_start) return p.label || '';
    const d = new Date(p.date_start + 'T12:00:00Z');
    const q = Math.ceil((d.getUTCMonth() + 1) / 3);
    return 'Q' + q + ' ' + d.getUTCFullYear();
  }
  if (viewBy === 'Yearly') {
    if (!p.date_start) return p.label || '';
    return String(new Date(p.date_start + 'T12:00:00Z').getUTCFullYear());
  }
  return p.label || '';
}

function aggregatePeriods(periods) {
  if (!periods.length) return null;
  const sum = k => periods.reduce((s, p) => s + (p[k] || 0), 0);
  const revMap = {}, expMap = {};
  periods.forEach(p => {
    (p.revenueSplits || []).forEach(s => { revMap[s.category] = (revMap[s.category] || 0) + s.amount; });
    (p.expenseCats   || []).forEach(s => { expMap[s.category] = (expMap[s.category] || 0) + s.amount; });
  });
  const total_revenue  = sum('total_revenue');
  const total_payroll  = sum('total_payroll');
  const total_material = sum('total_material');
  const total_fixed    = sum('total_fixed');
  const total_variable = sum('total_variable');
  const prime_cost     = total_payroll + total_material;
  const total_expenses = total_fixed + total_variable + prime_cost;
  const profit         = total_revenue - total_expenses;
  const contrib        = total_revenue > 0 ? (total_variable + prime_cost) / total_revenue : 1;
  const bank_in        = sum('bank_in');
  const bank_out       = sum('bank_out');
  const seen = new Set(), mergedWarnings = [];
  periods.forEach(p => (p.data_warnings || []).forEach(w => {
    if (!seen.has(w.code)) { seen.add(w.code); mergedWarnings.push(w); }
  }));
  return {
    total_revenue, total_payroll, total_material, total_fixed, total_variable,
    prime_cost, total_expenses, profit,
    profit_margin:  total_revenue > 0 ? profit / total_revenue * 100 : null,
    prime_pct:      total_revenue > 0 ? prime_cost / total_revenue * 100 : null,
    break_even:     (total_revenue > 0 && contrib < 0.99) ? total_fixed / (1 - contrib) : null,
    bank_in, bank_out,
    revenueSplits:  Object.entries(revMap).map(([category, amount]) => ({ category, amount })),
    paymentSplits:  [],
    expenseCats:    Object.entries(expMap).map(([category, amount]) => ({ category, amount })),
    dataWarnings:   mergedWarnings,
  };
}

// ── Period CRUD ──────────────────────────────────────────────────────────────

async function dbGetAllPeriods() {
  const db = await openDB();
  const periods = await req2p(db.transaction(STORE, 'readonly').objectStore(STORE).getAll());
  db.close();
  return periods.sort((a, b) => (a.date_start || '').localeCompare(b.date_start || ''));
}

async function dbSavePeriod(record) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t   = db.transaction([STORE, 'meta'], 'readwrite');
    const st  = t.objectStore(STORE);
    const mt  = t.objectStore('meta');
    t.onerror = e => reject(e.target.error);
    const idReq = mt.get('nextId');
    idReq.onsuccess = e => {
      const id = ((e.target.result || 0) + 1);
      mt.put(id, 'nextId');
      record.id = id;
      st.add(record);
      t.oncomplete = () => { db.close(); resolve(id); };
    };
  });
}

async function dbPatchPeriod(id, metrics) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t  = db.transaction(STORE, 'readwrite');
    const st = t.objectStore(STORE);
    t.onerror = e => reject(e.target.error);
    const gr = st.get(id);
    gr.onsuccess = e => {
      const period = e.target.result;
      if (!period) { reject(new Error('Period ' + id + ' not found')); return; }
      Object.assign(period, metrics);
      if (metrics.bank_in  !== undefined) period.bank_in  = metrics.bank_in;
      if (metrics.bank_out !== undefined) period.bank_out = metrics.bank_out;
      st.put(period);
      t.oncomplete = () => { db.close(); resolve(true); };
    };
  });
}

async function dbDeletePeriod(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, 'readwrite');
    t.onerror = e => reject(e.target.error);
    t.objectStore(STORE).delete(id);
    t.oncomplete = () => { db.close(); resolve(true); };
  });
}

// ── Metrics ──────────────────────────────────────────────────────────────────

async function getFilteredMetrics(viewBy, periodLabel) {
  const periods = await dbGetAllPeriods();
  if (!periods.length) return {};
  if (viewBy === 'All Time' || periodLabel === 'All Time') {
    return aggregatePeriods(periods) || {};
  }
  const labels = [...new Set(periods.map(p => getGroupLabel(p, viewBy)))].sort();
  if (periodLabel === 'Average') {
    const agg = aggregatePeriods(periods);
    if (!agg) return {};
    const n = labels.filter(l => l !== 'Average').length || 1;
    return { ...agg,
      total_revenue:  agg.total_revenue  / n,
      total_payroll:  agg.total_payroll  / n,
      total_material: agg.total_material / n,
      total_fixed:    agg.total_fixed    / n,
      total_variable: agg.total_variable / n,
      prime_cost:     agg.prime_cost     / n,
      total_expenses: agg.total_expenses / n,
      profit:         agg.profit         / n,
      bank_in:        agg.bank_in        / n,
      bank_out:       agg.bank_out       / n,
    };
  }
  const matched = periods.filter(p => getGroupLabel(p, viewBy) === periodLabel);
  return (matched.length ? aggregatePeriods(matched) : aggregatePeriods(periods)) || {};
}

async function getPeriodLabels(viewBy) {
  const periods = await dbGetAllPeriods();
  if (viewBy === 'All Time') return ['All Time'];
  const labels = [...new Set(periods.map(p => getGroupLabel(p, viewBy)))].sort();
  if (labels.length > 1) labels.push('Average');
  return labels;
}

// ── savePeriod — mirrors main.js logic (splitting multi-month uploads) ───────

function _calcMetrics(payload) {
  return calculateMetrics(payload);
}

async function savePeriod(payload) {
  const allRows = [
    ...(payload.posRows     || []),
    ...(payload.payrollRows || []),
    ...(payload.expenseRows || []),
  ];
  const monthKeys = [...new Set(allRows.filter(r => r.date).map(r => r.date.slice(0, 7)))].sort();

  if (monthKeys.length <= 1) {
    const metrics = _calcMetrics(payload);
    const bankRows  = payload.bankRows || [];
    metrics.bankIn  = bankRows.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
    metrics.bankOut = bankRows.filter(r => r.amount < 0).reduce((s, r) => s + Math.abs(r.amount), 0);
    const id = await dbSavePeriod({
      label:          payload.label,
      period_type:    payload.periodType || 'manual',
      date_start:     payload.dateStart || null,
      date_end:       payload.dateEnd   || null,
      days_in_period: daysInRange(payload.dateStart, payload.dateEnd),
      added_on:       new Date().toISOString().slice(0, 10),
      data_warnings:  payload.dataWarnings || [],
      bank_in:        metrics.bankIn  || 0,
      bank_out:       metrics.bankOut || 0,
      total_revenue:  metrics.total_revenue,
      total_payroll:  metrics.total_payroll,
      total_material: metrics.total_material,
      total_fixed:    metrics.total_fixed,
      total_variable: metrics.total_variable,
      prime_cost:     metrics.prime_cost,
      total_expenses: metrics.total_expenses,
      profit:         metrics.profit,
      profit_margin:  metrics.profit_margin,
      prime_pct:      metrics.prime_pct,
      break_even:     metrics.break_even,
      revenueSplits:  Object.entries(metrics.revenueBySplit || {}).map(([category, amount]) => ({ category, amount })),
      expenseCats:    Object.entries(metrics.expenseByCat   || {}).map(([category, amount]) => ({ category, amount })),
    });
    return { ok: true, id, metrics };
  }

  // Multi-month: split into one record per month
  const savedIds = [];
  for (const ym of monthKeys) {
    const [yr, mo] = ym.split('-').map(Number);
    const monthStart = `${yr}-${String(mo).padStart(2,'0')}-01`;
    const lastDay    = new Date(yr, mo, 0).getDate();
    const monthEnd   = `${yr}-${String(mo).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
    const monthLabel = new Date(monthStart + 'T12:00:00Z')
      .toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

    const posSlice     = (payload.posRows     || []).filter(r => r.date && r.date.startsWith(ym));
    const payrollSlice = (payload.payrollRows || []).filter(r => r.date && r.date.startsWith(ym));
    const expSlice     = (payload.expenseRows || []).filter(r => r.date && r.date.startsWith(ym));
    const bankSlice    = (payload.bankRows    || []).filter(r => r.date && r.date.startsWith(ym));

    const monthPayload = { ...payload, label: monthLabel, periodType: 'monthly',
      dateStart: monthStart, dateEnd: monthEnd,
      posRows: posSlice, payrollRows: payrollSlice, expenseRows: expSlice };
    const metrics = _calcMetrics(monthPayload);
    metrics.bankIn  = bankSlice.filter(r => r.amount > 0).reduce((s, r) => s + r.amount, 0);
    metrics.bankOut = bankSlice.filter(r => r.amount < 0).reduce((s, r) => s + Math.abs(r.amount), 0);

    const id = await dbSavePeriod({
      label: monthLabel, period_type: 'monthly',
      date_start: monthStart, date_end: monthEnd,
      days_in_period: daysInRange(monthStart, monthEnd),
      added_on: new Date().toISOString().slice(0, 10),
      data_warnings: payload.dataWarnings || [],
      bank_in: metrics.bankIn || 0, bank_out: metrics.bankOut || 0,
      total_revenue: metrics.total_revenue, total_payroll: metrics.total_payroll,
      total_material: metrics.total_material, total_fixed: metrics.total_fixed,
      total_variable: metrics.total_variable, prime_cost: metrics.prime_cost,
      total_expenses: metrics.total_expenses, profit: metrics.profit,
      profit_margin: metrics.profit_margin, prime_pct: metrics.prime_pct,
      break_even: metrics.break_even,
      revenueSplits: Object.entries(metrics.revenueBySplit || {}).map(([category, amount]) => ({ category, amount })),
      expenseCats:   Object.entries(metrics.expenseByCat   || {}).map(([category, amount]) => ({ category, amount })),
    });
    savedIds.push(id);
  }
  return { ok: true, ids: savedIds, split: true, monthCount: monthKeys.length };
}

// ── What-If ──────────────────────────────────────────────────────────────────

function runWhatIfBrowser(payload) {
  return runWhatIf(payload);
}

// ── Export helpers ───────────────────────────────────────────────────────────

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a   = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click();
  setTimeout(() => { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1000);
}

function exportCSVBrowser(payload) {
  const ps = payload.periods || [];
  const rows = [
    ['Period', 'Revenue', 'Payroll', 'Material', 'Fixed', 'Variable', 'Prime Cost', 'Total Expenses', 'Profit', 'Profit Margin %', 'Prime Cost %', 'Break-Even'],
    ...ps.map(p => [
      p.label || '', p.total_revenue || 0, p.total_payroll || 0, p.total_material || 0,
      p.total_fixed || 0, p.total_variable || 0, p.prime_cost || 0, p.total_expenses || 0,
      p.profit || 0, p.profit_margin != null ? p.profit_margin.toFixed(1) : '',
      p.prime_pct != null ? p.prime_pct.toFixed(1) : '',
      p.break_even != null ? p.break_even.toFixed(0) : '',
    ]),
  ];
  const csv = rows.map(r => r.map(c => {
    const s = String(c == null ? '' : c);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(',')).join('\n');
  downloadBlob(new Blob([csv], { type: 'text/csv' }), 'sandcastle-report.csv');
  return { ok: true };
}

function exportExcelBrowser(payload) {
  const ps = payload.periods || [];
  const wb = XLSX.utils.book_new();
  const headers = ['Period','Revenue','Payroll','Material','Fixed','Variable','Prime Cost','Total Expenses','Profit','Margin %','Prime Cost %','Break-Even'];
  const data = [headers, ...ps.map(p => [
    p.label || '', p.total_revenue || 0, p.total_payroll || 0, p.total_material || 0,
    p.total_fixed || 0, p.total_variable || 0, p.prime_cost || 0, p.total_expenses || 0,
    p.profit || 0,
    p.profit_margin != null ? +(p.profit_margin.toFixed(2)) : '',
    p.prime_pct     != null ? +(p.prime_pct.toFixed(2))     : '',
    p.break_even    != null ? +(p.break_even.toFixed(0))     : '',
  ])];
  const ws = XLSX.utils.aoa_to_sheet(data);
  XLSX.utils.book_append_sheet(wb, ws, 'SandCastle Report');
  const buf = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  downloadBlob(new Blob([buf], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), 'sandcastle-report.xlsx');
  return { ok: true };
}

// ── Expose window.api ────────────────────────────────────────────────────────
// Guard: in Electron, preload.js sets window.api via contextBridge before this
// bundle loads. If it's already set, skip entirely — the desktop app's native
// IPC handles everything and we must not overwrite it.

if (!window.api) {
  window.api = {
    // pickCSV / pickFolder: not available in browser — renderer falls back to
    // the visible file-picker <input> elements instead.
    pickCSV:    () => Promise.resolve({ canceled: true }),
    pickFolder: () => Promise.resolve({ canceled: true }),

    parseBuffer: (buffer, filename, csvType) => {
      try {
        const result = parseAnyBuffer(buffer, filename, csvType);
        return Promise.resolve({ ok: true, filename, ...result });
      } catch(e) {
        return Promise.resolve({ error: e.message });
      }
    },

    savePeriod:      (payload)             => savePeriod(payload).catch(e => ({ error: e.message })),
    getPeriods:      ()                    => dbGetAllPeriods().catch(() => []),
    getCumulative:   async ()              => { const p = await dbGetAllPeriods(); return aggregatePeriods(p) || {}; },
    getMetrics:      ({ viewBy, period })  => getFilteredMetrics(viewBy, period).catch(() => ({})),
    getPeriodLabels: (viewBy)              => getPeriodLabels(viewBy).catch(() => []),
    deletePeriod:    (id)                  => dbDeletePeriod(id).then(() => ({ ok: true })).catch(e => ({ error: e.message })),
    patchPeriod:     (payload)             => dbPatchPeriod(payload.id, payload.metrics).then(() => ({ ok: true })).catch(e => ({ error: e.message })),

    whatIf: (payload) => {
      try { return Promise.resolve(runWhatIfBrowser(payload)); }
      catch(e) { return Promise.resolve({ error: e.message }); }
    },

    exportExcel: (payload) => {
      try { return Promise.resolve(exportExcelBrowser(payload)); }
      catch(e) { return Promise.resolve(exportCSVBrowser(payload)); }
    },

    exportCSV: (payload) => {
      try { return Promise.resolve(exportCSVBrowser(payload)); }
      catch(e) { return Promise.resolve({ error: e.message }); }
    },
  };

  // Notify the app that the web API is ready
  window.dispatchEvent(new Event('sc-api-ready'));
}