const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs   = require('fs');

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width:  1280,
    height: 820,
    minWidth:  960,
    minHeight: 620,
    titleBarStyle: 'hiddenInset',
    vibrancy: 'under-window',
    visualEffectState: 'active',
    backgroundColor: '#09090E',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload:          path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration:  false,
      sandbox:          true,    // renderer runs in OS sandbox — preload only needs contextBridge + ipcRenderer
      webSecurity:      true,    // explicit — blocks cross-origin requests from renderer
    },
    show: false,
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'deskindex.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());

  // Only open https:// URLs externally — block file://, javascript:, data: etc.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https://') || url.startsWith('http://')) {
      shell.openExternal(url);
    }
    return { action: 'deny' };
  });

  // Prevent renderer from navigating away from the local HTML file
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const localFile = 'file://' + path.join(__dirname, 'renderer', 'deskindex.html').replace(/\\/g, '/');
    if (url !== localFile) {
      event.preventDefault();
    }
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// ── Modules ────────────────────────────────────────────────────────────────────
// Load each module separately so a failure in one (e.g. missing ExcelJS)
// does NOT crash main.js and kill all IPC handlers.
let initDb, getAllPeriods, savePeriod, deletePeriod, getCumulative,
    getFilteredMetrics, getPeriodLabels, migrateMultiMonthPeriods, detectOverlaps;
let parseFilePath;
let calculateMetrics, runWhatIf;
let exportToExcel = null;

try {
  ({ initDb, getAllPeriods, savePeriod, patchPeriod, deletePeriod,
     getCumulative, getFilteredMetrics, getPeriodLabels,
     migrateMultiMonthPeriods, detectOverlaps } = require('./src/db'));
  initDb();
  migrateMultiMonthPeriods();  // split any existing Q/annual records into monthly
  console.log('[main] db.js loaded');
} catch(e) { console.error('[main] db.js failed:', e.message); }

try {
  ({ parseFilePath } = require('./src/parser'));
  console.log('[main] parser.js loaded');
} catch(e) { console.error('[main] parser.js failed:', e.message); }

try {
  ({ calculateMetrics, runWhatIf } = require('./src/calculations'));
  console.log('[main] calculations.js loaded');
} catch(e) { console.error('[main] calculations.js failed:', e.message); }

try {
  ({ exportToExcel } = require('./src/exporter'));
  console.log('[main] exporter.js loaded (Excel export available)');
} catch(e) {
  console.warn('[main] exporter.js failed (Excel export disabled):', e.message);
  console.warn('[main] Run "npm install" to enable Excel export.');
}

// ═════════════════════════════════════════════════════════════════════════════
//  HELPERS
// ═════════════════════════════════════════════════════════════════════════════
async function processFile(filePath, csvType) {
  try {
    if (!parseFilePath) return { error: 'Parser not loaded. Run npm install.' };
    const filename = path.basename(filePath);
    const result   = await parseFilePath(filePath, csvType);
    return { ok: true, filename, ...result };
  } catch (err) {
    return { error: err.message };
  }
}

// ═════════════════════════════════════════════════════════════════════════════
//  IPC HANDLERS
// ═════════════════════════════════════════════════════════════════════════════

// File picker dialog (button click)
ipcMain.handle('pick-csv', async (_event, csvType) => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title:       'Select ' + csvType + ' file',
      buttonLabel: 'Import',
      filters: [
        { name: 'Spreadsheet & CSV', extensions: ['csv','tsv','xlsx','xls'] },
        { name: 'CSV files',         extensions: ['csv','tsv'] },
        { name: 'Excel files',       extensions: ['xlsx','xls'] },
      ],
      properties: ['openFile'],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    return processFile(filePaths[0], csvType);
  } catch(e) {
    return { error: e.message };
  }
});

// Drag-and-dropped file path (legacy — used when path is available)
ipcMain.handle('parse-file', async (_event, filePath, csvType) => {
  return processFile(filePath, csvType);
});

