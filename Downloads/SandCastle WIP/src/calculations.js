'use strict';

// ── Taxonomy integration ──────────────────────────────────────────────────────
// Canonical category sets come from taxonomy.js so that calculations.js and
// parser.js agree on which names are material / fixed / variable.
// The legacy sets + keyword fallbacks below stay active so that:
//   • Old saved periods that used plain names ('Food', 'Beer') still classify
//   • Unit tests that pass rows with legacy names still pass
//   • Real-world fuzzy names ('Domestic Beer - Draft') still work
const { getTaxonomy } = require('./taxonomy');
const _tax = getTaxonomy('restaurant');  // default; pass businessType when multi-type lands

const CANONICAL_MATERIAL = _tax.materialCategories;  // 'Food Cost', 'Beer Cost', …
const CANONICAL_FIXED    = _tax.fixedCategories;     // 'Rent', 'Insurance', …

// Legacy sets — plain names used before taxonomy was added and in unit tests
const MATERIAL_CATS = new Set([
  'Food','Alcohol','Beer','Wine','Spirits','Beverages',
  'Non-Alcoholic','Ingredients','Produce','Meat','Dairy',
  'Beverages - Alcohol','Beverages - NA','Spirits & Cocktails',
]);
const FIXED_CATS = new Set([
  'Rent','Insurance','POS & Software','Marketing','Accounting','Licenses & Permits',
  // Generic labels some bank/accounting exports use — the column literally says "Fixed"
  'Fixed',
]);

// Direct variable label — recognized before keyword fallback
const EXPLICIT_VARIABLE = new Set(['Variable']);

// Keyword fallback — handles fuzzy real-world names not caught by either set:
// "Domestic Beer - Draft", "House Wine - Red", "Call Spirits", "NA Beverages"
const MATERIAL_KW = /\b(food|alcohol|beer|wines?|spirits?|beverages?|ingredients?|produce|meats?|dairy|liquor|draft|kegs?|cocktails?|cider|mead|sake|vodka|rum|gins?|whiskeys?|whiskys?|tequila|brandy|brandies|seltzer|kombucha|na bev|dry\s+goods|pantry|(?:food|supply|supplies|container|to.?go|disposable)\s*[&+]\s*packaging|packaging\s*[&+]\s*(?:supply|supplies|container|materials?)|containers?|disposables?|to.?go|portion|seafood|poultry|proteins?|grains?|flours?|cogs|raw\s+materials?|cost\s+of\s+(goods|sales|food|bev))/i;
const FIXED_KW    = /\b(rent|lease|insurance|software|pos |marketing|accounting|licen|permit|subscription|loan|mortgage|depreciation|amortization|building\s+maintenance|facilities)/i;

// Ambiguous — words that are genuinely unclear in a restaurant context.
// "Supplies" alone could be kitchen/food supplies OR cleaning/office supplies.
// We don't guess; we ask the user instead.
// Exclusions: words that make it unambiguously non-food (cleaning, janitorial, office, paper).
const AMBIGUOUS_KW      = /\b(supplies|consumables?)\b/i;
const AMBIGUOUS_EXCLUDE = /\b(cleaning|janitorial|office|paper|sanit|laundry|soap|detergent|mop)\b/i;

function categorizeCost(cat, overrides) {
  // 0. User-supplied override takes absolute precedence
  if (overrides && overrides[cat]) return overrides[cat];
  // 1. Canonical taxonomy sets (post-parse names: 'Food Cost', 'Beer Cost', 'Rent', …)
  if (CANONICAL_MATERIAL.has(cat)) return 'material';
  if (CANONICAL_FIXED.has(cat))    return 'fixed';
  // 2. Legacy plain-name sets ('Food', 'Alcohol', 'Rent', …) + generic "Fixed" label
  if (MATERIAL_CATS.has(cat)) return 'material';
  if (FIXED_CATS.has(cat))    return 'fixed';
  // 2b. Generic "Variable" label from bank/accounting exports
  if (EXPLICIT_VARIABLE.has(cat)) return 'variable';
  // 3. Keyword fuzzy fallback for anything not yet canonicalized
  if (MATERIAL_KW.test(cat))  return 'material';
  if (FIXED_KW.test(cat))     return 'fixed';
  // 4. Ambiguous — needs user clarification; treated as variable until resolved
  if (AMBIGUOUS_KW.test(cat) && !AMBIGUOUS_EXCLUDE.test(cat)) return 'ambiguous';
  return 'variable';
}

// Scan expense rows and return unique ambiguous categories with their totals.
// Used by the renderer to decide whether to show the clarification UI.
function findAmbiguous(expenseRows, overrides) {
  const found = {};
  for (const r of (expenseRows || [])) {
    const cat = r.category || 'Other';
    if (categorizeCost(cat, overrides) === 'ambiguous') {
      found[cat] = (found[cat] || 0) + Math.abs(r.amount);
    }
  }
  return found; // { 'Supplies': 4200, 'Bar Consumables': 800 }
}

