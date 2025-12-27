const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../whale_bot.db');
const db = new sqlite3.Database(dbPath);

db.get("SELECT condition_id FROM signals ORDER BY id DESC LIMIT 1", [], (err, row) => {
    if (err) {
        console.error(err);
    } else if (row) {
        console.log(`✅ Found Condition ID: ${row.condition_id}`);
    } else {
        console.log('❌ No signals found in DB.');
    }
    db.close();
});