// Drag-and-dropped file as buffer (works on all Electron versions — no file.path needed)
// Renderer reads the file bytes and sends them here; we write to a temp file, parse, delete.
ipcMain.handle('parse-buffer', async (_event, buffer, filename, csvType) => {
  const os   = require('os');
  // Sanitize filename — strip path separators and control chars to prevent traversal
  const safeName = String(filename).replace(/[\/\\\0<>:|?*"]/g, '_').slice(0, 128);
  const tmp  = path.join(os.tmpdir(), 'fos_upload_' + Date.now() + '_' + safeName);
  try {
    if (!parseFilePath) return { error: 'Parser not loaded.' };
    fs.writeFileSync(tmp, Buffer.from(buffer));
    const result = await parseFilePath(tmp, csvType);
    return { ok: true, filename, ...result };
  } catch(err) {
    return { error: err.message };
  } finally {
    try { fs.unlinkSync(tmp); } catch(e) { /* ok */ }
  }
});

// Folder picker — opens a directory chooser, parses all CSV/XLSX files inside
ipcMain.handle('pick-folder', async (_event, csvType) => {
  try {
    const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
      title:       'Select folder containing ' + csvType + ' files',
      buttonLabel: 'Import Folder',
      properties:  ['openDirectory'],
    });
    if (canceled || !filePaths.length) return { canceled: true };
    const folderPath = filePaths[0];
    const VALID_EXT  = /\.(csv|tsv|xlsx|xls)$/i;
    const files      = fs.readdirSync(folderPath)
      .filter(f => VALID_EXT.test(f) && !f.startsWith('.') && !f.startsWith('~$'))
      .sort();
    if (!files.length) return { error: 'No CSV or Excel files found in that folder.' };
    const results = [];
    for (const filename of files) {
      try {
        const result = await processFile(path.join(folderPath, filename), csvType);
        if (result && !result.error) results.push({ ...result, filename });
      } catch(e) { /* skip unparseable files silently */ }
    }
    if (!results.length) return { error: 'Could not parse any files in that folder.' };
    return { ok: true, folderName: path.basename(folderPath), results };
  } catch(e) {
    return { error: e.message };
  }
});

