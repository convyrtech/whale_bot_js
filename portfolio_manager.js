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

// Category Multipliers (Data-driven adjustments)
const CATEGORY_WEIGHTS = {
    'politics': 2.0, // +100% Boost (ROI +28% real)
    'crypto': 0.5,   // Penalty (ROI -4.8% real) - High volume churn
    'sports': 0.0,   // BAN (-62% ROI)
    'weather': 1.2,  // Slight boost (Positive ROI)
    'other': 1.1     // Good ROI
};

// VIP Whitelist (Unicorns) - Auto-generated from analysis
// Criteria: >3 trades, >50% WR, High ROI
const VIP_WHALES = new Set([
    '0xa6676646a16d8c7044ea2ac7e2b9ab09eb7384fe',
    '0xbacd00c9080a82ded56f504ee8810af732b0ab35',
    '0x34134e7c29b654c4f53ec213e6f35808b3f05204',
    // New Top Performers (ROI > 500%)
    '0xa8fa67aed008fd99268d60923032a914462277b5', // 100% WR, +2659% ROI
    '0x48ca7d1e7fc66464078daeb5090ce477ddc8aa1b', // 100% WR, +2425% ROI
    '0x6dad6e29c1879058181b9e0cfd2797d7939f5c37', // 100% WR, +2007% ROI
    '0x7a7fe4613646b1de20644fd94e50f53597476a3a', // 67% WR, +1512% ROI
    '0xf472fe403eb6005a5a4b6467bbd271e3d295a262', // 50% WR, +1469% ROI
    '0xc6dd722558dbfbd8fa780efcbe819ed8c6604b9f', // 100% WR, +1244% ROI
    '0x06dcaa14f57d8a0573f5dc5940565e6de667af59', // 100% WR, +1015% ROI
    '0x8c29c7dfc74dcba9ce921e2d787bbf1ac61f6fff', // 100% WR, +670% ROI
    '0x6b3a549080f043f5ac2433a30e5ce154c7782841'  // 25% WR, +607% ROI (High payoff)
]);

// Blacklist (Scam/Loser Whales) - 0% WR
const BLACKLIST_WHALES = new Set([
    '0x0305183eaa4ce55d3ca3f406cbba879cad94093a',
    '0x06c4e7a73af5048df26ef6fef1ded51fc36ef726',
    '0x06e64174adde7055e56c4dbb75596098e4c787e6',
    '0x0ae49502214d903677022a2627f8cb27e7dba659',
    '0x0db9cb518eb59852efda348ed0de4c11d56c7d77',
    '0x14a056c698f46d181d1e650e7a7a0f7d1d8a22bb',
    '0x16e44c669dfb6f75a11a1a6dc95bb91898620641',
    '0x1963c5be51cf05db473ca7b52c3afb8e11d1dd0c'
]);

// Category-specific tuning thresholds
const CATEGORY_TUNING = {
    default: { lbBase: 30, lbTarget: 60, medTarget: 50, volTargetTrades: 20 },
    politics: { lbBase: 20, lbTarget: 50, medTarget: 30, volTargetTrades: 10 }, // Looser for Politics (It pays)
    crypto: { lbBase: 30, lbTarget: 58, medTarget: 30, volTargetTrades: 20 }, // Stricter for Crypto (was 25/55)
    sports: { lbBase: 80, lbTarget: 90, medTarget: 100, volTargetTrades: 50 }, // Extremely strict for Sports
    weather: { lbBase: 30, lbTarget: 60, medTarget: 30, volTargetTrades: 15 },
    other: { lbBase: 30, lbTarget: 60, medTarget: 30, volTargetTrades: 15 }
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

    // 0. Blacklist Check (Hard Fail)
    if (BLACKLIST_WHALES.has(signal.whale_address)) {
        logger.debug(`🚫 BLACKLISTED WHALE DETECTED: ${signal.whale_address}. Score -> 0.`);
        return 0;
    }

    // 0.1 Category Ban (Sports)
    if (category === 'sports') {
        logger.debug(`🚫 SPORTS BAN: Skipping sport trade.`);
        return 0;
    }

    // 0.2 PROBABILITY BANDS (The "Barbell" Safety Valve)
    // Data Audit showed that 40-70% odds is a "Death Zone" (-12% ROI).
    // We only trade "Longshots" (< 40%) or "Safe Bets" (> 70%).
    const entryPrice = Number(signal.entry_price || 0);
    if (entryPrice > 0.40 && entryPrice < 0.70) {
        logger.debug(`🚫 TOXIC ZONE: Skipping trade at ${(entryPrice * 100).toFixed(0)}% odds.`);
        return 0;
    }

    // 0.2 Special Strategy Bypass
    // Some strategies (like Insider) don't rely on whale stats history.
    // If the signal comes with a 'forceScore' or 'score', we use that base.
    if (signal.strategyScore && signal.strategy === 'strategy_insider') {
        logger.debug(`🎯 INSIDER STRATEGY: Bypassing stats. Using Strategy Score: ${signal.strategyScore}`);
        return signal.strategyScore;
    }

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

    // 3. Winrate Score (Wilson Score Lower Bound)
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
    // Penalize only if price is too high (>0.85).
    // We REMOVED penalty for < 0.20 because Deep Audit showed +912% ROI there!
    const price = Number(signal.entry_price || signal.price || 0);
    if (price > 0.85) {
        totalScore -= 20;
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
        totalScore += 25; // Boosted VIP bonus (was 20)
        logger.info(`🦄 VIP WHALE DETECTED: ${signal.whale_address} (+25 Score)`);
    }

    // 11. Blacklist Check (Anti-Loser) - Dynamic
    if (stats.totalTrades > 5 && stats.winrate < 25) {
        logger.warn(`🚫 LOW WINRATE: ${signal.whale_address} (Winrate < 25%). Score -> 0.`);
        return 0;
    }

    // 12. Sports Filter (Strict) - Redundant with category ban but keeping as safeguard
    if (category === 'sports' && stats.winrate < 60) {
        return 0;
    }

    logger.debug(`[Score] Context: ${context} | Streak: ${streak} | Size: $${tradeSize} | Final: ${Math.round(totalScore)}`);

    return Math.max(0, Math.round(totalScore));
}

