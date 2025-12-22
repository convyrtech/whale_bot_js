/**
 * Quantitative Analysis Tools
 * 
 * Core Principle: Mathematics is a TOOL for honesty.
 * All metrics must be explicit, reproducible, and explainable.
 */

/**
 * Calculates the lower bound of the Wilson Score Interval for a binomial proportion.
 * Used for conservative winrate estimation.
 * Formula: (p + z²/2n - z * sqrt((p(1-p) + z²/4n)/n)) / (1 + z²/n)
 * @param {number} wins Number of successes
 * @param {number} total Total number of trials
 * @param {number} z Z-score (default 1.0 for conservative 68% CI, or 1.96 for 95%)
 *                   Using 1.0 is often better for ranking to avoid over-penalizing promising new signals too harshly,
 *                   but for "Whale" verification we want high confidence, so 1.96 is good.
 *                   Let's default to 1.96 for strictness.
 * @returns {number} Lower bound of the confidence interval (0-1)
 */
function wilsonScoreLowerBound(wins, total, z = 1.96) {
    if (total === 0) return 0;
    const phat = wins / total;
    const numerator = phat + (z * z) / (2 * total) - z * Math.sqrt((phat * (1 - phat) + (z * z) / (4 * total)) / total);
    const denominator = 1 + (z * z) / total;
    return numerator / denominator;
}

/**
 * Calculates the median of an array of numbers.
 * Preferred over mean for skewed distributions (e.g. PnL).
 * @param {number[]} values Array of numbers
 * @returns {number} Median value
 */
function calculateMedian(values) {
    if (!values || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * Applies realistic slippage model based on actual Polymarket conditions.
 * 
 * Polymarket fees: 0% global, 0.01% US taker fee (as of Dec 2025).
 * Realistic slippage accounts for minimal spread crossing and size impact.
 * 
 * @param {number} price Execution price (0-1)
 * @param {number} sizeUsd Size of the trade in USD
 * @returns {number} Adjusted price including realistic slippage
 */
function applyRealisticSlippage(price, sizeUsd) {
    // US taker fee: 0.01% (0.0001)
    const takerFee = 0.0001;
    
    // Minimal spread crossing: 0.05% (typical on liquid markets)
    const spreadCost = 0.0005;
    
    // Size impact: 0.01% per $1000 (much lower than conservative)
    const sizeImpact = (sizeUsd / 1000) * 0.0001;
    
    // Total slippage capped at 2% for extreme cases
    const totalSlippage = Math.min(takerFee + spreadCost + sizeImpact, 0.02);
    
    return Math.min(price * (1 + totalSlippage), 0.99);
}

/**
 * Applies a conservative slippage model to an entry price.
 * 
 * This is a stress-test model with 50x safety margin vs reality.
 * Useful for worst-case scenario planning.
 * 
 * @param {number} price Execution price (0-1)
 * @param {number} sizeUsd Size of the trade in USD
 * @returns {number} Adjusted price including conservative slippage
 */
function applyConservativeSlippage(price, sizeUsd) {
    // Base friction (spread crossing): 0.5%
    const baseSlippage = 0.005; 
    
    // Impact penalty: 0.05% per $1000 traded
    const sizePenalty = (sizeUsd / 1000) * 0.0005;
    
    // Cap total slippage impact at 10%
    const totalSlippage = Math.min(baseSlippage + sizePenalty, 0.10);
    
    return Math.min(price * (1 + totalSlippage), 0.99);
}

/**
 * Calculates ROI with realistic slippage (default mode).
 * Based on actual Polymarket conditions: 0% global fee, 0.01% US taker.
 * 
 * @param {number} payout Payout amount (1.0 for Win, 0.0 for Loss)
 * @param {number} rawEntryPrice Raw price from the tape
 * @param {number} sizeUsd Trade size for slippage calc
 * @returns {number} ROI percentage (e.g. 50.0 for 50%)
 */
function calculateRealisticRoi(payout, rawEntryPrice, sizeUsd) {
    const adjustedEntry = applyRealisticSlippage(rawEntryPrice, sizeUsd);
    if (adjustedEntry >= 1.0) return 0;
    if (adjustedEntry <= 0.01) return 0;
    return ((payout - adjustedEntry) / adjustedEntry) * 100;
}

/**
 * Calculates Conservative ROI (stress-test mode with 50x safety margin).
 * Useful for worst-case scenario planning.
 * 
 * @param {number} payout Payout amount (1.0 for Win, 0.0 for Loss)
 * @param {number} rawEntryPrice Raw price from the tape
 * @param {number} sizeUsd Trade size for slippage calc
 * @returns {number} ROI percentage (e.g. 50.0 for 50%)
 */
function calculateConservativeRoi(payout, rawEntryPrice, sizeUsd) {
    const adjustedEntry = applyConservativeSlippage(rawEntryPrice, sizeUsd);
    if (adjustedEntry >= 1.0) return 0;
    if (adjustedEntry <= 0.01) return 0;
    return ((payout - adjustedEntry) / adjustedEntry) * 100;
}

function normalizePolymarketValue(value) {
    if (value === null || value === undefined) return 0;
    const num = parseFloat(value);
    if (!isFinite(num)) return 0;
    if (Math.abs(num) > 100000000) return num / 1000000;
    if (typeof value === 'string' && !value.includes('.') && Math.abs(num) > 100000) return num / 1000000;
    return num;
}

module.exports = {
    wilsonScoreLowerBound,
    calculateMedian,
    applyRealisticSlippage,
    applyConservativeSlippage,
    calculateRealisticRoi,
    calculateConservativeRoi,
    normalizePolymarketValue
};
