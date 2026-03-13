const ExcelJS = require('exceljs');

// ── Helpers ───────────────────────────────────────────────────────────────────
function safeNum(v) { return (typeof v === 'number' && isFinite(v)) ? v : 0; }

function styleCell(c, opts) {
  opts = opts || {};
  c.font = { name: 'Calibri', size: opts.size || 10, bold: !!opts.bold, color: { argb: 'FF' + (opts.fg || '1F2937') } };
  if (opts.bg) c.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF' + opts.bg } };
  if (opts.fmt)   c.numFmt = opts.fmt;
  if (opts.align) c.alignment = { horizontal: opts.align, vertical: 'middle', wrapText: false };
  else            c.alignment = { vertical: 'middle' };
  if (opts.border !== false) {
    c.border = {
      top:    { style: 'thin', color: { argb: 'FFD1D5DB' } },
      bottom: { style: 'thin', color: { argb: 'FFD1D5DB' } },
      left:   { style: 'thin', color: { argb: 'FFD1D5DB' } },
      right:  { style: 'thin', color: { argb: 'FFD1D5DB' } },
    };
  }
}

function hdrCell(ws, row, col, text, span, dark) {
  span = span || 1;
  dark = dark !== false;
  const c = ws.getCell(row, col);
  c.value = text;
  styleCell(c, { bold: true, bg: dark ? '1E3A5F' : '2563EB', fg: 'FFFFFF', align: 'center', size: 11, border: false });
  if (span > 1) try { ws.mergeCells(row, col, row, col + span - 1); } catch(e) {}
  ws.getRow(row).height = 22;
}

function secCell(ws, row, col, text, span) {
  span = span || 1;
  const c = ws.getCell(row, col);
  c.value = text;
  styleCell(c, { bold: true, bg: 'DBEAFE', fg: '1E3A5F', align: 'left', border: false });
  if (span > 1) try { ws.mergeCells(row, col, row, col + span - 1); } catch(e) {}
}

const FMT_DOLLAR = '"$"#,##0.00;[Red]"($"#,##0.00")";"-"';
const FMT_PCT    = '0.0%';

function dataRow(ws, row, label, value, fmt, highlight) {
  const lc = ws.getCell(row, 2);
  lc.value = label;
  styleCell(lc, { bg: highlight ? 'EFF6FF' : null, bold: !!highlight });

  const vc = ws.getCell(row, 3);
  vc.value = safeNum(value);
  styleCell(vc, { fmt: fmt || FMT_DOLLAR, align: 'right', bold: !!highlight, bg: highlight ? 'EFF6FF' : null });
}

