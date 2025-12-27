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

// VIP Whitelist (Unicorns) - Auto-generated from analysis
const VIP_WHALES = new Set([
    '0xa6676646a16d8c7044ea2ac7e2b9ab09eb7384fe',
    '0xbacd00c9080a82ded56f504ee8810af732b0ab35',
    '0x34134e7c29b654c4f53ec213e6f35808b3f05204',
    '0x0a61e40ebf154825b164382cd932ece781cf2c6b',
    '0x06dcaa14f57d8a0573f5dc5940565e6de667af59',
    '0x8c29c7dfc74dcba9ce921e2d787bbf1ac61f6fff',
    '0xf5cfe6f998d597085e366f915b140e82e0869fc6',
    '0x689ae12e11aa489adb3605afd8f39040ff52779e',
    '0x8fe70c889ce14f67acea5d597e3d0351d73b4f20',
    '0x6e50e67d55ed633a4f64a05d168240ac7a23487b'
]);

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

    // 10. VIP Whitelist Bonus
    if (VIP_WHALES.has(signal.whale_address)) {
        totalScore += 20; // Massive boost for proven unicorns
        logger.info(`🦄 VIP WHALE DETECTED: ${signal.whale_address} (+20 Score)`);
    }

    // 11. Blacklist Check (Anti-Loser)
    if (stats.totalTrades > 3 && stats.winrate < 20) {
        logger.warn(`🚫 BLACKLISTED WHALE: ${signal.whale_address} (Winrate < 20%). Score -> 0.`);
        return 0;
    }

    // 12. Sports Filter (Strict)
    if (category === 'sports' && stats.winrate < 50) {
        logger.warn(`🚫 SPORTS FILTER: Whale winrate ${stats.winrate}% < 50%. Score -> 0.`);
        return 0;
    }

    logger.debug(`[Score] Context: ${context} | Streak: ${streak} | Size: $${tradeSize} | Final: ${Math.round(totalScore)}`);

    return Math.max(0, Math.round(totalScore));
}

/**
 * Calculates bet size based on strict score thresholds.
 * @param {number} balance - Current available balance
 * @param {number} score - Signal score (0-100)
 * @param {string} category - Market category
 * @returns {number} Bet amount in USD
 */
function calculateBetSize(balance, score, category = 'other') {
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

    // --- SMART SIZING (Alpha Generation) ---
    // Double down on Politics/News/Other where we have edge
    if (category === 'politics' || category === 'other') {
        pct *= 2.0; 
        logger.info(`[Smart Sizing] Doubling bet for ${category} (Edge detected)`);
    }
    // ---------------------------------------

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
