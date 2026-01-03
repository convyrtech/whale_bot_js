const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');

const dbPath = path.resolve(__dirname, 'database.sqlite');
const db = new sqlite3.Database(dbPath);

// Initialize Tables
db.serialize(() => {
    // Users Table
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        telegram_id INTEGER UNIQUE,
        username TEXT,
        first_name TEXT,
        balance REAL DEFAULT 0,
        is_banned INTEGER DEFAULT 0,
        referrer_id INTEGER,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Try to add referrer_id column if it doesn't exist (Migration)
    db.run("ALTER TABLE users ADD COLUMN referrer_id INTEGER", (err) => {
        // This will fail if column exists, which is fine
    });

    // Keys Table (Active VPN sessions)
    db.run(`CREATE TABLE IF NOT EXISTS keys (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        uuid TEXT UNIQUE,
        email TEXT,
        inbound_id INTEGER,
        expiry_date DATETIME,
        is_trial INTEGER DEFAULT 0,
        is_active INTEGER DEFAULT 1,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )`);

    // Transactions Table (History)
    db.run(`CREATE TABLE IF NOT EXISTS transactions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        amount REAL,
        type TEXT, -- 'DEPOSIT', 'PURCHASE'
        description TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // Processed Invoices (Prevent Double Spending)
    db.run(`CREATE TABLE IF NOT EXISTS processed_invoices (
        invoice_id INTEGER PRIMARY KEY,
        user_id INTEGER,
        amount REAL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);
});

module.exports = {
    // ... existing methods ...

    isInvoiceProcessed: (invoiceId) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT invoice_id FROM processed_invoices WHERE invoice_id = ?", [invoiceId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });
    },

    markInvoiceProcessed: (invoiceId, userId, amount) => {
        return new Promise((resolve, reject) => {
            db.run(
                "INSERT INTO processed_invoices (invoice_id, user_id, amount) VALUES (?, ?, ?)",
                [invoiceId, userId, amount],
                function(err) {
                    if (err) reject(err);
                    resolve(this.lastID);
                }
            );
        });
    },

    // --- STATS ---
    getStats: () => {
        return new Promise((resolve, reject) => {
            const stats = {};
            db.serialize(() => {
                db.get("SELECT COUNT(*) as count FROM users", (err, row) => {
                    if (err) return reject(err);
                    stats.users = row.count;
                    
                    db.get("SELECT COUNT(*) as count FROM keys WHERE is_active = 1", (err, row) => {
                        if (err) return reject(err);
                        stats.active_keys = row.count;

                        db.get("SELECT SUM(amount) as total FROM processed_invoices", (err, row) => {
                            if (err) return reject(err);
                            stats.revenue = row.total || 0;
                            resolve(stats);
                        });
                    });
                });
            });
        });
    },

    getAllUsers: () => {
        return new Promise((resolve, reject) => {
            db.all("SELECT telegram_id FROM users", [], (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            });
        });
    },

    getUser: (telegramId) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT * FROM users WHERE telegram_id = ?", [telegramId], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
    },

    getUserByDbId: (id) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT * FROM users WHERE id = ?", [id], (err, row) => {
                if (err) reject(err);
                resolve(row);
            });
        });
    },

    createUser: (telegramId, username, firstName) => {
        return new Promise((resolve, reject) => {
            db.run(
                "INSERT OR IGNORE INTO users (telegram_id, username, first_name) VALUES (?, ?, ?)",
                [telegramId, username, firstName],
                function(err) {
                    if (err) reject(err);
                    resolve(this.lastID);
                }
            );
        });
    },

    createKey: (userId, uuid, email, inboundId, expiryDate, isTrial = 0) => {
        return new Promise((resolve, reject) => {
            db.run(
                "INSERT INTO keys (user_id, uuid, email, inbound_id, expiry_date, is_trial) VALUES (?, ?, ?, ?, ?, ?)",
                [userId, uuid, email, inboundId, expiryDate, isTrial],
                function(err) {
                    if (err) reject(err);
                    resolve(this.lastID);
                }
            );
        });
    },

    getActiveKeys: (userId) => {
        return new Promise((resolve, reject) => {
            db.all(
                "SELECT * FROM keys WHERE user_id = ? AND is_active = 1 AND expiry_date > datetime('now')", 
                [userId], 
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });
    },

    getExpiredKeys: () => {
        return new Promise((resolve, reject) => {
            db.all(
                "SELECT * FROM keys WHERE is_active = 1 AND expiry_date <= datetime('now')", 
                [], 
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows);
                }
            );
        });
    },

    markKeyInactive: (id) => {
        return new Promise((resolve, reject) => {
            db.run(
                "UPDATE keys SET is_active = 0 WHERE id = ?", 
                [id], 
                function(err) {
                    if (err) reject(err);
                    resolve(this.changes);
                }
            );
        });
    },

    hasTrialUsed: (userId) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT id FROM keys WHERE user_id = ? AND is_trial = 1", [userId], (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            });
        });
    },

    // --- REFERRAL SYSTEM ---
    setReferrer: (userId, referrerId) => {
        return new Promise((resolve, reject) => {
            // Only set if not already set and not self-referral
            db.run(
                "UPDATE users SET referrer_id = ? WHERE id = ? AND referrer_id IS NULL AND id != ?",
                [referrerId, userId, referrerId],
                function(err) {
                    if (err) reject(err);
                    resolve(this.changes);
                }
            );
        });
    },

    getReferralCount: (userId) => {
        return new Promise((resolve, reject) => {
            db.get("SELECT COUNT(*) as count FROM users WHERE referrer_id = ?", [userId], (err, row) => {
                if (err) reject(err);
                resolve(row ? row.count : 0);
            });
        });
    },

    addBonusDays: (userId, days) => {
        return new Promise((resolve, reject) => {
            // Find the latest active key and extend it, OR create a "credit" (simplified: extend latest active key)
            // For now, let's just find ANY active key and extend it. 
            // If no active key, we can't easily "store" days without a balance system or a "pending days" column.
            // Strategy: If active key exists -> extend. If not -> do nothing (or maybe store in a 'bonus_days' column? User asked for days).
            // Let's try to extend the latest active key.
            
            db.get("SELECT id, expiry_date FROM keys WHERE user_id = ? AND is_active = 1 ORDER BY expiry_date DESC LIMIT 1", [userId], (err, key) => {
                if (err) return reject(err);
                
                if (key) {
                    const newExpiry = new Date(new Date(key.expiry_date).getTime() + days * 24 * 60 * 60 * 1000);
                    db.run("UPDATE keys SET expiry_date = ? WHERE id = ?", [newExpiry.toISOString(), key.id], function(err) {
                        if (err) reject(err);
                        resolve({ success: true, extended: true });
                    });
                } else {
                    // No active key. We should probably store this as a "pending bonus" but for simplicity in this iteration,
                    // we will just return false so the UI knows to tell the user "Activate a sub to get your bonus".
                    // OR: We can just ignore it.
                    resolve({ success: false, msg: "No active key to extend" });
                }
            });
        });
    }
};