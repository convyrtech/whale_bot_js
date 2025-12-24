const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../whale_bot.db');
const db = new sqlite3.Database(dbPath);

const TEST_USER_ID = 12345;

db.serialize(() => {
    console.log(`Cleaning up test user ${TEST_USER_ID}...`);

    db.run(`DELETE FROM users WHERE chat_id = ?`, [TEST_USER_ID], function(err) {
        if (err) console.error("Error deleting from users:", err);
        else console.log(`Deleted ${this.changes} rows from users`);
    });

    db.run(`DELETE FROM strategy_portfolios WHERE user_id = ?`, [TEST_USER_ID], function(err) {
        if (err) console.error("Error deleting from strategy_portfolios:", err);
        else console.log(`Deleted ${this.changes} rows from strategy_portfolios`);
    });

    db.run(`DELETE FROM user_signal_logs WHERE chat_id = ?`, [TEST_USER_ID], function(err) {
        if (err) console.error("Error deleting from user_signal_logs:", err);
        else console.log(`Deleted ${this.changes} rows from user_signal_logs`);
    });

    db.run(`DELETE FROM user_actions WHERE chat_id = ?`, [TEST_USER_ID], function(err) {
        if (err) console.error("Error deleting from user_actions:", err);
        else console.log(`Deleted ${this.changes} rows from user_actions`);
    });
});

db.close(() => {
    console.log("Cleanup complete.");
});