/**
 * Calculates bet size based on Kelly Criterion and confidence.
 * @param {number} balance - Current available balance
 * @param {number} score - Signal score (0-100)
 * @param {string} category - Market category
 * @param {number} price - Entry price (0-1)
 * @param {number} hoursRem - Hours remaining until resolution
 * @returns {number} Bet amount in USD
 */
function calculateBetSize(balance, score, category = 'other', price = 0.50, hoursRem = 999) {
    // 1. Strict Filter
    if (score < MIN_SCORE_TO_BET) {
        logger.debug(`[Portfolio] Score ${score} < ${MIN_SCORE_TO_BET}. Bet: $0`);
        return 0;
    }

    // 2. Kelly Criterion Inputs
    // Estimated Win Probability: We map Score 60->100 to WinProb 55%->90%
    let p_estimated = 0.55 + ((score - 60) / 40) * 0.35;
    if (p_estimated > 0.90) p_estimated = 0.90;
    if (p_estimated < 0.51) p_estimated = 0.51;

    // b = odds - 1
    const b = (1 / price) - 1;
    const q = 1 - p_estimated;
    let kellyPct = ((b * p_estimated) - q) / b;

    // 3. Safety: Fractional Kelly (Quarter Kelly)
    let targetPct = kellyPct * 0.25;

    if (targetPct <= 0) return 0;

    // 4. Boosts
    // A. Category Edge
    if (category === 'politics' || category === 'other') {
        targetPct *= 1.5;
    }

    // B. DOPAMINE BOOST (Impatience Exploit)
    // Markets resolving SOON (< 6h) get a boost because velocity of money is high.
    // SAFETY VALVE: Only boost if score is High Conviction (85+). 
    // We don't want to rush into low-quality signals just because they are fast.
    if (hoursRem < 6 && score >= 85) {
        targetPct *= 1.25; // 25% Boost for "Flash Markets"
    }

    // 5. Hard Caps
    if (targetPct > 0.15) targetPct = 0.15; // Max 15% per trade

    let bet = balance * targetPct;
    if (bet > 5000) bet = 5000; // Max $5,000 liquidity cap

    if (bet < 10) bet = (balance >= 10) ? 10 : 0;
    if (bet > balance) bet = balance;

    const finalBet = Math.floor(bet * 100) / 100;
    const boostMsg = (hoursRem < 6) ? ` ⚡ FLASH BOOST (${hoursRem.toFixed(1)}h)` : '';
    logger.info(`[Kelly Money Manager]${boostMsg} Price: ${price.toFixed(2)} | Edge: ${((p_estimated - price) * 100).toFixed(1)}% | Kelly: ${(kellyPct * 100).toFixed(1)}% -> Safe: ${(targetPct * 100).toFixed(1)}% | Bet: $${finalBet}`);
    return finalBet;
}

module.exports = {
    evaluateSignal,
    calculateBetSize,
    MIN_SCORE_TO_BET,
    MIN_SCORE_WATCH
};