// ─────────────────────────────────────────────────────────────────────────────
async function exportToExcel(payload, filePath) {
  const { metrics, periods, viewBy, period: periodLabel } = payload;
  const m   = metrics || {};
  const rev = safeNum(m.total_revenue) || 1;

  const wb = new ExcelJS.Workbook();
  wb.creator  = 'FinancialOS';
  wb.created  = new Date();
  wb.modified = new Date();

  // ── SUMMARY SHEET ──────────────────────────────────────────────────────────
  const ws = wb.addWorksheet('Summary', { views: [{ showGridLines: false }] });
  ws.getColumn(1).width = 2;   // gutter
  ws.getColumn(2).width = 36;  // label
  ws.getColumn(3).width = 20;  // value
  ws.getColumn(4).width = 2;   // right gutter

  const title = (viewBy === 'All Time' || !periodLabel || periodLabel === 'All Time')
    ? 'All Periods — Cumulative'
    : viewBy + ': ' + periodLabel;

  hdrCell(ws, 1, 2, 'FINANCIALOS — ' + title, 2);

  let r = 3;

  // Revenue
  secCell(ws, r, 2, 'REVENUE', 2); r++;
  dataRow(ws, r, 'Total Revenue', m.total_revenue, FMT_DOLLAR, true); r++;
  const splits = m.revenueSplits || [];
  for (let i = 0; i < splits.length; i++) {
    dataRow(ws, r, '  ' + splits[i].category, splits[i].amount); r++;
  }
  r++;

  // Prime Cost
  secCell(ws, r, 2, 'PRIME COST  (Payroll + Food & Drink Costs)', 2); r++;
  dataRow(ws, r, 'Total Payroll',  m.total_payroll); r++;
  dataRow(ws, r, 'Material / COGS', m.total_material); r++;
  dataRow(ws, r, 'Prime Cost',     m.prime_cost,    FMT_DOLLAR, true); r++;
  dataRow(ws, r, 'Prime Cost %',   safeNum(m.prime_cost) / rev, FMT_PCT); r++;
  r++;

  // Expenses
  secCell(ws, r, 2, 'OTHER EXPENSES', 2); r++;
  dataRow(ws, r, 'Fixed Expenses',    m.total_fixed); r++;
  dataRow(ws, r, 'Variable Expenses', m.total_variable); r++;
  dataRow(ws, r, 'Total Expenses',    m.total_expenses, FMT_DOLLAR, true); r++;
  r++;

  // Profitability
  secCell(ws, r, 2, 'PROFITABILITY', 2); r++;
  dataRow(ws, r, 'Net Profit / (Loss)', m.profit, FMT_DOLLAR, true); r++;
  dataRow(ws, r, 'Profit Margin %',     safeNum(m.profit) / rev, FMT_PCT, true); r++;
  dataRow(ws, r, 'Break-Even Revenue',  m.break_even); r++;
  r++;

  // Health ratios
  secCell(ws, r, 2, 'HEALTH RATIOS  (Industry benchmarks)', 2); r++;
  const ratios = [
    ['Prime Cost % of Revenue',  safeNum(m.prime_cost)     / rev, '< 65%'],
    ['Payroll % of Revenue',     safeNum(m.total_payroll)  / rev, '< 35%'],
    ['Material % of Revenue',    safeNum(m.total_material) / rev, '< 30%'],
    ['Fixed Exp % of Revenue',   safeNum(m.total_fixed)    / rev, '< 20%'],
  ];
  for (const [lbl, val, target] of ratios) {
    dataRow(ws, r, lbl + '  (target ' + target + ')', val, FMT_PCT); r++;
  }

  ws.properties.tabColor = { argb: 'FF1E3A5F' };

  // ── HISTORY SHEET ──────────────────────────────────────────────────────────
  if (periods && periods.length) {
    const wh = wb.addWorksheet('Period History', { views: [{ showGridLines: false }] });
    const cols = [
      { title: 'Period',     key: 'label',          width: 18, fmt: null },
      { title: 'Revenue',    key: 'total_revenue',  width: 14, fmt: FMT_DOLLAR },
      { title: 'Payroll',    key: 'total_payroll',  width: 14, fmt: FMT_DOLLAR },
      { title: 'Material',   key: 'total_material', width: 14, fmt: FMT_DOLLAR },
      { title: 'Prime Cost', key: 'prime_cost',     width: 14, fmt: FMT_DOLLAR },
      { title: 'Fixed Exp',  key: 'total_fixed',    width: 14, fmt: FMT_DOLLAR },
      { title: 'Variable',   key: 'total_variable', width: 13, fmt: FMT_DOLLAR },
      { title: 'Total Exp',  key: 'total_expenses', width: 14, fmt: FMT_DOLLAR },
      { title: 'Profit',     key: 'profit',         width: 14, fmt: FMT_DOLLAR },
      { title: 'Margin %',   key: 'profit_margin',  width: 10, fmt: FMT_PCT },
    ];
    cols.forEach(function(col, i) {
      const c = wh.getCell(1, i + 1);
      c.value = col.title;
      styleCell(c, { bold: true, bg: '1E3A5F', fg: 'FFFFFF', align: i > 0 ? 'right' : 'left', border: false });
      wh.getColumn(i + 1).width = col.width;
    });
    wh.getRow(1).height = 20;

    periods.forEach(function(p, ri) {
      const bgHex = ri % 2 === 0 ? 'F8FAFC' : 'FFFFFF';
      cols.forEach(function(col, ci) {
        var raw = p[col.key];
        var val = col.key === 'profit_margin' ? safeNum(raw) / 100 : (col.key === 'label' ? raw : safeNum(raw));
        const c = wh.getCell(ri + 2, ci + 1);
        c.value = val;
        styleCell(c, { fmt: col.fmt || null, align: ci > 0 ? 'right' : 'left', bg: bgHex });
      });
    });
    wh.properties.tabColor = { argb: 'FF2563EB' };
  }

  // ── FORMULAS SHEET ──────────────────────────────────────────────────────────
  const wf = wb.addWorksheet('How It\'s Calculated', { views: [{ showGridLines: false }] });
  wf.getColumn(1).width = 2;
  wf.getColumn(2).width = 28;
  wf.getColumn(3).width = 48;
  wf.getColumn(4).width = 2;

  hdrCell(wf, 1, 2, 'HOW EACH NUMBER IS CALCULATED', 2);
  wf.getRow(1).height = 22;

  const formulas = [
    ['REVENUE', null],
    ['Total Revenue', 'Sum of all items sold (after removing "how people paid" rows like Cash/Card and any Grand Total rows that would duplicate your categories).'],
    ['', ''],
    ['PRIME COST', null],
    ['Payroll', 'All wages from your payroll file + any manual Extra Payroll you entered.'],
    ['Material / COGS', 'Expense rows in food & drink categories (Food, Alcohol, Beer, Wine, Produce, Meat, Dairy, Ingredients, Beverages).'],
    ['Prime Cost', 'Payroll + Material. This is your #1 controllable cost. Target: keep it under 65% of revenue.'],
    ['', ''],
    ['FIXED EXPENSES', null],
    ['Fixed Expenses', 'Expense rows in fixed categories (Rent, Insurance, POS & Software, Marketing, Accounting, Licenses) PLUS any amounts you typed into the Manual Fixed Expenses section.'],
    ['', ''],
    ['VARIABLE EXPENSES', null],
    ['Variable Expenses', 'Everything in your expenses file that is NOT in food/drink categories and NOT in fixed categories. These go up and down with business volume.'],
    ['', ''],
    ['PROFITABILITY', null],
    ['Total Expenses', 'Payroll + Material + Fixed + Variable = everything you spent.'],
    ['Net Profit', 'Total Revenue minus Total Expenses. If negative, you spent more than you made.'],
    ['Profit Margin %', 'Net Profit ÷ Revenue × 100. How many cents you keep from every dollar of sales. Target: 5–15% for most food businesses.'],
    ['', ''],
    ['BREAK-EVEN', null],
    ['Break-Even Revenue', 'The minimum sales needed to cover all costs with zero profit and zero loss.\nFormula: Fixed Costs ÷ Contribution Margin\nContribution Margin = 1 − ((Payroll + Material + Variable) ÷ Revenue)\nExample: If fixed costs are $8,000 and CM is 35%, break-even = $8,000 ÷ 0.35 = $22,857'],
  ];

  let fr = 3;
  for (const [label, desc] of formulas) {
    if (desc === null) {
      // Section header
      const c = wf.getCell(fr, 2);
      c.value = label;
      styleCell(c, { bold: true, bg: 'DBEAFE', fg: '1E3A5F', border: false });
      try { wf.mergeCells(fr, 2, fr, 3); } catch(e) {}
    } else if (label === '') {
      // spacer
    } else {
      const lc = wf.getCell(fr, 2);
      lc.value = label;
      styleCell(lc, { bold: true });
      const dc = wf.getCell(fr, 3);
      dc.value = desc;
      styleCell(dc, { fg: '374151' });
      dc.alignment = { wrapText: true, vertical: 'top' };
      wf.getRow(fr).height = desc.includes('\n') ? 55 : 18;
    }
    fr++;
  }
  wf.properties.tabColor = { argb: 'FF059669' };

  await wb.xlsx.writeFile(filePath);
}

module.exports = { exportToExcel };
