'use strict';
/**
 * SandCastle — Pluggable Category Taxonomy
 *
 * Single source of truth for canonical category names used across
 * parser.js, calculations.js, db.js, and the UI.
 *
 * Restaurant is the only type today. Adding retail/salon/gym etc. means
 * adding one new config object to TAXONOMIES — no other file changes needed.
 */

// ─────────────────────────────────────────────────────────────────────────────
// RESTAURANT
// ─────────────────────────────────────────────────────────────────────────────
const RESTAURANT = {

  // ── Revenue map ───────────────────────────────────────────────────────────
  // Keys:   normalised raw label  (underscores→spaces, lowercase, trimmed)
  // Values: canonical display name
  revenue: {
    // Food
    'food':                        'Food',
    'food sales':                  'Food',
    'food revenue':                'Food',
    'food & beverage':             'Food',
    'food & bev':                  'Food',
    'f&b':                         'Food',
    'f & b':                       'Food',
    'kitchen':                     'Food',
    'menu items':                  'Food',
    'food items':                  'Food',
    'food & drink - food':         'Food',
    'food and drink - food':       'Food',
    'food and beverage':           'Food',

    // Non-Alcoholic Beverages
    'non-alcoholic':               'Non-Alcoholic Beverages',
    'non alcoholic':               'Non-Alcoholic Beverages',
    'na beverages':                'Non-Alcoholic Beverages',
    'na bev':                      'Non-Alcoholic Beverages',
    'n/a beverages':               'Non-Alcoholic Beverages',
    'soft drinks':                 'Non-Alcoholic Beverages',
    'soft drinks & juice':         'Non-Alcoholic Beverages',
    'soda':                        'Non-Alcoholic Beverages',
    'juice':                       'Non-Alcoholic Beverages',
    'coffee':                      'Non-Alcoholic Beverages',
    'tea':                         'Non-Alcoholic Beverages',
    'coffee & tea':                'Non-Alcoholic Beverages',
    'beverages':                   'Non-Alcoholic Beverages',
    'beverage':                    'Non-Alcoholic Beverages',
    'non-alcoholic beverages':     'Non-Alcoholic Beverages',

    // Beer
    'beer':                        'Beer',
    'beer sales':                  'Beer',
    'draft beer':                  'Beer',
    'beer & cider':                'Beer',
    'beers':                       'Beer',
    'domestic beer':               'Beer',
    'craft beer':                  'Beer',
    'beer & draft':                'Beer',

    // Wine
    'wine':                        'Wine',
    'wine sales':                  'Wine',
    'wines':                       'Wine',
    'wine by glass':               'Wine',
    'wine by bottle':              'Wine',
    'house wine':                  'Wine',

    // Spirits & Cocktails
    'spirits':                     'Spirits & Cocktails',
    'spirits & cocktails':         'Spirits & Cocktails',
    'spirits and cocktails':       'Spirits & Cocktails',
    'cocktails':                   'Spirits & Cocktails',
    'liquor':                      'Spirits & Cocktails',
    'bar':                         'Spirits & Cocktails',
    'bar sales':                   'Spirits & Cocktails',
    'call spirits':                'Spirits & Cocktails',
    'premium spirits':             'Spirits & Cocktails',

    // Alcohol (catch-all when not broken down further)
    'alcohol':                     'Alcohol',
    'alcohol sales':               'Alcohol',
    'alcoholic beverages':         'Alcohol',
    'alcoholic bev':               'Alcohol',
    'bar & beverage':              'Alcohol',
    'food & drink - alcohol':      'Alcohol',
    'food and drink - alcohol':    'Alcohol',

    // Catering & Events
    'catering':                    'Catering & Events',
    'events':                      'Catering & Events',
    'catering & events':           'Catering & Events',
    'event revenue':               'Catering & Events',
    'private events':              'Catering & Events',
    'private event revenue':       'Catering & Events',
    'banquet':                     'Catering & Events',
    'banquet revenue':             'Catering & Events',

    // Retail & Merchandise
    'retail':                      'Retail & Merchandise',
    'merchandise':                 'Retail & Merchandise',
    'retail & merchandise':        'Retail & Merchandise',
    'merch':                       'Retail & Merchandise',
    'gift cards':                  'Retail & Merchandise',
    'retail sales':                'Retail & Merchandise',
    'merchandise sales':           'Retail & Merchandise',
    'other':                       'Retail & Merchandise',
    'other revenue':               'Retail & Merchandise',
  },

  // ── Expense map ───────────────────────────────────────────────────────────
  expense: {
    // ── Material: food & drink cost of goods ──────────────────────────────
    // Legacy plain names (pre-taxonomy) — kept so old saved data still classifies
    'food':                        'Food Cost',
    'ingredients':                 'Food Cost',
    'produce':                     'Food Cost',
    'meat':                        'Food Cost',
    'dairy':                       'Food Cost',
    // Canonical names
    'food cost':                   'Food Cost',
    'food costs':                  'Food Cost',
    'food & beverage cost':        'Food Cost',
    'food and beverage cost':      'Food Cost',
    'cogs - food':                 'Food Cost',
    'cost of goods':               'Food Cost',
    'cost of goods sold':          'Food Cost',
    'cogs':                        'Food Cost',

    'beer':                        'Beer Cost',
    'beer cost':                   'Beer Cost',
    'beer costs':                  'Beer Cost',
    'cogs - beer':                 'Beer Cost',
    'draft cost':                  'Beer Cost',

    'wine':                        'Wine Cost',
    'wine cost':                   'Wine Cost',
    'wine costs':                  'Wine Cost',
    'cogs - wine':                 'Wine Cost',

    'spirits':                     'Spirits Cost',
    'spirits cost':                'Spirits Cost',
    'spirits costs':               'Spirits Cost',
    'liquor cost':                 'Spirits Cost',
    'cogs - spirits':              'Spirits Cost',
    'cogs - liquor':               'Spirits Cost',

    'alcohol':                     'Beverage Cost',
    'alcoholic beverages':         'Beverage Cost',
    'beverages':                   'Beverage Cost',
    'beverages - alcohol':         'Beverage Cost',
    'beverage cost':               'Beverage Cost',
    'beverage costs':              'Beverage Cost',
    'alcohol cost':                'Beverage Cost',
    'alcohol costs':               'Beverage Cost',
    'bar cost':                    'Beverage Cost',
    'cogs - beverage':             'Beverage Cost',

    'non-alcoholic':               'Non-Alcoholic Beverage Cost',
    'non alcoholic':               'Non-Alcoholic Beverage Cost',
    'beverages - na':              'Non-Alcoholic Beverage Cost',
    'na bev':                      'Non-Alcoholic Beverage Cost',
    'non-alcoholic beverage cost': 'Non-Alcoholic Beverage Cost',

    // ── Fixed ─────────────────────────────────────────────────────────────
    'rent':                        'Rent',
    'rent expense':                'Rent',
    'base rent':                   'Rent',
    'rent & occupancy':            'Rent',
    'occupancy':                   'Rent',
    'occupancy cost':              'Rent',

    'equipment':                   'Equipment & Leases',
    'equipment lease':             'Equipment & Leases',
    'equipment leases':            'Equipment & Leases',
    'equipment & leases':          'Equipment & Leases',
    'leases':                      'Equipment & Leases',
    'lease':                       'Equipment & Leases',
    'equipment rental':            'Equipment & Leases',

    'insurance':                   'Insurance',
    'general insurance':           'Insurance',
    'liability insurance':         'Insurance',
    'property insurance':          'Insurance',

    'pos':                         'POS & Software',
    'pos & software':              'POS & Software',
    'pos software':                'POS & Software',
    'software':                    'POS & Software',
    'technology':                  'POS & Software',
    'subscriptions':               'POS & Software',
    'pos & tech':                  'POS & Software',
    'tech & software':             'POS & Software',

    'marketing':                   'Marketing',
    'advertising':                 'Marketing',
    'advertising & marketing':     'Marketing',
    'social media':                'Marketing',
    'digital marketing':           'Marketing',
    'promotions':                  'Marketing',

    'accounting':                  'Accounting & Legal',
    'legal':                       'Accounting & Legal',
    'accounting & legal':          'Accounting & Legal',
    'bookkeeping':                 'Accounting & Legal',
    'professional fees':           'Accounting & Legal',
    'legal & professional':        'Accounting & Legal',

    'licenses':                    'Licenses & Permits',
    'permits':                     'Licenses & Permits',
    'licenses & permits':          'Licenses & Permits',
    'liquor license':              'Licenses & Permits',
    'business license':            'Licenses & Permits',
    'health permit':               'Licenses & Permits',

    // ── Variable ─────────────────────────────────────────────────────────
    'utilities':                   'Utilities',
    'electricity':                 'Utilities',
    'gas':                         'Utilities',
    'water':                       'Utilities',
    'gas & electric':              'Utilities',
    'electric & gas':              'Utilities',
    'energy':                      'Utilities',

    'cleaning':                    'Cleaning & Supplies',
    'cleaning & supplies':         'Cleaning & Supplies',
    'supplies':                    'Cleaning & Supplies',
    'cleaning supplies':           'Cleaning & Supplies',
    'paper goods':                 'Cleaning & Supplies',
    'disposables':                 'Cleaning & Supplies',
    'smallwares':                  'Cleaning & Supplies',

    'linens':                      'Linens & Laundry',
    'linens & laundry':            'Linens & Laundry',
    'laundry':                     'Linens & Laundry',
    'linen service':               'Linens & Laundry',

    'repairs':                     'Repairs & Maintenance',
    'maintenance':                 'Repairs & Maintenance',
    'repairs & maintenance':       'Repairs & Maintenance',
    'r&m':                         'Repairs & Maintenance',
    'repair & maintenance':        'Repairs & Maintenance',
    'equipment repair':            'Repairs & Maintenance',

    'credit card fees':            'Credit Card Fees',
    'processing fees':             'Credit Card Fees',
    'payment processing':          'Credit Card Fees',
    'merchant fees':               'Credit Card Fees',

    'delivery fees':               'Delivery & Commissions',
    'delivery & commissions':      'Delivery & Commissions',
    'commissions':                 'Delivery & Commissions',
    'third party fees':            'Delivery & Commissions',
  },

  // ── Sets used by calculations.js ─────────────────────────────────────────
  // Canonical names that are material cost.  Variable = not in either set.
  materialCategories: new Set([
    'Food Cost', 'Beer Cost', 'Wine Cost', 'Spirits Cost',
    'Beverage Cost', 'Non-Alcoholic Beverage Cost',
  ]),
  fixedCategories: new Set([
    'Rent', 'Equipment & Leases', 'Insurance', 'POS & Software',
    'Marketing', 'Accounting & Legal', 'Licenses & Permits',
  ]),

  // ── KPI thresholds ────────────────────────────────────────────────────────
  kpiThresholds: {
    prime_cost_pct: { ok: 65, warn: 75 },
    payroll_pct:    { ok: 35, warn: 45 },
    material_pct:   { ok: 30, warn: 38 },
    fixed_pct:      { ok: 20, warn: 28 },
  },
};

