const sqlite3 = require('sqlite3');
const db = new sqlite3.Database('./whale_bot.db');

db.all(
    `SELECT entry_price, exit_price, result_pnl_percent, outcome, resolved_outcome, bet_amount 
     FROM user_signal_logs 
     WHERE strategy = 'strategy_sniper' AND status = 'CLOSED' 
     LIMIT 15`,
    (err, rows) => {
        if (err) {
            console.error(err);
        } else {
            console.log('\n📊 SNIPER TRADES VERIFICATION:\n');
            console.log('Entry\tExit\tCalc ROI\tDB ROI\t\tMatch?');
            console.log('─'.repeat(60));

            rows.forEach(r => {
                const calcRoi = ((r.exit_price - r.entry_price) / r.entry_price) * 100;
                const dbRoi = r.result_pnl_percent;
                const match = Math.abs(calcRoi - dbRoi) < 0.01 ? '✅' : '❌';
                console.log(`${r.entry_price.toFixed(2)}\t${r.exit_price}\t${calcRoi.toFixed(1)}%\t\t${dbRoi.toFixed(1)}%\t\t${match}`);
            });

            console.log('\n📈 SUMMARY:');
            const wins = rows.filter(r => r.result_pnl_percent > 0).length;
            const total = rows.length;
            const avgRoi = rows.reduce((s, r) => s + r.result_pnl_percent, 0) / total;
            console.log(`Total: ${total} | Wins: ${wins} | WR: ${((wins / total) * 100).toFixed(0)}% | Avg ROI: ${avgRoi.toFixed(1)}%`);
        }
        db.close();
    }
);