// Save a period — auto-splits multi-month uploads into individual monthly records
ipcMain.handle('save-period', async (_event, payload) => {
  try {
    if (!calculateMetrics) return { error: 'Calculations not loaded. Run npm install.' };

    // ── Detect span ────────────────────────────────────────────────────────
    const ds = payload.dateStart, de = payload.dateEnd;
    const spanDays = (ds && de)
      ? (new Date(de) - new Date(ds)) / 86400000
      : 0;

    // ── Helper: apply metric overrides ────────────────────────────────────
    function applyOverrides(metrics, rowPayload) {
      if (rowPayload.revenueSplitOverride && Object.keys(rowPayload.revenueSplitOverride).length > 0)
        metrics.revenueBySplit = rowPayload.revenueSplitOverride;
      if (rowPayload.paymentSplitData && Object.keys(rowPayload.paymentSplitData).length > 0)
        metrics.paymentBySplit = rowPayload.paymentSplitData;
      return metrics;
    }

    // ── Helper: group rows by YYYY-MM key ─────────────────────────────────
    function groupByMonth(rows) {
      const map = {};
      for (const r of (rows || [])) {
        const d = r.date ? r.date.slice(0, 7) : 'unknown';
        if (!map[d]) map[d] = [];
        map[d].push(r);
      }
      return map;
    }

    // ── Single-period path (<=35 days or no date info) ────────────────────
    // ── Pre-pass 1: year alignment ────────────────────────────────────────
    // Expense files with bare month names ("May", "June") default to the current
    // year when parsed. POS rows always have the real year from the POS system.
    //
    // We build a month→year map from POS (e.g. { '08':'2024' }) and re-stamp
    // each expense/payroll row using its own month number. Months not in POS
    // use the fallback (most common POS year) so a full-year expense file paired
    // with one month of POS still gets aligned correctly.
    const posMonthToYear = {};
    for (const r of (payload.posRows || [])) {
      if (r.date && /^\d{4}-\d{2}/.test(r.date)) {
        posMonthToYear[r.date.slice(5, 7)] = r.date.slice(0, 4);
      }
    }

    function realignYear(rows) {
      if (!Object.keys(posMonthToYear).length) return rows;
      const yearCounts = {};
      for (const y of Object.values(posMonthToYear)) yearCounts[y] = (yearCounts[y] || 0) + 1;
      const fallbackYear = Object.entries(yearCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || null;

      return rows.map(r => {
        if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) return r;
        const rowYear  = r.date.slice(0, 4);
        const rowMonth = r.date.slice(5, 7);
        const targetYear = posMonthToYear[rowMonth] || fallbackYear;
        if (targetYear && targetYear !== rowYear) {
          return { ...r, date: targetYear + r.date.slice(4) };
        }
        return r;
      });
    }

    const alignedExpenseRows = realignYear(payload.expenseRows  || []);
    const alignedPayrollRows = realignYear(payload.payrollRows  || []);

    // ── Pre-pass 2: separate null-date rows ───────────────────────────────
    // Rows with no date (e.g. fixed expense CSVs with no date column) are either:
    //   - recurring: replicated at full amount to every month
    //   - lump-sum:  lumpSumMonth tag → only injected into that specific month
    const datedExpenseRows  = alignedExpenseRows.filter(r => r.date);
    const nullDateExpRows   = alignedExpenseRows.filter(r => !r.date);
    const recurringExpRows  = nullDateExpRows.filter(r => !r.lumpSumMonth);
    const lumpSumExpRows    = nullDateExpRows.filter(r =>  r.lumpSumMonth);
    const datedPayrollRows  = alignedPayrollRows.filter(r => r.date);
    const nullDatePayRows   = alignedPayrollRows.filter(r => !r.date);

    // ── Decide: single-period or multi-period? ────────────────────────────
    // Base the decision on distinct months found across ALL files (not just POS
    // date span) — a user may upload one month of POS alongside a full-year
    // expense CSV, and we should still split into monthly records.
    const allRows = [
      ...(payload.posRows || []),
      ...datedPayrollRows,
      ...datedExpenseRows,
    ];
    const monthKeys = [...new Set(
      allRows.map(r => r.date ? r.date.slice(0, 7) : null).filter(Boolean)
    )].filter(ym => /^\d{4}-\d{2}$/.test(ym)).sort();

    // ── Data coverage analysis ────────────────────────────────────────────
    // Detects missing components before saving, both per-month and globally.
    // Returns a warnings array that is sent to the renderer for user confirmation.
    const { categorizeCost } = require('./src/calculations.js');

    function analyzeDataCoverage() {
      const globalWarnings = [];   // apply to every period saved
      const monthWarnings  = {};   // { 'YYYY-MM': [...warnings] } — only for that month's record

      // ── Global: components uploaded at all? ──────────────────────────────
      const hasPOS       = (payload.posRows     || []).length > 0;
      const hasPayroll   = (payload.payrollRows || []).length > 0 || (payload.fixedInputs && payload.fixedInputs.extra_payroll > 0);

      const hasFixedCSV  = alignedExpenseRows.some(r => {
        const t = categorizeCost(r.category, payload.categoryOverrides || {});
        if (t === 'fixed') return true;
        if ((t === 'variable' || t === 'ambiguous') && r._classHint)
          return categorizeCost(r._classHint, payload.categoryOverrides || {}) === 'fixed';
        return false;
      });
      const fixedInputs  = payload.fixedInputs || {};
      const hasFixedManual = Object.entries(fixedInputs).some(([k, v]) => k !== 'extra_payroll' && (v || 0) > 0);
      const hasFixed     = hasFixedCSV || hasFixedManual;

      const hasVariable  = alignedExpenseRows.some(r => {
        const t = categorizeCost(r.category, payload.categoryOverrides || {});
        if (t === 'variable' || t === 'ambiguous') {
          if (r._classHint) return categorizeCost(r._classHint, payload.categoryOverrides || {}) === 'variable';
          return true;
        }
        return false;
      });

      const hasMaterial  = alignedExpenseRows.some(r =>
        categorizeCost(r.category, payload.categoryOverrides || {}) === 'material'
      );

      if (!hasPOS)      globalWarnings.push({ code: 'no_pos',      level: 'high',
        title: 'No revenue / POS data',
        impact: 'Revenue will be $0. All profit metrics, margins, and ratios will be meaningless.',
        affects: ['revenue','profit','margin','prime_cost','break_even'] });
      if (!hasPayroll)  globalWarnings.push({ code: 'no_payroll',  level: 'high',
        title: 'No payroll data',
        impact: 'Labor cost will be $0. Prime cost and profit will be significantly overstated. Payroll is typically 25–35% of revenue.',
        affects: ['payroll','prime_cost','profit','margin'] });
      if (!hasMaterial) globalWarnings.push({ code: 'no_material', level: 'high',
        title: 'No food / beverage cost data (COGS)',
        impact: 'Material cost will be $0. Prime cost and profit will be significantly overstated. Food & beverage costs are typically 28–35% of revenue.',
        affects: ['material','prime_cost','profit','margin'] });
      if (!hasFixed)    globalWarnings.push({ code: 'no_fixed',    level: 'high',
        title: 'No fixed expenses (rent, insurance, etc.)',
        impact: 'Fixed costs will be $0. Profit will be overstated and break-even will be wrong. Fixed costs are typically 15–20% of revenue.',
        affects: ['fixed','profit','margin','break_even'] });
      if (!hasVariable) globalWarnings.push({ code: 'no_variable', level: 'medium',
        title: 'No variable operating expenses',
        impact: 'Variable costs (delivery fees, utilities, packaging, etc.) will be $0. Profit will be slightly overstated. Typically 2–8% of revenue.',
        affects: ['variable','profit','margin'] });

      // ── Per-month gaps (multi-period only) ───────────────────────────────
      // Warnings are keyed per-month so only the affected period gets stamped,
      // not every record in the batch.
      if (monthKeys.length > 1) {
        const posMonths = new Set((payload.posRows || []).filter(r => r.date).map(r => r.date.slice(0, 7)));
        const payMonths = new Set(datedPayrollRows.map(r => r.date.slice(0, 7)));
        const matMonths = new Set(datedExpenseRows.filter(r => {
          const t = categorizeCost(r.category, payload.categoryOverrides || {});
          if (t === 'material') return true;
          if (r._classHint) return categorizeCost(r._classHint, payload.categoryOverrides || {}) === 'material';
          return false;
        }).map(r => r.date.slice(0, 7)));

        const fmtYM = ym => { const [y,m]=ym.split('-'); return new Date(y,m-1,1).toLocaleString('en-US',{month:'short',year:'numeric'}); };
        const addMonth = (ym, w) => { (monthWarnings[ym] = monthWarnings[ym] || []).push(w); };

        // Revenue months with no COGS
        if (matMonths.size > 0) {
          [...posMonths].filter(m => !matMonths.has(m)).forEach(ym => addMonth(ym, {
            code: 'gap_material', level: 'high',
            title: `COGS missing for ${fmtYM(ym)}`,
            impact: `${fmtYM(ym)} has POS revenue but no food/beverage cost data. Material cost will be $0, inflating prime cost and profit.`,
            affects: ['material','prime_cost','profit','margin'] }));
        }
        // Revenue months with no dated payroll (only when some months have dated payroll)
        if (payMonths.size > 0 && nullDatePayRows.length === 0) {
          [...posMonths].filter(m => !payMonths.has(m)).forEach(ym => addMonth(ym, {
            code: 'gap_payroll', level: 'high',
            title: `Payroll missing for ${fmtYM(ym)}`,
            impact: `${fmtYM(ym)} has revenue but no payroll data. Labor cost will be $0, inflating profit and prime cost.`,
            affects: ['payroll','prime_cost','profit','margin'] }));
        }
        // Expense months with no revenue
        if (posMonths.size > 0) {
          [...new Set(datedExpenseRows.map(r => r.date.slice(0, 7)))]
            .filter(m => !posMonths.has(m))
            .forEach(ym => addMonth(ym, {
              code: 'gap_revenue', level: 'high',
              title: `Revenue missing for ${fmtYM(ym)}`,
              impact: `${fmtYM(ym)} has expense rows but no POS revenue. It will appear as a total loss period.`,
              affects: ['revenue','profit','margin'] }));
        }

        // Summarise per-month gaps into global warnings for the pre-save modal
        // so users see the full picture before confirming.
        ['gap_material','gap_payroll','gap_revenue'].forEach(code => {
          const affected = Object.entries(monthWarnings).filter(([,ws])=>ws.some(w=>w.code===code)).map(([ym])=>fmtYM(ym));
          if (!affected.length) return;
          const labels = { gap_material:'COGS', gap_payroll:'Payroll', gap_revenue:'Revenue' };
          const impacts = {
            gap_material: 'Those months will show $0 food cost. Prime cost and profit will be overstated, making trends misleading.',
            gap_payroll:  'Those months will show $0 labor cost, inflating profit and prime cost.',
            gap_revenue:  'Those months will show $0 revenue with real expenses, appearing as catastrophic losses.',
          };
          const aff = { gap_material:['material','prime_cost','profit','margin'], gap_payroll:['payroll','prime_cost','profit','margin'], gap_revenue:['revenue','profit','margin'] };
          globalWarnings.push({ code, level:'high',
            title: `${labels[code]} missing for ${affected.length} month${affected.length>1?'s':''}`,
            detail: affected.join(', '),
            impact: impacts[code],
            affects: aff[code] });
        });
      }

      // ── Outlier expense rows ───────────────────────────────────────────────
      const posRevByMonth = {};
      (payload.posRows || []).forEach(r => {
        if (!r.date) return;
        const ym = r.date.slice(0,7);
        posRevByMonth[ym] = (posRevByMonth[ym] || 0) + (r.amount || 0);
      });
      const outlierRows = alignedExpenseRows.filter(r => {
        if (!r.date || !r.amount) return false;
        const monthRev = posRevByMonth[r.date.slice(0,7)] || 0;
        return monthRev > 0 && r.amount > 0 && r.amount > monthRev * 2;
      });
      if (outlierRows.length) {
        const fmt2 = r => `${r.category} (${r.date.slice(0,7)}): $${Math.round(r.amount).toLocaleString()}`;
        globalWarnings.push({ code: 'outlier_expense', level: 'high',
          title: `${outlierRows.length} expense row${outlierRows.length>1?'s':''} may be a data entry error`,
          detail: outlierRows.map(fmt2).join('; '),
          impact: 'One or more expense rows exceed 2× that month\'s total revenue — likely a misplaced decimal or extra zero. Verify before saving.',
          affects: ['material','fixed','variable','profit','margin'] });
        outlierRows.forEach(r => {
          const ym = r.date.slice(0,7);
          const mw = monthWarnings[ym] = monthWarnings[ym] || [];
          if (!mw.some(w => w.code === 'outlier_expense'))
            mw.push({ code: 'outlier_expense', level: 'high',
              title: 'Possible data entry error in expenses',
              detail: fmt2(r),
              impact: 'An expense row exceeds 2× this month\'s revenue — likely a misplaced decimal.',
              affects: ['material','fixed','variable','profit','margin'] });
        });
      }

      // ── Year-span ghost period ─────────────────────────────────────────────
      if (monthKeys.length >= 2) {
        const [fy,fm] = monthKeys[0].split('-').map(Number);
        const [ly,lm] = monthKeys[monthKeys.length-1].split('-').map(Number);
        if ((ly-fy)*12+(lm-fm) > 16) {
          const fmtYM2 = ym => { const [y,m]=ym.split('-'); return new Date(y,m-1,1).toLocaleString('en-US',{month:'short',year:'numeric'}); };
          const orphans = monthKeys.filter((ym,i) => {
            const gap = (a,b) => { if(!a||!b)return 99; const [ay,am]=a.split('-').map(Number),[by,bm]=b.split('-').map(Number); return Math.abs((by-ay)*12+(bm-am)); };
            return Math.min(gap(ym,monthKeys[i-1]||null),gap(ym,monthKeys[i+1]||null)) > 6;
          });
          if (orphans.length) {
            globalWarnings.push({ code: 'year_span', level: 'high',
              title: 'Possible year typo in dates',
              detail: orphans.map(fmtYM2).join(', '),
              impact: 'These months appear isolated from the rest of your data — likely a year typed incorrectly (e.g. 2023 instead of 2024). They will create ghost periods with $0 revenue or $0 expenses.',
              affects: ['revenue','profit','margin'] });
            orphans.forEach(ym => {
              (monthWarnings[ym] = monthWarnings[ym]||[]).push({ code:'year_span', level:'high',
                title:'Possible year typo — isolated period',
                impact:'This period is more than 6 months from any adjacent period, suggesting a date typo.',
                affects:['revenue','profit','margin'] });
            });
          }
        }
      }

      // ── CC processing fee double-count ────────────────────────────────────
      const FEE_CAT_RE = /(processing\s+fee|credit\s+card\s+fee|stripe|square\s+fee|payment\s+processing|merchant\s+fee|cc\s+fee|transaction\s+fee)/i;
      if (hasPOS && alignedExpenseRows.some(r => FEE_CAT_RE.test(r.category || ''))) {
        globalWarnings.push({ code: 'cc_fee_double', level: 'medium',
          title: 'Possible credit card processing fee double-count',
          impact: 'Your expense file contains credit card processing fees. If your POS export already reports net sales (after fees are deducted), these fees will be counted twice. Check whether your POS total includes or excludes processing fees.',
          affects: ['variable','profit','margin'] });
      }

      return { global: globalWarnings, byMonth: monthWarnings };
    }

    const { global: coverageWarnings, byMonth: monthCoverageWarnings } = analyzeDataCoverage();


    // If the renderer sent confirmed:true (user clicked "Save Anyway"), skip the gate.
    // Otherwise, if there are warnings, return them without saving so the renderer
    // can show the pre-save warning modal.
    if (coverageWarnings.length > 0 && !payload.confirmed) {
      return { needsConfirmation: true, warnings: coverageWarnings };
    }

    // ── Single-period path ────────────────────────────────────────────────
    // Use when everything truly is one period: one month of POS + matching
    // expenses, OR when there are no dated rows at all.
    if (monthKeys.length <= 1) {
      const n = Math.max(1, Math.round(payload.monthsInPeriod || 1));
      const scaledPayload = n === 1
        ? { ...payload, expenseRows: alignedExpenseRows, payrollRows: alignedPayrollRows }
        : {
          ...payload,
          expenseRows: alignedExpenseRows,
          payrollRows: alignedPayrollRows,
          fixedInputs: Object.fromEntries(
            Object.entries(payload.fixedInputs || {}).map(([k, v]) => [k, (v || 0) * n])
          ),
        };
      scaledPayload.categoryOverrides = payload.categoryOverrides || {};
      const metrics = applyOverrides(calculateMetrics(scaledPayload), scaledPayload);
      const bankRows = payload.bankRows || [];
      metrics.bankIn  = bankRows.reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0);
      metrics.bankOut = bankRows.reduce((s, r) => s + (r.amount < 0 ? Math.abs(r.amount) : 0), 0);
      const id = savePeriod({ ...scaledPayload, metrics, dataWarnings: coverageWarnings });
      const overlaps = detectOverlaps(ds, de, getAllPeriods(), id);
      return { ok: true, id, metrics, overlaps };
    }

    // ── Multi-period path: save one record per month ──────────────────────
    const savedIds = [];
    const monthCount = monthKeys.length;
    for (const ym of monthKeys) {
      const [yr, mo] = ym.split('-').map(Number);
      const monthStart = `${yr}-${String(mo).padStart(2,'0')}-01`;
      const lastDay    = new Date(yr, mo, 0).getDate();
      const monthEnd   = `${yr}-${String(mo).padStart(2,'0')}-${String(lastDay).padStart(2,'0')}`;

      const posSlice     = (payload.posRows || []).filter(r => r.date && r.date.startsWith(ym));
      const payrollSlice = [
        ...datedPayrollRows.filter(r => r.date.startsWith(ym)),
        ...nullDatePayRows,  // monthly recurring — full amount each month
      ];
      const expSlice = [
        ...datedExpenseRows.filter(r => r.date.startsWith(ym)),
        ...recurringExpRows,  // monthly recurring — full amount each month
        ...lumpSumExpRows.filter(r => r.lumpSumMonth === mo),  // lump-sum — only in target month
      ];

      // Pro-rate fixed inputs across months.
      // Fixed inputs are already per-month — keep them as-is for each monthly record.
      const proratedFixed = { ...(payload.fixedInputs || {}) };

      // Pro-rate split overrides proportionally by this month's revenue share
      const totalPosRevenue = (payload.posRows || []).reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0);
      const monthRevenue    = posSlice.reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0);
      const shareRatio      = totalPosRevenue > 0 ? monthRevenue / totalPosRevenue : 1 / monthCount;

      const revOverride = {};
      for (const [k, v] of Object.entries(payload.revenueSplitOverride || {}))
        revOverride[k] = v * shareRatio;

      const payOverride = {};
      for (const [k, v] of Object.entries(payload.paymentSplitData || {}))
        payOverride[k] = v * shareRatio;

      const monthLabel = new Date(monthStart + 'T12:00:00Z')
        .toLocaleString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });

      const monthPayload = {
        label:      monthLabel,
        periodType: 'monthly',
        dateStart:  monthStart,
        dateEnd:    monthEnd,
        posRows:     posSlice,
        payrollRows: payrollSlice,
        expenseRows: expSlice,
        fixedInputs: proratedFixed,
        revenueSplitOverride: revOverride,
        paymentSplitData:     payOverride,
        categoryOverrides:    payload.categoryOverrides || {},
      };

      const bankSlice = (payload.bankRows || []).filter(r => r.date && r.date.startsWith(ym));
      const metrics = applyOverrides(calculateMetrics(monthPayload), monthPayload);
      metrics.bankIn  = bankSlice.reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0);
      metrics.bankOut = bankSlice.reduce((s, r) => s + (r.amount < 0 ? Math.abs(r.amount) : 0), 0);
      const id = savePeriod({ ...monthPayload, metrics, dataWarnings: [
        ...coverageWarnings,
        ...(monthCoverageWarnings[ym] || []),
      ]});
      savedIds.push(id);
    }

    return { ok: true, ids: savedIds, split: true, monthCount: monthKeys.length };

  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle('get-periods',       ()                       => { try { return getAllPeriods(); } catch(e) { return []; } });
