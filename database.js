const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = process.env.DB_PATH ? path.resolve(process.env.DB_PATH) : path.resolve(__dirname, 'whale_bot.db');
const db = new sqlite3.Database(dbPath);

function addColumnIfMissing(table, column, definition) {
    return new Promise((resolve, reject) => {
        db.all(`PRAGMA table_info(${table});`, [], (err, rows) => {
            if (err) return reject(err);
            const exists = (rows || []).some(r => r.name === column);
            if (exists) return resolve(false);
            db.run(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`, [], function(e) {
                if (e) return reject(e);
                resolve(true);
            });
        });
    });
}

// Initialize Database
function initDb() {
    db.serialize(() => {
        db.exec(`PRAGMA foreign_keys = ON; PRAGMA journal_mode = WAL;`);
        db.run(`CREATE TABLE IF NOT EXISTS users (
            chat_id INTEGER PRIMARY KEY,
            active INTEGER DEFAULT 1,
            min_bet INTEGER DEFAULT 1000,
            min_pnl_total INTEGER DEFAULT 0,
            min_pnl_recent INTEGER DEFAULT 0,
            filter_whale_type TEXT DEFAULT 'all', -- 'all', 'whale', 'smart_whale', 'hamster'
            filter_market_slug TEXT DEFAULT NULL,
            filter_market_category TEXT DEFAULT 'all',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS signals (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            market_slug TEXT,
            condition_id TEXT,
            outcome TEXT,
            side TEXT,
            entry_price REAL,
            size_usd REAL,
            whale_address TEXT,
            transaction_hash TEXT,
            status TEXT DEFAULT 'OPEN', -- 'OPEN', 'CLOSED', 'CLOSED_VOID'
            result_pnl_percent REAL,
            resolved_outcome TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS user_signal_logs (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            signal_id INTEGER,
            chat_id INTEGER,
            strategy TEXT,
            side TEXT,
            entry_price REAL,
            size_usd REAL,
            bet_amount REAL DEFAULT 0,
            category TEXT,
            league TEXT,
            outcome TEXT,
            status TEXT DEFAULT 'OPEN',
            result_pnl_percent REAL,
            resolved_outcome TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS user_actions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER,
            action TEXT,
            payload TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
 
        // Migrations (idempotent)
        addColumnIfMissing('users', 'filter_market_category', `TEXT DEFAULT 'all'`).catch(() => {});
        addColumnIfMissing('users', 'strategy_name', `TEXT DEFAULT 'custom'`).catch(() => {});
        addColumnIfMissing('users', 'virtual_stake_usd', `INTEGER DEFAULT 100`).catch(() => {});
        addColumnIfMissing('users', 'filter_winrate_min_percent', `INTEGER DEFAULT 0`).catch(() => {});
        addColumnIfMissing('users', 'filter_winrate_max_percent', `INTEGER DEFAULT 100`).catch(() => {});
        addColumnIfMissing('signals', 'event_slug', `TEXT`).catch(() => {});
        addColumnIfMissing('signals', 'size_usd', `REAL`).catch(() => {});
        addColumnIfMissing('signals', 'entry_price', `REAL`).catch(() => {});
        addColumnIfMissing('signals', 'whale_address', `TEXT`).catch(() => {});
        addColumnIfMissing('signals', 'token_index', `INTEGER`).catch(() => {});
        addColumnIfMissing('user_signal_logs', 'token_index', `INTEGER`).catch(() => {});
        addColumnIfMissing('user_signal_logs', 'is_notified_closed', `INTEGER DEFAULT 0`).catch(() => {});
        addColumnIfMissing('user_signal_logs', 'bet_amount', `REAL DEFAULT 0`).catch(() => {});
        addColumnIfMissing('signals', 'transaction_hash', `TEXT`).catch(() => {});
        db.run(`ALTER TABLE users ADD COLUMN filter_market_category TEXT DEFAULT 'all'`, () => {});
        db.run(`ALTER TABLE users ADD COLUMN strategy_name TEXT DEFAULT 'custom'`, () => {});
        db.run(`ALTER TABLE users ADD COLUMN virtual_stake_usd INTEGER DEFAULT 100`, () => {});
        db.run(`CREATE INDEX IF NOT EXISTS idx_signals_condition ON signals(condition_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_user_logs_signal ON user_signal_logs(signal_id)`);
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_txhash ON signals(transaction_hash)`);
        db.run(`CREATE TABLE IF NOT EXISTS callback_payloads (id TEXT PRIMARY KEY, payload TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        // Portfolio table (Challenge Mode)
        db.run(`CREATE TABLE IF NOT EXISTS portfolio (
            user_id INTEGER PRIMARY KEY,
            balance REAL DEFAULT 20.0,
            locked REAL DEFAULT 0.0,
            equity REAL DEFAULT 20.0,
            is_challenge_active INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )`);
        
        console.log("Database initialized.");
    });
}
 
const getUnnotifiedClosedSignals = () => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT id, signal_id, chat_id, status, result_pnl_percent, outcome, resolved_outcome 
             FROM user_signal_logs 
             WHERE (status = 'CLOSED' OR status = 'CLOSED_VOID') AND (is_notified_closed IS NULL OR is_notified_closed = 0)`,
            [],
            (err, rows) => {
                if (err) reject(err);
                resolve(rows || []);
            }
        );
    });
};

const markUserSignalLogNotified = (id) => {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE user_signal_logs SET is_notified_closed = 1 WHERE id = ?`,
            [id],
            function(err) {
                if (err) reject(err);
                resolve(this.changes);
            }
        );
    });
};

// Portfolio Operations
const initPortfolio = (userId) => {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO portfolio (user_id, balance, locked, equity, is_challenge_active) VALUES (?, 20.0, 0.0, 20.0, 0)
             ON CONFLICT(user_id) DO UPDATE SET balance = 20.0, locked = 0.0, equity = 20.0, is_challenge_active = 0, updated_at = CURRENT_TIMESTAMP`,
            [userId],
            function(err) {
                if (err) reject(err);
                resolve(true);
            }
        );
    });
};

const getPortfolio = (userId) => {
    return new Promise((resolve, reject) => {
        db.get(`SELECT * FROM portfolio WHERE user_id = ?`, [userId], (err, row) => {
            if (err) reject(err);
            resolve(row || null);
        });
    });
};

const updateBalance = (userId, amountDelta) => {
    return new Promise((resolve, reject) => {
        db.get(`SELECT balance, locked FROM portfolio WHERE user_id = ?`, [userId], (err, row) => {
            if (err) return reject(err);
            const balance = row ? Number(row.balance || 0) : 0;
            const locked = row ? Number(row.locked || 0) : 0;
            const newBalanceRaw = balance + Number(amountDelta || 0);
            const newBalance = Math.round(newBalanceRaw * 100) / 100;
            const equity = Math.round((newBalance + locked) * 100) / 100;
            db.run(
                `UPDATE portfolio SET balance = ?, equity = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ?`,
                [newBalance, equity, userId],
                function(e) {
                    if (e) return reject(e);
                    resolve(this.changes);
                }
            );
        });
    });
};

const updatePortfolio = (userId, changes) => {
    const { balanceDelta = 0, lockedDelta = 0, is_challenge_active } = changes || {};
    return new Promise((resolve, reject) => {
        db.get(`SELECT balance, locked FROM portfolio WHERE user_id = ?`, [userId], (err, row) => {
            if (err) return reject(err);
            const balance = row ? Number(row.balance || 0) : 0;
            const locked = row ? Number(row.locked || 0) : 0;
            const newBalance = Math.round((balance + Number(balanceDelta || 0)) * 100) / 100;
            const newLocked = Math.round((locked + Number(lockedDelta || 0)) * 100) / 100;
            const equity = Math.round((newBalance + newLocked) * 100) / 100;
            const fields = ['balance = ?', 'locked = ?', 'equity = ?', 'updated_at = CURRENT_TIMESTAMP'];
            const params = [newBalance, newLocked, equity];
            if (typeof is_challenge_active === 'number') {
                fields.push('is_challenge_active = ?');
                params.push(is_challenge_active);
            }
            params.push(userId);
            db.run(
                `UPDATE portfolio SET ${fields.join(', ')} WHERE user_id = ?`,
                params,
                function(e) {
                    if (e) return reject(e);
                    resolve(this.changes);
                }
            );
        });
    });
};
// User Operations
const getUser = (chatId) => {
    return new Promise((resolve, reject) => {
        db.get("SELECT * FROM users WHERE chat_id = ?", [chatId], (err, row) => {
            if (err) reject(err);
            resolve(row);
        });
    });
};

const createUser = (chatId) => {
    return new Promise((resolve, reject) => {
        db.run("INSERT OR IGNORE INTO users (chat_id) VALUES (?)", [chatId], function(err) {
            if (err) reject(err);
            resolve(this.lastID);
        });
    });
};

const updateUser = (chatId, params) => {
    const keys = Object.keys(params);
    const values = Object.values(params);
    const setString = keys.map(k => `${k} = ?`).join(', ');
    
    return new Promise((resolve, reject) => {
        db.run(`UPDATE users SET ${setString} WHERE chat_id = ?`, [...values, chatId], function(err) {
            if (err) reject(err);
            resolve(this.changes);
        });
    });
};

const getAllActiveUsers = () => {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM users WHERE active = 1", [], (err, rows) => {
            if (err) reject(err);
            resolve(rows);
        });
    });
};

// Signal / Forward Test Operations
const checkSignalExists = (txHash) => {
    if (!txHash) return Promise.resolve(false);
    return new Promise((resolve, reject) => {
        db.get(`SELECT 1 FROM signals WHERE transaction_hash = ?`, [txHash], (err, row) => {
            if (err) return reject(err);
            resolve(!!row);
        });
    });
};

const saveSignal = (data) => {
    return new Promise((resolve, reject) => {
        const { market_slug, event_slug, condition_id, outcome, side, entry_price, size_usd, whale_address, token_index, transaction_hash } = data;
        db.run(
            `INSERT INTO signals (market_slug, event_slug, condition_id, outcome, side, entry_price, size_usd, whale_address, token_index, transaction_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [market_slug, event_slug, condition_id, outcome, side, entry_price, size_usd, whale_address, token_index ?? null, transaction_hash ?? null],
            function(err) {
                if (err) reject(err);
                resolve(this.lastID);
            }
        );
    });
};

const logUserSignal = (chatId, signalId, data) => {
    return new Promise((resolve, reject) => {
        const { strategy, side, entry_price, size_usd, category, league, outcome, token_index, bet_amount } = data;
        db.run(
            `INSERT INTO user_signal_logs (signal_id, chat_id, strategy, side, entry_price, size_usd, bet_amount, category, league, outcome, token_index) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [signalId, chatId, strategy, side, entry_price, size_usd, bet_amount ?? 0, category, league, outcome, token_index ?? null],
            function(err) {
                if (err) reject(err);
                resolve(this.lastID);
            }
        );
    });
};

const getPendingSignals = () => {
    return new Promise((resolve, reject) => {
        db.all("SELECT * FROM signals WHERE status = 'OPEN'", [], (err, rows) => {
            if (err) reject(err);
            resolve(rows);
        });
    });
};

const updateSignalResult = (id, resultData) => {
    return new Promise((resolve, reject) => {
        const { status, result_pnl_percent, resolved_outcome } = resultData;
        db.run(
            `UPDATE signals SET status = ?, result_pnl_percent = ?, resolved_outcome = ? WHERE id = ?`,
            [status, result_pnl_percent, resolved_outcome, id],
            function(err) {
                if (err) reject(err);
                resolve(this.changes);
            }
        );
    });
};

const updateUserSignalResultsBySignalId = (signalId, resultData) => {
    return new Promise((resolve, reject) => {
        const { status, result_pnl_percent, resolved_outcome } = resultData;
        db.run(
            `UPDATE user_signal_logs SET status = ?, result_pnl_percent = ?, resolved_outcome = ? WHERE signal_id = ?`,
            [status, result_pnl_percent, resolved_outcome, signalId],
            function(err) {
                if (err) reject(err);
                resolve(this.changes);
            }
        );
    });
};

const updateSignalConditionId = (id, conditionId) => {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE signals SET condition_id = ? WHERE id = ?`,
            [conditionId, id],
            function(err) {
                if (err) reject(err);
                resolve(this.changes);
            }
        );
    });
};

const logAction = (chatId, action, payload) => {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT INTO user_actions (chat_id, action, payload) VALUES (?, ?, ?)`,
            [chatId, action, JSON.stringify(payload || {})],
            function(err) {
                if (err) reject(err);
                resolve(this.lastID);
            }
        );
    });
};
 
const getSignalStats = (days = 30) => {
    // Enhanced stats with median, buy/sell split, and pending count.
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT result_pnl_percent, side
             FROM user_signal_logs
             WHERE status = 'CLOSED' 
               AND result_pnl_percent IS NOT NULL
               AND created_at >= datetime('now', '-' || ? || ' days')`,
            [days],
            (err, rows) => {
                if (err) return reject(err);
                const total = rows.length;
                if (total === 0) {
                    return resolve({ 
                        total: 0, wins: 0, winrate: 0, 
                        avg_pnl: 0, avg_pnl_capped: 0, median_pnl: 0,
                        buy_count: 0, buy_wins: 0, buy_winrate: 0,
                        sell_count: 0, sell_wins: 0, sell_winrate: 0,
                        pending: 0
                    });
                }

                const pnls = rows.map(r => Number(r.result_pnl_percent || 0));
                const wins = pnls.filter(x => x > 0).length;
                const totalPnl = pnls.reduce((acc, x) => acc + x, 0);
                const cappedTotalPnl = pnls.reduce((acc, x) => {
                    const capped = x > 1000 ? 1000 : (x < -1000 ? -1000 : x);
                    return acc + capped;
                }, 0);
                
                // Calculate median
                const sortedPnls = [...pnls].sort((a, b) => a - b);
                const mid = Math.floor(sortedPnls.length / 2);
                const median = sortedPnls.length % 2 !== 0 
                    ? sortedPnls[mid] 
                    : (sortedPnls[mid - 1] + sortedPnls[mid]) / 2;
                
                // Buy/Sell split
                const buyRows = rows.filter(r => (r.side || 'BUY').toUpperCase() === 'BUY');
                const sellRows = rows.filter(r => (r.side || 'BUY').toUpperCase() === 'SELL');
                const buyWins = buyRows.filter(r => Number(r.result_pnl_percent || 0) > 0).length;
                const sellWins = sellRows.filter(r => Number(r.result_pnl_percent || 0) > 0).length;
                
                // Get pending count
                db.get(
                    `SELECT COUNT(*) as pending FROM user_signal_logs WHERE status = 'OPEN'`,
                    [],
                    (err2, pendingRow) => {
                        resolve({
                            total,
                            wins,
                            winrate: (wins / total) * 100,
                            avg_pnl: totalPnl / total,
                            avg_pnl_capped: cappedTotalPnl / total,
                            median_pnl: median,
                            buy_count: buyRows.length,
                            buy_wins: buyWins,
                            buy_winrate: buyRows.length > 0 ? (buyWins / buyRows.length) * 100 : 0,
                            sell_count: sellRows.length,
                            sell_wins: sellWins,
                            sell_winrate: sellRows.length > 0 ? (sellWins / sellRows.length) * 100 : 0,
                            pending: pendingRow ? pendingRow.pending : 0
                        });
                    }
                );
            }
        );
    });
};

const getStrategyStats = (days = 30) => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT strategy,
                    COUNT(*) as total,
                    SUM(CASE WHEN result_pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
                    AVG(result_pnl_percent) as avg_roi,
                    AVG(CASE 
                          WHEN result_pnl_percent > 1000 THEN 1000
                          WHEN result_pnl_percent < -1000 THEN -1000
                          ELSE result_pnl_percent
                        END) as avg_roi_capped
             FROM user_signal_logs
             WHERE status = 'CLOSED' AND created_at >= datetime('now', '-' || ? || ' days')
             GROUP BY strategy
             ORDER BY (wins * 1.0 / total) DESC`,
            [days],
            (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            }
        );
    });
};

const getOddsBucketStats = (days = 30) => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT CASE 
                       WHEN entry_price < 0.2 THEN '0-0.2'
                       WHEN entry_price < 0.4 THEN '0.2-0.4'
                       WHEN entry_price < 0.6 THEN '0.4-0.6'
                       WHEN entry_price < 0.8 THEN '0.6-0.8'
                       ELSE '0.8-1.0'
                   END AS bucket,
                   COUNT(*) AS total,
                   SUM(CASE WHEN result_pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
                   AVG(result_pnl_percent) AS avg_roi,
                   AVG(CASE 
                         WHEN result_pnl_percent > 1000 THEN 1000
                         WHEN result_pnl_percent < -1000 THEN -1000
                         ELSE result_pnl_percent
                       END) AS avg_roi_capped
             FROM user_signal_logs
             WHERE status = 'CLOSED' AND created_at >= datetime('now', '-' || ? || ' days')
             GROUP BY bucket
             ORDER BY bucket`,
            [days],
            (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            }
        );
    });
};

const getCategoryLeagueStats = (days = 30) => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT category, league,
                    COUNT(*) AS total,
                    SUM(CASE WHEN result_pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
                    AVG(result_pnl_percent) AS avg_roi,
                    AVG(CASE 
                          WHEN result_pnl_percent > 1000 THEN 1000
                          WHEN result_pnl_percent < -1000 THEN -1000
                          ELSE result_pnl_percent
                        END) AS avg_roi_capped
             FROM user_signal_logs
             WHERE status = 'CLOSED' AND created_at >= datetime('now', '-' || ? || ' days')
             GROUP BY category, league
             ORDER BY wins * 1.0 / total DESC`,
            [days],
            (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            }
        );
    });
};

const getWhaleStats = (days = 30) => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT s.whale_address AS whale,
                    COUNT(*) AS total,
                    SUM(CASE WHEN l.result_pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
                    AVG(l.result_pnl_percent) AS avg_roi,
                    AVG(CASE 
                          WHEN l.result_pnl_percent > 1000 THEN 1000
                          WHEN l.result_pnl_percent < -1000 THEN -1000
                          ELSE l.result_pnl_percent
                        END) AS avg_roi_capped
             FROM user_signal_logs l
             JOIN signals s ON l.signal_id = s.id
             WHERE l.status = 'CLOSED' AND l.created_at >= datetime('now', '-' || ? || ' days')
             GROUP BY s.whale_address
             ORDER BY (wins * 1.0 / total) DESC`,
            [days],
            (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            }
        );
    });
};

