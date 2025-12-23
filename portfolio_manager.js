const db = require('./database');
const logger = require('./utils/logger');

// Constants
const MIN_SCORE_TO_BET = 75; // Softer threshold for real bets
const MIN_SCORE_WATCH = 45;  // Broader watch window

/**
 * Smart Portfolio Manager
 * Implements strict capital preservation and correlation risk management.
 * Starting Bankroll: $20.00
 */

// Scoring Weights (Total 100)
const WEIGHTS = {
    WINRATE: 50, // Wilson Score Lower Bound (High Confidence)
    MEDIAN: 30,  // Median PnL (Consistency)
    VOLUME: 20   // Experience
};

// Category Multipliers
const CATEGORY_WEIGHTS = {
    'politics': 1.1, // +10% Boost (Historically profitable)
    'crypto': 1.1,   // +10% Boost
    'sports': 0.9,   // -10% Penalty (High variance)
    'weather': 1.0,
    'other': 1.0
};

// Category-specific tuning thresholds
const CATEGORY_TUNING = {
    default: { lbBase: 30, lbTarget: 60, medTarget: 50, volTargetTrades: 20 },
    politics: { lbBase: 25, lbTarget: 55, medTarget: 40, volTargetTrades: 25 },
    crypto:   { lbBase: 20, lbTarget: 50, medTarget: 20, volTargetTrades: 15 },
    sports:   { lbBase: 35, lbTarget: 65, medTarget: 50, volTargetTrades: 30 },
    weather:  { lbBase: 30, lbTarget: 60, medTarget: 30, volTargetTrades: 15 },
    other:    { lbBase: 30, lbTarget: 60, medTarget: 30, volTargetTrades: 15 }
};

/**
 * Evaluates a signal based on whale stats and market conditions.
 * @param {Object} signal - Trade data (price, etc.)
 * @param {Object} whaleStats - Stats from whale_logic (Structured by category)
 * @param {string} category - Market category (politics, sports, etc.)
 * @returns {number} Score (0-100)
 */
function evaluateSignal(signal, whaleStats, category = 'global') {
    if (!whaleStats) return 0;

    // 1. Select Context (Category vs Global)
    // Default to global stats
    let stats = whaleStats.global || whaleStats; 
    let context = 'Global';

    // If we have specific category stats and enough data (e.g. > 3 trades), use them
    // This prevents "Sports Gamblers" from being followed in Politics, and vice versa.
    if (whaleStats[category] && whaleStats[category].totalTrades >= 3) {
        stats = whaleStats[category];
        context = category;
    }

    // 2. Category-specific tuning thresholds
    const t = CATEGORY_TUNING[category] || CATEGORY_TUNING.default;

    // 3. Winrate Score (Wilson Lower Bound)
    // Baseline: t.lbBase% → 0 pts. Target: t.lbTarget% → WEIGHTS.WINRATE pts.
    const lb = stats.winrateLowerBound || 0;
    let wrScore = 0;
    if (lb > t.lbBase) {
        wrScore = Math.min(WEIGHTS.WINRATE, (lb - t.lbBase) * (WEIGHTS.WINRATE / (t.lbTarget - t.lbBase)));
    }

    // 4. Median PnL Score (Consistency)
    // Baseline: $0 → 0 pts. Target: $t.medTarget → WEIGHTS.MEDIAN pts.
    const med = stats.medianPnl || 0;
    let medScore = 0;
    if (med > 0) {
        medScore = Math.min(WEIGHTS.MEDIAN, med * (WEIGHTS.MEDIAN / t.medTarget));
    }

    // 5. Volume Score (Experience)
    // Target: t.volTargetTrades trades → WEIGHTS.VOLUME pts.
    const trades = stats.totalTrades || 0;
    let volScore = Math.min(WEIGHTS.VOLUME, trades * (WEIGHTS.VOLUME / t.volTargetTrades));

    let totalScore = wrScore + medScore + volScore;

    // 6. Price Penalty (Risk/Reward Check)
    // Penalize if price is too high (>0.75) or too low (<0.20)
    const price = Number(signal.entry_price || signal.price || 0);
    if (price > 0.75 || price < 0.20) {
        totalScore -= 30; // Heavy penalty
    }

    // 7. Tilt Breaker (Streak Check)
    // If whale is on a losing streak (<= -3), apply massive penalty
    const streak = stats.streak || 0;
    if (streak <= -3) {
        logger.warn(`[Tilt Breaker] Whale ${context} streak is ${streak}. Applying -50 penalty.`);
        totalScore -= 50;
    }

    // 8. Category Multiplier
    const multiplier = CATEGORY_WEIGHTS[category] || 1.0;
    totalScore *= multiplier;

    // 9. "Money Talks" Bonus (High Conviction Bet)
    const tradeSize = Number(signal.size_usd || 0);
    if (tradeSize > 2000) {
        totalScore += 10; // Whale is very confident
    } else if (tradeSize > 500) {
        totalScore += 5;  // Whale is confident
    }

    logger.debug(`[Score] Context: ${context} | Streak: ${streak} | Size: $${tradeSize} | Final: ${Math.round(totalScore)}`);

    return Math.max(0, Math.round(totalScore));
}

/**
 * Calculates bet size based on strict score thresholds.
 * @param {number} balance - Current available balance
 * @param {number} score - Signal score (0-100)
 * @returns {number} Bet amount in USD
 */
function calculateBetSize(balance, score) {
    // Strict Threshold: Skip everything below MIN_SCORE_TO_BET
    if (score < MIN_SCORE_TO_BET) {
        logger.debug(`[Portfolio] Score ${score} < ${MIN_SCORE_TO_BET}. Bet: $0`);
        return 0;
    }

    let pct = 0;
    if (score >= 90) {
        pct = 0.10; // High Conviction
    } else {
        pct = 0.05; // Medium Conviction (80-89)
    }

    let bet = balance * pct;

    // Min bet $1.00 rule
    if (bet < 1) {
        bet = (balance >= 1) ? 1 : 0;
    }

    // Cap at balance
    if (bet > balance) bet = balance;

    const finalBet = Math.floor(bet * 100) / 100;
    logger.debug(`[Portfolio] Bal: $${balance}, Score: ${score}, Pct: ${pct}, Bet: $${finalBet}`);
    
    return finalBet;
}

module.exports = {
    evaluateSignal,
    calculateBetSize,
    MIN_SCORE_TO_BET,
    MIN_SCORE_WATCH
};
