const logger = require('../utils/logger');

/**
 * Trend Surfer Strategy
 * Logic: Follows whales betting on outcomes with strong momentum (price increasing).
 * 
 * Rules:
 * 1. Whale must have decent winrate (> 50%).
 * 2. Outcome price must be in a "trend" zone (e.g., 0.40 - 0.70).
 * 3. High volume on the outcome recently (proxy for momentum).
 */

module.exports = {
    id: 'strategy_trend',
    name: 'Trend Surfer',
    description: 'Follows momentum and high-volume trends.',
    
    /**
     * Evaluates if this strategy wants to take the trade.
     * @param {Object} trade - The trade data
     * @param {Object} whaleStats - The whale's historical stats
     * @returns {Object} { shouldBet: boolean, score: number, reason: string }
     */
    evaluate: (trade, whaleStats) => {
        const price = Number(trade.price || 0);
        const size = Number(trade.size || 0);
        const tradeValue = price * size;

        // 1. Momentum Price Zone (0.30 - 0.75)
        // Too low = longshot, Too high = trend might be over
        if (price < 0.30 || price > 0.75) {
            return { shouldBet: false, score: 0, reason: 'Price outside momentum zone' };
        }

        // 2. Whale Competence Check
        // We don't need them to be snipers, just not idiots.
        if (whaleStats.winrate < 45) {
            return { shouldBet: false, score: 0, reason: 'Whale winrate too low' };
        }

        // 3. Volume/Conviction Check
        // Trend surfing requires conviction.
        if (tradeValue < 500) {
            return { shouldBet: false, score: 0, reason: 'Trade size too small for trend' };
        }

        // 4. "Hot" Market Check (Proxy)
        // If the whale has made multiple trades recently, it might be a hot market.
        // (Simplified: just check if whale is active)
        if (whaleStats.totalTrades < 10) {
            return { shouldBet: false, score: 0, reason: 'Whale not active enough' };
        }

        // Score Calculation
        let score = 50;
        score += (whaleStats.winrate - 50) * 2; // +2 pts for every 1% above 50%
        
        if (price >= 0.4 && price <= 0.6) score += 10; // Sweet spot
        if (tradeValue > 2000) score += 10; // High conviction

        return {
            shouldBet: score >= 65,
            score: Math.min(100, score),
            reason: `Momentum Score: ${score}`
        };
    }
};
