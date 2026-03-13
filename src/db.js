/**
 * Local data storage using a plain JSON file.
 * No native compilation needed — works on every Mac out of the box.
 *
 * Data saved to:
 *   Mac:     ~/Library/Application Support/FinancialOS/data.json
 *   Windows: %APPDATA%\FinancialOS\data.json
 */

const fs   = require('fs');
const path = require('path');
const { app } = require('electron');

let DB_PATH;
let _db = null;

function getDbPath() {
  if (!DB_PATH) {
    const dir = app.getPath('userData');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    DB_PATH = path.join(dir, 'data.json');
  }
  return DB_PATH;
}

function load() {
  if (_db) return _db;
  const p = getDbPath();
  if (fs.existsSync(p)) {
    try { _db = JSON.parse(fs.readFileSync(p, 'utf8')); }
    catch { _db = { periods: [], nextId: 1 }; }
  } else {
    _db = { periods: [], nextId: 1 };
  }
  return _db;
}

function save() {
  const p = getDbPath();
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(_db, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

function initDb() { load(); }

// ── Period date helpers ────────────────────────────────────────────────────────

/**
 * Days covered by a [dateStart, dateEnd] range, inclusive.
 * Falls back to 30 when dates are missing (matches monthly assumption elsewhere).
 */
function daysInRange(dateStart, dateEnd) {
  if (!dateStart || !dateEnd) return 30;
  const diff = (new Date(dateEnd) - new Date(dateStart)) / 86400000;
  return Math.max(1, Math.round(diff) + 1);
}

/**
 * Returns periods whose date range overlaps with [dateStart, dateEnd].
 * Pass excludeId to skip a just-saved period from flagging itself.
 */
function detectOverlaps(dateStart, dateEnd, periods, excludeId) {
  if (!dateStart || !dateEnd) return [];
  const s1 = new Date(dateStart), e1 = new Date(dateEnd);
  return periods.filter(p => {
    if (p.id === excludeId) return false;
    if (!p.date_start || !p.date_end) return false;
    const s2 = new Date(p.date_start), e2 = new Date(p.date_end);
    return s1 <= e2 && e1 >= s2;
  });
}

function savePeriod({ label, periodType, dateStart, dateEnd, metrics, fixedInputs, dataWarnings }) {
  const db = load();
  db.periods = db.periods.filter(p => p.label !== label);
  const id = db.nextId++;
  const days = daysInRange(dateStart, dateEnd);
  db.periods.push({
    id, label,
    period_type:    periodType || 'manual',
    date_start:     dateStart ? String(dateStart) : null,
    date_end:       dateEnd   ? String(dateEnd)   : null,
    days_in_period: days,
    added_on:       new Date().toISOString().slice(0, 10),
    data_warnings:  dataWarnings && dataWarnings.length ? dataWarnings : null,
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
    paymentSplits:  Object.entries(metrics.paymentBySplit || {}).map(([category, amount]) => ({ category, amount })),
    expenseCats:    Object.entries(metrics.expenseByCat   || {}).map(([category, amount]) => ({ category, amount })),
    fixedInputs:    fixedInputs || {},
  });
  db.periods.sort((a, b) => (a.date_start || '') < (b.date_start || '') ? -1 : 1);
  save();
  return id;
}

function deletePeriod(id) {
  const db = load();
  db.periods = db.periods.filter(p => p.id !== id);
  save();
}

function getAllPeriods() {
  return load().periods.map(p => {
    const days = p.days_in_period || daysInRange(p.date_start, p.date_end) || 30;
    return {
      ...p,
      days_in_period:  days,
      revenue_per_day: (p.total_revenue || 0) / days,
    };
  });
}
function getCumulative() { return aggregatePeriods(load().periods); }

function getFilteredMetrics(viewBy, periodLabel) {
  const periods = load().periods;

  // All-time / no filter
  if (!viewBy || !periodLabel || periodLabel === 'All Time' || periodLabel === 'All Periods')
    return aggregatePeriods(periods);

  // Average across all periods of this granularity
  const avgLabel = `⌀ Avg ${viewBy}`;
  if (periodLabel === avgLabel) {
    // Count distinct groups at this granularity, then divide aggregate totals
    const groups = new Set(periods.map(p => getGroupLabel(p, viewBy)));
    const n = groups.size;
    if (n === 0) return aggregatePeriods([]);
    const agg = aggregatePeriods(periods);
    // Divide all absolute money figures by number of groups; recompute ratios
    const divide = (k) => agg[k] != null ? agg[k] / n : 0;
    const tr   = divide('total_revenue');
    const tp   = divide('total_payroll');
    const tm   = divide('total_material');
    const tf   = divide('total_fixed');
    const tv   = divide('total_variable');
    const pc   = tp + tm;
    const te   = tf + tv + pc;
    const prof = tr - te;
    const trSafe = tr || 1;
    const vcRatio = (pc + tv) / trSafe;
    return {
      total_revenue:  tr,
      total_payroll:  tp,
      total_material: tm,
      total_fixed:    tf,
      total_variable: tv,
      prime_cost:     pc,
      total_expenses: te,
      profit:         prof,
      profit_margin:  tr > 0 ? prof / tr * 100 : null,
      prime_pct:      tr > 0 ? pc   / tr * 100 : null,
      break_even:     (tr > 0 && vcRatio < 0.99) ? tf / (1 - vcRatio) : null,
      revenueSplits:  (agg.revenueSplits  || []).map(s => ({ ...s, amount: s.amount / n })),
      paymentSplits:  (agg.paymentSplits  || []).map(s => ({ ...s, amount: s.amount / n })),
      expenseCats:    (agg.expenseCats    || []).map(s => ({ ...s, amount: s.amount / n })),
    };
  }

  // Specific period label
  const matched = periods.filter(p => getGroupLabel(p, viewBy) === periodLabel);
  return matched.length ? aggregatePeriods(matched) : aggregatePeriods(periods);
}

function getPeriodLabels(viewBy) {
  const seen = new Set(), labels = [];
  for (const p of load().periods) {
    const lbl = getGroupLabel(p, viewBy);
    if (!seen.has(lbl)) { seen.add(lbl); labels.push(lbl); }
  }
  // Prepend average option whenever there is any data
  if (labels.length > 0) {
    const avgLabel = `⌀ Avg ${viewBy}`;
    labels.unshift(avgLabel);
  }
  return labels;
}

function getGroupLabel(period, viewBy) {
  if (!period.date_start) return period.label;   // no date → use label as-is
  const d = new Date(period.date_start);
  if (isNaN(d)) return period.label;
  // CRITICAL: use UTC methods — date_start is stored as 'YYYY-MM-DD' which JS
  // parses as UTC midnight. Local-time methods shift dates backward in UTC-offset
  // timezones (e.g. Jan 1 → Dec 31 in US timezones), causing wrong grouping.
  if (viewBy === 'Monthly')
    return d.toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
  if (viewBy === 'Quarterly')
    return `Q${Math.floor(d.getUTCMonth() / 3) + 1} ${d.getUTCFullYear()}`;
  if (viewBy === 'Annual')
    return String(d.getUTCFullYear());
  return period.label;
}

function aggregatePeriods(periods) {
  if (!periods.length) return {
    total_revenue: 0, total_payroll: 0, total_material: 0, total_fixed: 0,
    total_variable: 0, prime_cost: 0, total_expenses: 0, profit: 0,
    profit_margin: 0, prime_pct: 0, break_even: 0, revenueSplits: [], expenseCats: [],
  };
  const sum = key => periods.reduce((acc, p) => acc + (p[key] || 0), 0);
  const revMap = {}, payMap = {}, expMap = {};
  for (const p of periods) {
    for (const { category, amount } of (p.revenueSplits || []))
      revMap[category] = (revMap[category] || 0) + amount;
    for (const { category, amount } of (p.paymentSplits || []))
      payMap[category] = (payMap[category] || 0) + amount;
    for (const { category, amount } of (p.expenseCats || []))
      expMap[category] = (expMap[category] || 0) + amount;
  }
  const total_revenue = sum('total_revenue'), total_payroll = sum('total_payroll'),
        total_material = sum('total_material'), total_fixed = sum('total_fixed'),
        total_variable = sum('total_variable');
  const prime_cost = total_payroll + total_material;
  const total_expenses = total_fixed + total_variable + prime_cost;
  const profit = total_revenue - total_expenses;
  const contrib = total_revenue > 0 ? (total_variable + prime_cost) / total_revenue : 1;
  const bank_in  = periods.reduce((s, p) => s + (p.bank_in  || 0), 0);
  const bank_out = periods.reduce((s, p) => s + (p.bank_out || 0), 0);
  return {
    total_revenue, total_payroll, total_material, total_fixed, total_variable,
    prime_cost, total_expenses, profit,
    profit_margin: total_revenue > 0 ? profit / total_revenue * 100 : null,
    prime_pct:     total_revenue > 0 ? prime_cost / total_revenue * 100 : null,
    break_even:    (total_revenue > 0 && contrib < 0.99) ? total_fixed / (1 - contrib) : null,
    bank_in, bank_out,
    revenueSplits: Object.entries(revMap).map(([category, amount]) => ({ category, amount })),
    paymentSplits: Object.entries(payMap).map(([category, amount]) => ({ category, amount })),
    expenseCats:   Object.entries(expMap).map(([category, amount]) => ({ category, amount })),
    // Merge unique warnings from all included periods so the dashboard can display them
    dataWarnings: (function() {
      const seen = new Set(), merged = [];
      for (const p of periods) {
        for (const w of (p.data_warnings || [])) {
          if (!seen.has(w.code)) { seen.add(w.code); merged.push(w); }
        }
      }
      return merged.length ? merged : null;
    })(),
  };
}

function patchPeriod(id, metrics) {
  const db = load();
  const period = db.periods.find(p => p.id === id);
  if (!period) throw new Error('Period ' + id + ' not found');
  // Overwrite only the metric fields provided
  Object.assign(period, {
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
  });
  // Bank fields are patched independently (bank upload / zero-out)
  if (metrics.bank_in  !== undefined) period.bank_in  = metrics.bank_in;
  if (metrics.bank_out !== undefined) period.bank_out = metrics.bank_out;
  if (metrics.revenueBySplit !== null && metrics.revenueBySplit !== undefined) {
    period.revenueSplits = Object.entries(metrics.revenueBySplit).map(([category, amount]) => ({ category, amount }));
  }
  save();
  return id;
}

// ── MIGRATION: re-split any multi-month period into monthly sub-records ────────
// Called once on startup from main.js. Safe to call multiple times — skips
// periods that are already <= 35 days.
function migrateMultiMonthPeriods() {
  const db = load();
  let changed = false;
  const kept = [];

  for (const period of db.periods) {
    const ds = period.date_start, de = period.date_end;
    if (!ds || !de) { kept.push(period); continue; }

    const spanDays = (new Date(de) - new Date(ds)) / 86400000;
    if (spanDays <= 35) { kept.push(period); continue; }

    // Period spans multiple months — split into monthly sub-records
    // We don't have the original row-level data anymore, so we'll split by
    // estimating each month's share proportionally by days in that month.
    changed = true;
    const start = new Date(ds + 'T12:00:00Z');
    const end   = new Date(de + 'T12:00:00Z');

    // Collect all months in range
    const months = [];
    let cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
    while (cur <= end) {
      months.push({ yr: cur.getUTCFullYear(), mo: cur.getUTCMonth() });
      cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 1, 1));
    }
    const n = months.length;

    for (const { yr, mo } of months) {
      const mStart = `${yr}-${String(mo+1).padStart(2,'0')}-01`;
      const lastDay = new Date(Date.UTC(yr, mo+1, 0)).getUTCDate();
      const mEnd   = `${yr}-${String(mo+1).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;
      const label  = new Date(mStart + 'T12:00:00Z')
        .toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

      // Scale every numeric metric by 1/n
      const scale = (v) => typeof v === 'number' ? v / n : v;
      const newPeriod = {
        id:             db.nextId++,
        label,
        period_type:    'monthly',
        date_start:     mStart,
        date_end:       mEnd,
        added_on:       period.added_on,
        total_revenue:  scale(period.total_revenue),
        total_payroll:  scale(period.total_payroll),
        total_material: scale(period.total_material),
        total_fixed:    scale(period.total_fixed),
        total_variable: scale(period.total_variable),
        prime_cost:     scale(period.prime_cost),
        total_expenses: scale(period.total_expenses),
        profit:         scale(period.profit),
        profit_margin:  period.profit_margin,   // ratio — don't scale
        prime_pct:      period.prime_pct,        // ratio — don't scale
        break_even:     scale(period.break_even),
        revenueSplits:  (period.revenueSplits || []).map(s => ({ ...s, amount: s.amount / n })),
        paymentSplits:  (period.paymentSplits || []).map(s => ({ ...s, amount: s.amount / n })),
        expenseCats:    (period.expenseCats   || []).map(s => ({ ...s, amount: s.amount / n })),
        fixedInputs:    Object.fromEntries(
          Object.entries(period.fixedInputs || {}).map(([k,v]) => [k, (v||0)/n])
        ),
      };
      kept.push(newPeriod);
    }
  }

  if (changed) {
    db.periods = kept.sort((a, b) => (a.date_start || '') < (b.date_start || '') ? -1 : 1);
    save();
    console.log('[db] Migrated multi-month periods into monthly records.');
  }
}

module.exports = { initDb, savePeriod, patchPeriod, deletePeriod, getAllPeriods, getCumulative, getFilteredMetrics, getPeriodLabels, migrateMultiMonthPeriods, detectOverlaps, daysInRange };