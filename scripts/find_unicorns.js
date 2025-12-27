const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../whale_bot.db');
const db = new sqlite3.Database(dbPath);

function runQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function findUnicorns() {
    console.log("🦄 --- HUNTING FOR UNICORN WHALES --- 🦄\n");

    try {
        // Criteria:
        // 1. At least 5 trades (not just lucky once)
        // 2. Winrate > 60%
        // 3. Positive PnL
        
        const unicorns = await runQuery(`
            SELECT 
                whale_address,
                COUNT(*) as total_trades,
                SUM(CASE WHEN result_pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
                AVG(result_pnl_percent) as avg_pnl,
                SUM(size_usd) as total_volume
            FROM signals 
            WHERE status = 'CLOSED'
            GROUP BY whale_address
            HAVING total_trades >= 5 
               AND (wins * 1.0 / total_trades) >= 0.60
               AND avg_pnl > 0
            ORDER BY avg_pnl DESC
            LIMIT 20
        `);

        if (unicorns.length === 0) {
            console.log("No unicorns found yet. Need more data.");
        } else {
            console.table(unicorns.map(u => ({
                Address: u.whale_address,
                Trades: u.total_trades,
                Winrate: ((u.wins / u.total_trades) * 100).toFixed(1) + '%',
                AvgPnL: u.avg_pnl.toFixed(0) + '%',
                Volume: '$' + u.total_volume.toFixed(0)
            })));
            
            console.log("\n💡 RECOMMENDATION: Add these addresses to a 'VIP Whitelist' to follow them with higher stakes.");
        }

    } catch (e) {
        console.error("Error finding unicorns:", e);
    }
}

findUnicorns();
