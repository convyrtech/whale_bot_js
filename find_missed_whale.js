const sqlite3 = require('sqlite3').verbose();
const db = new sqlite3.Database('whale_bot.db');

const whaleAddr = '0x31a56e9e'.toLowerCase();

console.log(`🔍 Searching for whale: ${whaleAddr}...`);

db.all(`
    SELECT * FROM signals 
    WHERE LOWER(whale_address) LIKE ?
`, [`${whaleAddr}%`], (err, rows) => {
    if (err) { console.error(err); return; }
    if (rows.length === 0) {
        console.log("❌ Signal NOT FOUND in DB. We likely never saw this trade on the tape.");
    } else {
        console.table(rows);

        // Check if there was an attempt to log a bet for this signal
        db.all(`
            SELECT * FROM user_signal_logs WHERE signal_id = ?
        `, [rows[0].id], (err, logs) => {
            if (err) { console.error(err); return; }
            console.log("\n📊 Processing Logs for this signal:");
            console.table(logs);
            db.close();
        });
    }
});
