const math = require('../math_utils');
const logger = require('../utils/logger');

/**
 * Strategy B: Inverse Loser (Anti-Hamster)
 * Logic: Find consistent losers and bet AGAINST them.
 */

const CONFIG = {
    MAX_PNL: -500,       // Must have lost at least $500
    MAX_WINRATE: 0.35,   // Winrate must be terrible (< 35%)
    MIN_TRADES: 10       // Must have enough trades to prove they are bad
};

module.exports = {
    id: 'strategy_inverse',
    name: 'Inverse Loser',
    description: 'Fades consistent losers (Anti-Hamster).',

    evaluate: (trade, whaleStats) => {
        const stats = whaleStats.global || whaleStats;
        
        const winrate = stats.winrate || 0;
        const pnl = stats.pnl || 0;
        const count = stats.totalTrades || 0;

        // We are looking for "Consistent Losers"
        const isLoser = pnl <= CONFIG.MAX_PNL;
        const isBadTrader = winrate <= CONFIG.MAX_WINRATE;
        const hasHistory = count >= CONFIG.MIN_TRADES;

        if (isLoser && isBadTrader && hasHistory) {
            // INVERSE LOGIC
            // If Loser buys YES -> We buy NO
            // If Loser buys NO -> We buy YES
            
            let inverseOutcome = trade.outcome === 'Yes' ? 'No' : 'Yes';
            
            // Confidence is high if they are really bad
            let score = 80; 
            if (winrate < 0.2) score = 95; // Super bad trader

            return {
                shouldBet: true,
                score: score,
                reason: `Inverse: Loser found (PnL: $${pnl.toFixed(0)}, WR: ${(winrate*100).toFixed(0)}%)`,
                override: {
                    outcome: inverseOutcome
                }
            };
        }

        return { shouldBet: false, score: 0, reason: 'Not a loser' };
    }
};
