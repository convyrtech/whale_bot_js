const web3 = require('../utils/web3_utils');

/**
 * Strategy B: Insider Hunter
 * Logic: Detects high-conviction bets on low-probability events.
 * Enhancements: Checks wallet age and balance ratio if keys are provided.
 */

const CONFIG = {
    MIN_SCORE: 60,
    HIGH_VOLUME_USD: 1000,
    LOW_PRICE_THRESHOLD: 0.35, // <35% probability (~3x return)
    EXTREME_PRICE_THRESHOLD: 0.10, // <10% probability (~10x return)
};

module.exports = {
    id: 'strategy_insider',
    name: 'Insider Hunter',
    description: 'Detects anomalous high-volume bets on low-probability outcomes.',

    evaluate: async (trade, whaleStats) => {
        let score = 0;
        let reasons = [];

        // 1. PRICE / VOLUME ANALYSIS (The Core)
        const price = Number(trade.price || 0);
        const sizeUsd = Number(trade.size_usd || 0);

        if (price <= 0 || sizeUsd <= 0) return { shouldBet: false, score: 0 };

        // Base Logic: Big Bet on Longshot
        if (sizeUsd >= CONFIG.HIGH_VOLUME_USD) {
            if (price <= CONFIG.EXTREME_PRICE_THRESHOLD) {
                score += 70; // $1k+ on <10% odds = HUGE signal (Auto-trigger > 60)
                reasons.push(`High Conviction Longshot ($${sizeUsd} @ ${price})`);
            } else if (price <= CONFIG.LOW_PRICE_THRESHOLD) {
                score += 40; // $1k+ on <35% odds (Needs +20 from Web3 to trigger)
                reasons.push(`Value Bet ($${sizeUsd} @ ${price})`);
            }
        }

        // 2. FUNDAMENTAL ANALYSIS (Quant Style)
        // A. Wallet Age (From Goldsky/Polymarket Data)
        // If we have stats, we check the account age.
        // Data comes from 'whale_logic.js' GraphQL query.
        const stats = whaleStats.global || whaleStats;
        if (stats && stats.firstTradeTimestamp) {
            const ageDays = (Date.now() - stats.firstTradeTimestamp) / (1000 * 60 * 60 * 24);

            if (ageDays < 1.5) {
                // Super Fresh (Created < 36h ago)
                score += 50;
                reasons.push(`Fresh Account (${ageDays.toFixed(1)}d)`);
            } else if (ageDays < 7) {
                // Newish
                score += 20;
                reasons.push(`New Account (${ageDays.toFixed(1)}d)`);
            } else if (ageDays > 180) {
                // Veteran
                score += 10;
            }
        }

        // B. WEB3 BALANCES (Requires RPC Key)
        // Only run if we have a strong base signal to avoid API spam
        if (score > 40) {
            try {
                // Legacy Web3 Check (Fallback if Goldsky fails or for Balance)
                const ageMs = await web3.getWalletAgeMs(trade.maker_address);

                // B. Balance Check (Smart Money vs Degen)
                const balanceUsd = await web3.getUsdcBalance(trade.maker_address);
                if (balanceUsd > 0) {
                    const ratio = sizeUsd / balanceUsd;
                    if (ratio > 0.8) {
                        score -= 20; // All-in = Gambler
                        reasons.push(`All-in Degen (Bet >80% Balance)`);
                    } else if (ratio < 0.1) {
                        score += 20; // Smart Money (<10% of portfolio)
                        reasons.push(`Smart Money Size (<10% Balance)`);
                    }
                }
            } catch (e) {
                // Ignore Web3 errors, proceed with Price/Vol score
            }
        }

        // Decision
        const shouldBet = score >= CONFIG.MIN_SCORE;

        return {
            shouldBet,
            score: Math.max(0, Math.round(score)),
            reason: shouldBet
                ? `Insider: ${reasons.join(', ')}`
                : `Score ${score} (${reasons.join(', ') || 'No Signal'})`
        };
    }
};
