const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../whale_bot.db');
const db = new sqlite3.Database(dbPath);

async function analyze() {
    console.log("🔍 Analyzing Database...");

    // 1. Check Open Positions Count (Real vs Shadow)
    const realOpen = await new Promise((resolve, reject) => {
        db.all("SELECT COUNT(*) as count FROM user_signal_logs WHERE status = 'OPEN' AND strategy != 'shadow_mining'", [], (err, rows) => {
            if (err) reject(err);
            resolve(rows ? rows[0].count : 0);
        });
    });

    const shadowOpen = await new Promise((resolve, reject) => {
        db.all("SELECT COUNT(*) as count FROM user_signal_logs WHERE status = 'OPEN' AND strategy = 'shadow_mining'", [], (err, rows) => {
            if (err) reject(err);
            resolve(rows ? rows[0].count : 0);
        });
    });

    console.log(`\n📊 Open Positions Breakdown:`);
    console.log(`   - Real Money: ${realOpen}`);
    console.log(`   - Shadow Mining: ${shadowOpen}`);
    console.log(`   - Total: ${realOpen + shadowOpen}`);

    // 2. Check Real Positions Details
    if (realOpen > 0) {
        const positions = await new Promise((resolve, reject) => {
            db.all("SELECT * FROM user_signal_logs WHERE status = 'OPEN' AND strategy != 'shadow_mining'", [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });

        const zeroBets = positions.filter(p => p.bet_amount === 0);
        const realBets = positions.filter(p => p.bet_amount > 0);

        console.log(`\n💰 Real Positions Analysis:`);
        console.log(`   - Zero Value Bets (Ghosts): ${zeroBets.length}`);
        console.log(`   - Actual Value Bets: ${realBets.length}`);

        if (realBets.length > 0) {
            console.log(`\n   🚨 ACTUAL RISK POSITIONS (${realBets.length}):`);
            realBets.forEach(p => {
                console.log(`      [ID:${p.id}] ${p.strategy} | Bet: $${p.bet_amount} | Entry: ${p.entry_price} | ${p.created_at}`);
            });
        }

        // Calculate Total Locked
        const totalLocked = positions.reduce((sum, p) => sum + (p.bet_amount || 0), 0);
        console.log(`\n🔒 Total Capital Locked in DB: $${totalLocked.toFixed(2)}`);
    }

    // 3. Check Portfolio Table
    const portfolios = await new Promise((resolve, reject) => {
        db.all("SELECT * FROM strategy_portfolios", [], (err, rows) => {
            if (err) reject(err);
            resolve(rows || []);
        });
    });

    console.log(`\n💼 Portfolio Balances (DB):`);
    portfolios.forEach(p => {
        console.log(`   [${p.strategy_id}] Bal: $${p.balance.toFixed(2)} | Locked: $${p.locked.toFixed(2)}`);
    });

}

analyze().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });