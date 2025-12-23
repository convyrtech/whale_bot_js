const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../whale_bot.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    console.log("Checking for recent real bets...");
    db.all(`
        SELECT id, chat_id, strategy, side, bet_amount, entry_price, result_pnl_percent, status, created_at, outcome 
        FROM user_signal_logs 
        WHERE strategy != 'shadow_mining' 
        ORDER BY created_at DESC 
        LIMIT 10
    `, (err, rows) => {
        if (err) {
            console.error(err);
            return;
        }
        if (rows.length === 0) {
            console.log("No real bets found.");
        } else {
            console.table(rows);
        }
    });

    console.log("\nChecking portfolio balances...");
    db.all(`SELECT * FROM portfolios`, (err, rows) => {
        if (err) console.error(err);
        else console.table(rows);
    });
});

db.close();
