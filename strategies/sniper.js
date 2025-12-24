const math = require('../math_utils');
const logger = require('../utils/logger');

/**
 * Strategy A: Sniper Whale (Classic)
 * Logic: Follow profitable whales with high winrate.
 */

const CONFIG = {
    MIN_SCORE: 75,
    MIN_HISTORY_TRADES: 5,
    MIN_WINRATE: 0.55
};

module.exports = {
    id: 'strategy_sniper',
    name: 'Sniper Whale',
    description: 'Follows high-winrate, profitable whales.',

    evaluate: (trade, whaleStats) => {
        // 1. Calculate Score (0-100)
        const stats = whaleStats.global || whaleStats;
        
        // Basic Metrics
        const winrate = stats.winrate || 0;
        const pnl = stats.pnl || 0;
        const count = stats.totalTrades || 0;
        const median = stats.medianPnl || 0;
        const lowerBound = stats.winrateLowerBound || 0;

        // Scoring Logic
        let score = 0;

        // A. Winrate Confidence (Max 50)
        // We use Lower Bound to punish low sample size
        score += Math.min(50, (lowerBound * 100)); 

        // B. PnL Consistency (Max 30)
        if (median > 0) score += 30;
        else if (median === 0 && pnl > 0) score += 15;

        // C. Experience (Max 20)
        if (count > 50) score += 20;
        else if (count > 20) score += 10;
        else if (count > 5) score += 5;

        // Penalties
        if (pnl < 0) score -= 50; // Loser penalty
        if (winrate < 0.4) score -= 30;

        // Decision
        const shouldBet = score >= CONFIG.MIN_SCORE;
        
        return {
            shouldBet,
            score: Math.max(0, Math.round(score)),
            reason: shouldBet 
                ? `Sniper: Score ${score.toFixed(0)} (WR: ${(winrate*100).toFixed(0)}%, PnL: $${pnl.toFixed(0)})`
                : `Low Score: ${score.toFixed(0)}`
        };
    }
};