// ─────────────────────────────────────────────────────────────────────────────
// REGISTRY  —  add new business types here only
// ─────────────────────────────────────────────────────────────────────────────
const TAXONOMIES = {
  restaurant: RESTAURANT,
  // retail: RETAIL,
  // salon:  SALON,
  // gym:    GYM,
};

// ─────────────────────────────────────────────────────────────────────────────
// PUBLIC API
// ─────────────────────────────────────────────────────────────────────────────

/** Returns the taxonomy config for a business type (falls back to restaurant). */
function getTaxonomy(businessType) {
  return TAXONOMIES[businessType] || TAXONOMIES.restaurant;
}

/** Returns all registered business type keys. */
function getBusinessTypes() {
  return Object.keys(TAXONOMIES);
}

/**
 * Canonicalize a raw category string.
 *
 * @param {string} raw            Raw label from CSV or user input
 * @param {'revenue'|'expense'}   mapType
 * @param {string} [businessType] Defaults to 'restaurant'
 * @returns {string} Canonical display name; title-cased if unknown
 */
function canonicalizeCategory(raw, mapType, businessType) {
  if (!raw) return 'Other';
  const tax = getTaxonomy(businessType || 'restaurant');
  const map = tax[mapType] || {};

  // Normalise: underscore→space, collapse whitespace, lowercase, trim
  const normalized = String(raw)
    .replace(/_/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();

  if (map[normalized]) return map[normalized];

  // Simple plural fallback: "wines" → "wine"
  if (normalized.endsWith('s') && map[normalized.slice(0, -1)]) {
    return map[normalized.slice(0, -1)];
  }

  // Unknown — return title-cased original for clean display
  return String(raw)
    .replace(/_/g, ' ')
    .trim()
    .replace(/\b\w/g, c => c.toUpperCase());
}

module.exports = { getTaxonomy, getBusinessTypes, canonicalizeCategory };