const getWhaleCategoryStats = (days = 30) => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT s.whale_address AS whale, l.category,
                    COUNT(*) AS total,
                    SUM(CASE WHEN l.result_pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
                    AVG(l.result_pnl_percent) AS avg_roi,
                    AVG(CASE 
                          WHEN l.result_pnl_percent > 1000 THEN 1000
                          WHEN l.result_pnl_percent < -1000 THEN -1000
                          ELSE l.result_pnl_percent
                        END) AS avg_roi_capped
             FROM user_signal_logs l
             JOIN signals s ON l.signal_id = s.id
             WHERE l.status = 'CLOSED' AND l.created_at >= datetime('now', '-' || ? || ' days')
             GROUP BY s.whale_address, l.category
             ORDER BY (wins * 1.0 / total) DESC`,
            [days],
            (err, rows) => {
                if (err) reject(err);
                resolve(rows);
            }
        );
    });
};

const getUserLogsBySignalId = (signalId) => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT * FROM user_signal_logs WHERE signal_id = ?`,
            [signalId],
            (err, rows) => {
                if (err) reject(err);
                resolve(rows || []);
            }
        );
    });
};

const updateUserSignalLogById = (id, resultData) => {
    return new Promise((resolve, reject) => {
        const { status, result_pnl_percent, resolved_outcome } = resultData;
        db.run(
            `UPDATE user_signal_logs SET status = ?, result_pnl_percent = ?, resolved_outcome = ? WHERE id = ?`,
            [status, result_pnl_percent, resolved_outcome, id],
            function(err) {
                if (err) reject(err);
                resolve(this.changes);
            }
        );
    });
};

