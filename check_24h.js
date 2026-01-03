const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('whale_bot.db');

console.log("=== 24-HOUR PERFORMANCE AUDIT (POST-UPGRADE) ===");

db.all(`
    SELECT 
        strategy,
        COUNT(*) as total,
        SUM(CASE WHEN result_pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
        AVG(result_pnl_percent) as avg_roi,
        SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as open_positions
    FROM user_signal_logs
    WHERE created_at >= datetime('now', '-24 hours')
    GROUP BY strategy
`, [], (err, rows) => {
    if (err) { console.error(err); return; }
    console.table(rows);

    db.all(`
        SELECT 
            strategy,
            COUNT(*) as count
        FROM user_signal_logs
        WHERE created_at >= datetime('now', '-24 hours')
        AND entry_price BETWEEN 0.40 AND 0.70
        GROUP BY strategy
    `, [], (err, rows) => {
        if (err) { console.error(err); return; }
        console.log("\n☢️ TOXIC ZONE TRADES BY STRATEGY:");
        console.table(rows);

        db.close();
    });
});
