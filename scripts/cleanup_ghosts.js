const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../whale_bot.db');
const db = new sqlite3.Database(dbPath);

async function cleanup() {
    console.log("🧹 Starting Ghost Position Cleanup...");

    // 1. Count Ghosts
    const ghosts = await new Promise((resolve, reject) => {
        db.all("SELECT id FROM user_signal_logs WHERE status = 'OPEN' AND strategy != 'shadow_mining' AND bet_amount = 0", [], (err, rows) => {
            if (err) reject(err);
            resolve(rows || []);
        });
    });

    if (ghosts.length === 0) {
        console.log("✅ No ghost positions found. Database is clean.");
        return;
    }

    console.log(`👻 Found ${ghosts.length} ghost positions (Bet = $0). Cleaning up...`);

    // 2. Update them to CLOSED_VOID
    const changes = await new Promise((resolve, reject) => {
        db.run(
            `UPDATE user_signal_logs 
             SET status = 'CLOSED_VOID', 
                 resolved_outcome = 'GHOST_CLEANUP'
             WHERE status = 'OPEN' AND strategy != 'shadow_mining' AND bet_amount = 0`,
            [],
            function(err) {
                if (err) reject(err);
                resolve(this.changes);
            }
        );
    });

    console.log(`✨ Successfully cleaned ${changes} positions.`);
    console.log(`📉 Dashboard should now show correct Open Position count.`);
}

cleanup().then(() => process.exit(0)).catch(e => { console.error(e); process.exit(1); });