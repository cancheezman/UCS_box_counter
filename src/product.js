'use strict';

// UCS product identification.
//
// Known UCS product ID: 7890199412991.
// Also match product names containing "Ultimate Cheese Subscription",
// "The Ultimate Cheese Subscription", or "UCS" (whole-word).

const UCS_PRODUCT_ID = '7890199412991';

const NAME_PATTERNS = [
  /\bThe Ultimate Cheese Subscription\b/i,
  /\bUltimate Cheese Subscription\b/i,
  /\bUCS\b/,
];

function isUcsProductId(productId) {
  if (productId === null || productId === undefined) return false;
  return String(productId).trim() === UCS_PRODUCT_ID;
}

function isUcsProductName(productName) {
  if (!productName || typeof productName !== 'string') return false;
  return NAME_PATTERNS.some((re) => re.test(productName));
}

/**
 * Returns { match: boolean, method: 'product_id' | 'name' | null }.
 * Product ID is primary; product name is fallback.
 */
function matchUcs({ productId, productName } = {}) {
  if (isUcsProductId(productId)) return { match: true, method: 'product_id' };
  if (isUcsProductName(productName)) return { match: true, method: 'name' };
  return { match: false, method: null };
}

module.exports = {
  UCS_PRODUCT_ID,
  isUcsProductId,
  isUcsProductName,
  matchUcs,
};
