const portfolio = require('./portfolio_manager');
const insider = require('./strategies/insider');
const logger = require('./utils/logger');

// Exact data from the missed Venezuela trade (Signal 69195)
const trade = {
    price: 0.0678,
    size_usd: 5000,
    whale_address: '0x31a56e9e690c621ed21de08cb559e9524cdb8ed9'
};

const whaleStats = {
    global: {
        pnl: -1987.94,
        winrate: 0,
        totalTrades: 4,
        streak: -4
    }
};

async function test() {
    console.log("=== SIMULATING GHOST INSIDER DETECTION (VENEZUELA CLIP) ===");

    // 1. Check Global Filter (portfolio_manager)
    const signalScore = portfolio.evaluateSignal(trade, whaleStats, 'other');
    console.log(`\n1. Global Signal Score: ${signalScore}/100`);
    if (signalScore > 0) {
        console.log("✅ Global Filter PASSED (Bypassed Loser Penalty)");
    } else {
        console.log("❌ Global Filter FAILED");
    }

    // 2. Check Insider Strategy
    const evalResult = await insider.evaluate(trade, whaleStats);
    console.log(`\n2. Insider Strategy Result:`);
    console.log(`   - Should Bet: ${evalResult.shouldBet}`);
    console.log(`   - Score: ${evalResult.score}`);
    console.log(`   - Reason: ${evalResult.reason}`);

    if (evalResult.shouldBet && evalResult.score >= 60) {
        console.log("\n🚀 SUCCESS: The bot would have caught this trade now!");
    } else {
        console.log("\n⚠️ Still not catching it. Check logic.");
    }
}

test();