ipcMain.handle('get-cumulative',    ()                       => { try { return getCumulative(); } catch(e) { return {}; } });
ipcMain.handle('get-metrics',       (_e, { viewBy, period }) => { try { return getFilteredMetrics(viewBy, period); } catch(e) { return {}; } });
ipcMain.handle('get-period-labels', (_e, viewBy)             => { try { return getPeriodLabels(viewBy); } catch(e) { return []; } });
ipcMain.handle('delete-period',     (_e, id)                 => { try { deletePeriod(id); return { ok: true }; } catch(e) { return { error: e.message }; } });
ipcMain.handle('patch-period',      (_e, payload)            => { try { patchPeriod(payload.id, payload.metrics); return { ok: true }; } catch(e) { return { error: e.message }; } });
ipcMain.handle('whatif',            (_e, payload)            => { try { return runWhatIf(payload); } catch(e) { return { error: e.message }; } });

// Export to Excel
ipcMain.handle('export-excel', async (_event, payload) => {
  if (!exportToExcel) {
    return { error: 'Excel export requires ExcelJS. Run "npm install" in the app folder, then restart.' };
  }
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title:       'Save Excel Report',
      defaultPath: 'FinancialOS_Report_' + (payload.period || 'AllTime').replace(/\s/g,'_') + '.xlsx',
      filters:     [{ name: 'Excel Workbook', extensions: ['xlsx'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    await exportToExcel(payload, filePath);
    shell.showItemInFolder(filePath);
    return { ok: true, filePath };
  } catch (err) {
    return { error: err.message };
  }
});

// ─── CSV export (always available, no ExcelJS needed) ──────────────────────────
ipcMain.handle('export-csv', async (_event, payload) => {
  try {
    const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
      title:       'Save CSV Report',
      defaultPath: 'FinancialOS_Report_' + (payload.period || 'AllTime').replace(/\s/g,'_') + '.csv',
      filters:     [{ name: 'CSV file', extensions: ['csv'] }],
    });
    if (canceled || !filePath) return { canceled: true };
    const m = payload.metrics || {};
    const safeNum = v => (typeof v === 'number' && isFinite(v)) ? v : 0;
    const rows = [
      ['FinancialOS Report', (payload.period || 'All Time')],
      [],
      ['REVENUE'],
      ['Total Revenue', safeNum(m.total_revenue)],
    ];
    (m.revenueSplits || []).forEach(s => rows.push(['  ' + s.category, safeNum(s.amount)]));
    rows.push([]);
    rows.push(['PRIME COST']);
    rows.push(['Total Payroll',   safeNum(m.total_payroll)]);
    rows.push(['Material / COGS', safeNum(m.total_material)]);
    rows.push(['Prime Cost',      safeNum(m.prime_cost)]);
    rows.push([]);
    rows.push(['OTHER EXPENSES']);
    rows.push(['Fixed Expenses',    safeNum(m.total_fixed)]);
    rows.push(['Variable Expenses', safeNum(m.total_variable)]);
    rows.push(['Total Expenses',    safeNum(m.total_expenses)]);
    rows.push([]);
    rows.push(['PROFITABILITY']);
    rows.push(['Net Profit',        safeNum(m.profit)]);
    rows.push(['Profit Margin %',   (safeNum(m.profit) / (safeNum(m.total_revenue) || 1) * 100).toFixed(1) + '%']);
    rows.push(['Break-Even Revenue',safeNum(m.break_even)]);
    if (payload.periods && payload.periods.length) {
      rows.push([]); rows.push([]);
      rows.push(['PERIOD HISTORY']);
      rows.push(['Period','Revenue','Payroll','Material','Prime Cost','Fixed','Variable','Total Exp','Profit','Margin %']);
      payload.periods.forEach(p => rows.push([
        p.label, safeNum(p.total_revenue), safeNum(p.total_payroll), safeNum(p.total_material),
        safeNum(p.prime_cost), safeNum(p.total_fixed), safeNum(p.total_variable),
        safeNum(p.total_expenses), safeNum(p.profit),
        safeNum(p.profit_margin).toFixed(1) + '%',
      ]));
    }
    const csv = rows.map(r => r.map(v => {
      const s = String(v == null ? '' : v);
      return s.includes(',') || s.includes('"') || s.includes('\n') ? '"' + s.replace(/"/g,'""') + '"' : s;
    }).join(',')).join('\n');
    fs.writeFileSync(filePath, csv, 'utf8');
    shell.showItemInFolder(filePath);
    return { ok: true, filePath };
  } catch (err) {
    return { error: err.message };
  }
});