// Human-readable labels for manual fixed input keys
const MANUAL_KEY_LABELS = {
  rent:             'Rent',
  insurance:        'Insurance',
  pos_software:     'POS & Software',
  marketing:        'Marketing',
  accounting:       'Accounting',
  licenses_permits: 'Licenses & Permits',
  other_fixed:      'Other Fixed',
};

function fmtD(v) {
  const abs = Math.abs(v || 0);
  if (abs >= 1000000) return '$' + (abs / 1000000).toFixed(2) + 'M';
  if (abs >= 1000)    return '$' + (abs / 1000).toFixed(1) + 'K';
  return '$' + abs.toFixed(2);
}
function fmtP(v) { return ((v || 0)).toFixed(1) + '%'; }

function calculateMetrics({
  posRows = [], payrollRows = [], expenseRows = [],
  fixedInputs = {}, posParseAudit = null,
  categoryOverrides = {},   // { 'Supplies': 'material', 'Bar Consumables': 'variable' }
}) {
  // ── Revenue ────────────────────────────────────────────────────────────────
  const total_revenue = posRows.reduce((s, r) => s + (r.amount > 0 ? r.amount : 0), 0);
  const revenueBySplit = {};
  for (const r of posRows) {
    if (r.amount > 0)
      revenueBySplit[r.category || 'Sales'] = (revenueBySplit[r.category || 'Sales'] || 0) + r.amount;
  }

  // ── Payroll ────────────────────────────────────────────────────────────────
  const payroll_csv   = payrollRows.reduce((s, r) => s + Math.abs(r.amount), 0);
  const extra_payroll = fixedInputs.extra_payroll || 0;
  const total_payroll = payroll_csv + extra_payroll;

  // ── Expenses from uploaded CSV ─────────────────────────────────────────────
  let total_material = 0, total_fixed_from_csv = 0, total_variable = 0;
  const expenseByCat = {};   // ← this will hold ALL expenses including manual

  for (const r of expenseRows) {
    const amt = r.amount;   // preserve sign — vendor credits are negative and should net down
    const cat = r.category || 'Other';
    expenseByCat[cat] = (expenseByCat[cat] || 0) + amt;
    // Try classifying by display category first; if unresolved, try _classHint (generic label)
    let costType = categorizeCost(cat, categoryOverrides);
    if ((costType === 'variable' || costType === 'ambiguous') && r._classHint) {
      const hintType = categorizeCost(r._classHint, categoryOverrides);
      if (hintType === 'fixed' || hintType === 'material') costType = hintType;
    }
    if (costType === 'material')              total_material += amt;
    else if (costType === 'fixed')            total_fixed_from_csv += amt;
    else /* 'variable' or 'ambiguous' */      total_variable += amt;
  }

  // ── Manual fixed inputs → also add to expenseByCat for the chart ──────────
  let manual_fixed = 0;
  const fixed_detail = [];
  for (const [key, label] of Object.entries(MANUAL_KEY_LABELS)) {
    const amt = fixedInputs[key] || 0;
    if (amt > 0) {
      manual_fixed += amt;
      fixed_detail.push({ label, amount: amt });
      // Merge into expenseByCat so the chart shows manual inputs too
      expenseByCat[label] = (expenseByCat[label] || 0) + amt;
    }
  }

  // ── Totals ─────────────────────────────────────────────────────────────────
  const total_fixed    = total_fixed_from_csv + manual_fixed;
  const prime_cost     = total_payroll + total_material;
  const total_expenses = total_fixed + total_variable + prime_cost;
  const profit         = total_revenue - total_expenses;
  // Guard: avoid dividing by zero when no POS data uploaded yet
  const profit_margin  = total_revenue > 0 ? profit / total_revenue * 100 : null;
  const prime_pct      = total_revenue > 0 ? prime_cost / total_revenue * 100 : null;

  // ── Break-even ─────────────────────────────────────────────────────────────
  // Fixed Costs ÷ Contribution Margin
  // Contribution Margin = 1 - (Variable Costs / Revenue)
  // Variable Costs = Prime Cost + Variable Expenses  (costs that scale with revenue)
  const variable_costs = prime_cost + total_variable;
  const variable_ratio = total_revenue > 0 ? variable_costs / total_revenue : 1;
  const contrib_margin = 1 - variable_ratio;
  // Break-even is only meaningful when contribution margin is positive.
  // When contrib_margin <= 0, every additional dollar of revenue increases losses —
  // no amount of revenue covers fixed costs. Return null so the UI can show "N/A"
  // rather than a misleading $0 or negative number.
  const break_even = (total_revenue > 0 && contrib_margin > 0.01)
    ? total_fixed / contrib_margin
    : null;

  // ── Calc detail (used by the "How it's calculated" modal) ─────────────────
  const calc_detail = {
    revenue: {
      total:   total_revenue,
      splits:  Object.entries(revenueBySplit).map(([k, v]) => ({ label: k, amount: v })),
      audit:   posParseAudit || null,
      formula: 'Sum of revenue category rows from your POS/sales file.',
    },
    payroll: {
      from_csv:    payroll_csv,
      extra_input: extra_payroll,
      total:       total_payroll,
      formula:     `Payroll CSV (${fmtD(payroll_csv)}) + Manual extra payroll (${fmtD(extra_payroll)}) = ${fmtD(total_payroll)}`,
    },
    material: {
      total:   total_material,
      cats:    Object.entries(expenseByCat)
                 .filter(([k]) => MATERIAL_CATS.has(k))
                 .map(([k, v]) => ({ label: k, amount: v })),
      formula: `Sum of expense rows in material categories (Food, Alcohol, Beverages, etc.) = ${fmtD(total_material)}`,
    },
    prime_cost: {
      payroll:  total_payroll,
      material: total_material,
      total:    prime_cost,
      pct:      prime_pct,
      formula:  `Payroll (${fmtD(total_payroll)}) + Material Costs (${fmtD(total_material)}) = ${fmtD(prime_cost)}` + (prime_pct != null ? ` (${fmtP(prime_pct)} of revenue)` : ''),
      why:      'Prime cost = your two biggest controllable costs. Industry target: keep it under 65% of revenue.',
    },
    fixed_expenses: {
      from_csv:      total_fixed_from_csv,
      manual_inputs: fixed_detail,
      total:         total_fixed,
      formula:       `Fixed costs from expense CSV (${fmtD(total_fixed_from_csv)}) + Manual inputs (${fmtD(manual_fixed)}) = ${fmtD(total_fixed)}`,
    },
    variable_expenses: {
      total:   total_variable,
      formula: `Sum of expense rows NOT in material or fixed categories = ${fmtD(total_variable)}`,
    },
    break_even: {
      fixed_costs:    total_fixed,
      variable_costs,
      variable_ratio: variable_ratio * 100,
      contrib_margin: contrib_margin * 100,
      result:         break_even,
      formula:        break_even != null
        ? `${fmtD(total_fixed)} ÷ ${fmtP(contrib_margin * 100)} = ${fmtD(break_even)}`
        : contrib_margin <= 0.01
          ? 'Break-even is unreachable — variable costs exceed revenue. Reduce prime cost first.'
          : 'No revenue data — upload a POS file to calculate break-even.',
      formula_full:   'Fixed Costs ÷ Contribution Margin % = Break-Even Revenue',
      why: break_even != null
        ? `Every dollar of revenue, ${fmtP(variable_ratio * 100)} goes to variable costs ` +
          `(prime cost + variable expenses). The remaining ${fmtP(contrib_margin * 100)} is ` +
          `available to cover fixed costs. You need ${fmtD(break_even)} in revenue so that ` +
          `${fmtP(contrib_margin * 100)} of it exactly covers your ${fmtD(total_fixed)} in fixed costs.`
        : 'Break-even cannot be calculated with the current data.',
    },
    profit: {
      revenue:  total_revenue,
      expenses: total_expenses,
      result:   profit,
      margin:   profit_margin,
      formula:
        `Revenue (${fmtD(total_revenue)}) − Total Expenses (${fmtD(total_expenses)}) = ` +
        `${profit >= 0 ? '' : '-'}${fmtD(Math.abs(profit))}` +
        (profit_margin != null ? ` (${fmtP(profit_margin)} margin)` : ''),
    },
  };

  return {
    total_revenue, total_payroll, total_material,
    total_fixed, total_variable, prime_cost,
    total_expenses, profit, profit_margin,
    prime_pct, break_even,
    revenueBySplit, expenseByCat, calc_detail,
  };
}

