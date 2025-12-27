const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../whale_bot.db');
const db = new sqlite3.Database(dbPath);

db.serialize(() => {
    console.log("--- RECENT TRADES ANALYSIS ---");
    
    // 1. Get Total Stats per Strategy (assuming we can infer strategy or just look at all signals)
    // The schema doesn't seem to have 'strategy_id' in 'signals' table based on my previous read.
    // Let's check the columns of 'signals' table first to be sure.
    
    db.all("PRAGMA table_info(signals)", (err, rows) => {
        if (err) {
            console.error(err);
            return;
        }
        console.log("Signals Table Columns:", rows.map(r => r.name).join(', '));
        
        // If there is no strategy column, we might have to infer it or just look at all trades.
        // The user report splits by strategy, so there MUST be a way to link signals to strategies.
        // Maybe 'portfolios' table?
    });

    // 2. Let's look at the 'portfolios' table if it exists
    db.all("SELECT name FROM sqlite_master WHERE type='table'", (err, tables) => {
        console.log("Tables:", tables.map(t => t.name).join(', '));
    });

    // 3. Dump last 10 closed trades with negative PnL
    db.all(`
        SELECT id, market_slug, outcome, entry_price, result_pnl_percent, created_at 
        FROM signals 
        WHERE status = 'CLOSED' AND result_pnl_percent < 0 
        ORDER BY created_at DESC 
        LIMIT 10
    `, (err, rows) => {
        if (err) console.error(err);
        else {
            console.log("\n--- LAST 10 LOSING TRADES ---");
            console.table(rows);
        }
    });

    // 4. Dump last 10 open trades
    db.all(`
        SELECT id, market_slug, outcome, entry_price, created_at 
        FROM signals 
        WHERE status = 'OPEN' 
        ORDER BY created_at DESC 
        LIMIT 10
    `, (err, rows) => {
        if (err) console.error(err);
        else {
            console.log("\n--- LAST 10 OPEN TRADES ---");
            console.table(rows);
        }
    });
});