const saveCallbackPayload = (payload) => {
    return new Promise((resolve, reject) => {
        const id = Math.random().toString(36).slice(2, 10);
        db.run(
            `INSERT INTO callback_payloads (id, payload) VALUES (?, ?)`,
            [id, JSON.stringify(payload || {})],
            function(err) {
                if (err) reject(err);
                resolve(id);
            }
        );
    });
};

const getCallbackPayload = (id) => {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT payload FROM callback_payloads WHERE id = ?`,
            [id],
            function(err, row) {
                if (err) reject(err);
                resolve(row ? JSON.parse(row.payload) : null);
            }
        );
    });
};

module.exports = {
    initDb,
    getUser,
    createUser,
    updateUser,
    getAllActiveUsers,
    checkSignalExists,
    saveSignal,
    logUserSignal,
    getPendingSignals,
    updateSignalResult,
    updateUserSignalResultsBySignalId,
    getUserLogsBySignalId,
    updateUserSignalLogById,
    saveCallbackPayload,
    getCallbackPayload,
    getSignalStats,
    getStrategyStats,
    getOddsBucketStats,
    getCategoryLeagueStats,
    getWhaleStats,
    getWhaleCategoryStats,
    logAction,
    updateSignalConditionId,
    getUnnotifiedClosedSignals,
    markUserSignalLogNotified,
    initPortfolio,
    getPortfolio,
    updateBalance,
    updatePortfolio,
    /**
     * Aggregate whale stats directly from signals table (closed signals).
     * Useful for full-profile reporting independent of delivery filters.
     */
    getWhaleStatsFromSignals: (days = 30) => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT whale_address AS whale,
                        COUNT(*) AS total,
                        SUM(CASE WHEN result_pnl_percent > 0 THEN 1 ELSE 0 END) AS wins,
                        AVG(result_pnl_percent) AS avg_roi,
                        AVG(CASE 
                              WHEN result_pnl_percent > 1000 THEN 1000
                              WHEN result_pnl_percent < -1000 THEN -1000
                              ELSE result_pnl_percent
                            END) AS avg_roi_capped
                 FROM signals
                 WHERE status = 'CLOSED' AND created_at >= datetime('now', '-' || ? || ' days')
                 GROUP BY whale_address
                 ORDER BY (wins * 1.0 / total) DESC`,
                [days],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows || []);
                }
            );
        });
    },
    /**
     * Get all challenge trades for a specific user
     */
    getChallengeTradesForUser: (chatId) => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT status, result_pnl_percent, bet_amount, created_at, outcome, resolved_outcome
                 FROM user_signal_logs 
                 WHERE chat_id = ? AND strategy = 'challenge_20'
                 ORDER BY created_at DESC`,
                [chatId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                }
            );
        });
    }
};