function runWhatIf({
  base,
  salesChange = 0, payrollChange = 0, materialChange = 0,
  fixedChange = 0, variableChange = 0,
}) {
  const s_rev = base.total_revenue  * (1 + salesChange / 100);
  const s_pay = base.total_payroll  + payrollChange;
  const s_mat = base.total_material * (1 + materialChange / 100);
  const s_fix = base.total_fixed    + fixedChange;
  const s_var = base.total_variable * (1 + variableChange / 100);
  const s_pri = s_pay + s_mat;
  const s_exp = s_fix + s_var + s_pri;
  const s_pro = s_rev - s_exp;
  const tr    = s_rev || 1;
  const vc    = s_pri + s_var;
  const cm    = 1 - vc / tr;
  return {
    base,
    scenario: {
      total_revenue:  s_rev,
      total_payroll:  s_pay,
      total_material: s_mat,
      total_fixed:    s_fix,
      total_variable: s_var,
      prime_cost:     s_pri,
      total_expenses: s_exp,
      profit:         s_pro,
      profit_margin:  s_pro / tr * 100,
      break_even:     cm > 0.01 ? s_fix / cm : 0,
    },
    delta: {
      revenue:       s_rev - base.total_revenue,
      profit:        s_pro - base.profit,
      profit_margin: s_pro / tr * 100 - base.profit_margin,
    },
  };
}

module.exports = { calculateMetrics, runWhatIf, findAmbiguous, categorizeCost };
