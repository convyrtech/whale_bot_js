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

        db.run(`CREATE TABLE IF NOT EXISTS portfolios (
            chat_id INTEGER PRIMARY KEY,
            balance REAL DEFAULT 20.0,
            locked_funds REAL DEFAULT 0.0,
            is_challenge_active INTEGER DEFAULT 1,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
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
        addColumnIfMissing('user_signal_logs', 'notified', `INTEGER DEFAULT 0`).catch(() => {});
        addColumnIfMissing('user_signal_logs', 'exit_price', `REAL`).catch(() => {});
        addColumnIfMissing('user_signal_logs', 'analysis_meta', `TEXT`).catch(() => {});
        addColumnIfMissing('user_signal_logs', 'bet_amount', `REAL DEFAULT 0`).catch(() => {});
        addColumnIfMissing('signals', 'transaction_hash', `TEXT`).catch(() => {});
        db.run(`ALTER TABLE users ADD COLUMN filter_market_category TEXT DEFAULT 'all'`, () => {});
        db.run(`ALTER TABLE users ADD COLUMN strategy_name TEXT DEFAULT 'custom'`, () => {});
        db.run(`ALTER TABLE users ADD COLUMN virtual_stake_usd INTEGER DEFAULT 100`, () => {});
        db.run(`CREATE INDEX IF NOT EXISTS idx_signals_condition ON signals(condition_id)`);
        db.run(`CREATE INDEX IF NOT EXISTS idx_user_logs_signal ON user_signal_logs(signal_id)`);
        db.run(`CREATE UNIQUE INDEX IF NOT EXISTS idx_signals_txhash ON signals(transaction_hash)`);
        db.run(`CREATE TABLE IF NOT EXISTS callback_payloads (id TEXT PRIMARY KEY, payload TEXT, created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
        // Portfolio table (Challenge Mode) - Multi-Strategy
        db.run(`CREATE TABLE IF NOT EXISTS strategy_portfolios (
            user_id INTEGER,
            strategy_id TEXT,
            balance REAL DEFAULT 20.0,
            locked REAL DEFAULT 0.0,
            equity REAL DEFAULT 20.0,
            is_challenge_active INTEGER DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (user_id, strategy_id)
        )`);
        
        // Positions Table - Multi-Strategy
        db.run(`CREATE TABLE IF NOT EXISTS positions (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            chat_id INTEGER,
            strategy_id TEXT DEFAULT 'default',
            signal_id INTEGER,
            market_slug TEXT,
            condition_id TEXT,
            outcome TEXT,
            entry_price REAL,
            bet_amount REAL,
            status TEXT DEFAULT 'OPEN',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            notified INTEGER DEFAULT 0,
            exit_price REAL,
            token_index INTEGER
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

// Portfolio Operations (Legacy removed - see bottom of file)
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

// --- POSITION MANAGEMENT (SELL LOGIC) ---

const anyUserHasPosition = (conditionId) => {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT 1 FROM user_signal_logs 
             JOIN signals ON user_signal_logs.signal_id = signals.id
             WHERE signals.condition_id = ? AND user_signal_logs.status = 'OPEN' LIMIT 1`,
            [conditionId],
            (err, row) => {
                if (err) reject(err);
                resolve(!!row);
            }
        );
    });
};

const getOpenPositions = (chatId, conditionId) => {
    return new Promise((resolve, reject) => {
        db.all(
            `SELECT user_signal_logs.id, user_signal_logs.strategy, signals.whale_address, user_signal_logs.entry_price, user_signal_logs.size_usd, user_signal_logs.outcome 
             FROM user_signal_logs 
             JOIN signals ON user_signal_logs.signal_id = signals.id
             WHERE user_signal_logs.chat_id = ? AND signals.condition_id = ? AND user_signal_logs.status = 'OPEN'`,
            [chatId, conditionId],
            (err, rows) => {
                if (err) reject(err);
                resolve(rows || []);
            }
        );
    });
};

const closePosition = (id, exitPrice) => {
    return new Promise((resolve, reject) => {
        // Calculate PnL in SQL directly to ensure atomicity
        // PnL% = ((Exit - Entry) / Entry) * 100
        db.run(
            `UPDATE user_signal_logs 
             SET status = 'CLOSED', 
                 exit_price = ?, 
                 closed_at = CURRENT_TIMESTAMP,
                 result_pnl_percent = ((? - entry_price) / entry_price) * 100
             WHERE id = ?`,
            [exitPrice, exitPrice, id],
            function(err) {
                if (err) reject(err);
                resolve(this.changes > 0);
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

// --- Portfolio Functions ---

function initPortfolio(chatId, strategyId) {
    return new Promise((resolve, reject) => {
        db.run(
            `INSERT OR IGNORE INTO strategy_portfolios (user_id, strategy_id, balance, locked, is_challenge_active) VALUES (?, ?, 20.0, 0.0, 1)`,
            [chatId, strategyId],
            function(err) {
                if (err) return reject(err);
                resolve(this.changes);
            }
        );
    });
}

function getPortfolio(chatId, strategyId) {
    return new Promise((resolve, reject) => {
        db.get(
            `SELECT * FROM strategy_portfolios WHERE user_id = ? AND strategy_id = ?`,
            [chatId, strategyId],
            (err, row) => {
                if (err) return reject(err);
                resolve(row);
            }
        );
    });
}

function updatePortfolio(chatId, strategyId, { balanceDelta = 0, lockedDelta = 0 }) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE strategy_portfolios 
             SET balance = balance + ?, 
                 locked = locked + ?, 
                 updated_at = CURRENT_TIMESTAMP 
             WHERE user_id = ? AND strategy_id = ?`,
            [balanceDelta, lockedDelta, chatId, strategyId],
            function(err) {
                if (err) return reject(err);
                resolve(this.changes);
            }
        );
    });
}

function updateBalance(chatId, strategyId, newBalance) {
    return new Promise((resolve, reject) => {
        db.run(
            `UPDATE strategy_portfolios SET balance = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = ? AND strategy_id = ?`,
            [newBalance, chatId, strategyId],
            function(err) {
                if (err) return reject(err);
                resolve(this.changes);
            }
        );
    });
}

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

const hasOpenPosition = (chatId, strategyId, conditionId) => {
    return new Promise((resolve, reject) => {
        if (!conditionId) return resolve(false);
        db.get(
            `SELECT 1 FROM user_signal_logs l 
             JOIN signals s ON l.signal_id = s.id 
             WHERE l.chat_id = ? AND l.strategy = ? AND s.condition_id = ? AND l.status = 'OPEN'`,
            [chatId, strategyId, conditionId],
            (err, row) => {
                if (err) return reject(err);
                resolve(!!row);
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
    hasOpenPosition,
    /**
     * Executes a bet atomically: Deducts balance AND logs the signal in one transaction.
     * @param {number} userId 
     * @param {string} strategyId
     * @param {number} signalId 
     * @param {number} betAmount 
     * @param {Object} logData - { strategy, side, entry_price, size_usd, category, league, outcome, token_index }
     * @returns {Promise<boolean>} True if successful
     */
    executeAtomicBet: (userId, strategyId, signalId, betAmount, logData) => {
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");

                // 1. Deduct Balance / Lock Funds
                db.run(`UPDATE strategy_portfolios 
                        SET balance = balance - ?, 
                            locked = locked + ?, 
                            updated_at = CURRENT_TIMESTAMP 
                        WHERE user_id = ? AND strategy_id = ?`, 
                    [betAmount, betAmount, userId, strategyId], 
                    function(err) {
                        if (err) {
                            console.error("Transaction Error (Update Portfolio):", err);
                            db.run("ROLLBACK");
                            return reject(err);
                        }
                    }
                );

                // 2. Log the Signal
                const stmt = db.prepare(`INSERT INTO user_signal_logs (
                    chat_id, signal_id, strategy, side, entry_price, size_usd, 
                    bet_amount, category, league, outcome, token_index, analysis_meta, status
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN')`);

                stmt.run(
                    userId, 
                    signalId, 
                    strategyId, // Use strategyId here for consistency
                    logData.side, 
                    logData.entry_price, 
                    logData.size_usd, 
                    betAmount, // Explicitly logging the bet amount
                    logData.category, 
                    logData.league, 
                    logData.outcome, 
                    logData.token_index,
                    JSON.stringify(logData.analysis_meta || null),
                    function(err) {
                        if (err) {
                            console.error("Transaction Error (Log Signal):", err);
                            db.run("ROLLBACK");
                            return reject(err);
                        }
                        
                        // 3. Commit if both succeeded
                        db.run("COMMIT", (commitErr) => {
                            if (commitErr) {
                                console.error("Transaction Error (Commit):", commitErr);
                                db.run("ROLLBACK");
                                return reject(commitErr);
                            }
                            resolve(true);
                        });
                    }
                );
                stmt.finalize();
            });
        });
    },

    /**
     * Logs a "Shadow Bet" for Data Mining.
     * Does NOT affect portfolio balance.
     * @param {number} signalId 
     * @param {Object} tradeData - { side, entry_price, size_usd, category, league, outcome, token_index }
     */
    logShadowBet: (signalId, tradeData, analysisMeta = null) => {
        return new Promise((resolve, reject) => {
            // Use a fixed virtual user ID for mining (e.g., 0 or a specific admin ID)
            const systemMiningId = 0; 
            const virtualBet = 10; // Fixed $10 virtual bet for ROI calc

            db.run(
                `INSERT INTO user_signal_logs (
                    chat_id, signal_id, strategy, side, entry_price, size_usd, 
                    bet_amount, category, league, outcome, token_index, analysis_meta, status, notified
                ) VALUES (?, ?, 'shadow_mining', ?, ?, ?, ?, ?, ?, ?, ?, ?, 'OPEN', 1)`,
                [
                    systemMiningId, 
                    signalId, 
                    tradeData.side, 
                    tradeData.entry_price, 
                    tradeData.size_usd, 
                    virtualBet,
                    tradeData.category, 
                    tradeData.league, 
                    tradeData.outcome, 
                    tradeData.token_index,
                    JSON.stringify(analysisMeta)
                ],
                function(err) {
                    if (err) return reject(err);
                    resolve(this.lastID);
                }
            );
        });
    },

    // --- RESOLUTION / SETTLEMENT ---

    getAllOpenPositions: () => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT l.id, l.chat_id, l.strategy, l.bet_amount, l.entry_price, l.outcome, s.condition_id, s.market_slug 
                 FROM user_signal_logs l
                 JOIN signals s ON l.signal_id = s.id
                 WHERE l.status = 'OPEN' AND l.strategy != 'shadow_mining'`,
                [],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows || []);
                }
            );
        });
    },

    settlePosition: (id, chatId, betAmount, exitPrice, resolvedOutcome) => {
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");

                // 1. Calculate PnL
                // If exitPrice is 1 (Win), PnL% = ((1 - Entry) / Entry) * 100
                // If exitPrice is 0 (Loss), PnL% = -100
                
                // 2. Update Log
                db.run(
                    `UPDATE user_signal_logs 
                     SET status = 'CLOSED', 
                         exit_price = ?, 
                         resolved_outcome = ?,
                         closed_at = CURRENT_TIMESTAMP,
                         result_pnl_percent = ((? - entry_price) / entry_price) * 100
                     WHERE id = ?`,
                    [exitPrice, resolvedOutcome, exitPrice, id],
                    function(err) {
                        if (err) {
                            db.run("ROLLBACK");
                            return reject(err);
                        }
                    }
                );

                // 3. Update Portfolio (Credit Winnings)
                // If ExitPrice = 1, we get back: BetAmount / EntryPrice * 1.0
                // If ExitPrice = 0, we get back 0.
                // Note: We already deducted BetAmount from balance.
                // So we just add the payout.
                // Payout = (BetAmount / EntryPrice) * ExitPrice
                
                // Safety check for division by zero (shouldn't happen with entry_price > 0)
                // We'll do the math in JS before calling this, but let's assume valid inputs.
                
                // Wait, we need to read entry_price to calculate payout inside SQL? 
                // Easier to pass the calculated payout amount.
                // Let's change the signature or do a read first. 
                // Actually, the caller (index.js) should calculate the payout.
                
                // Let's assume the caller passes 'payoutAmount'.
            });
        });
    },
    
    // Simpler version: just update status and let caller handle portfolio update via updatePortfolio
    markPositionSettled: (id, exitPrice, resolvedOutcome) => {
        return new Promise((resolve, reject) => {
            db.run(
                `UPDATE user_signal_logs 
                 SET status = 'CLOSED', 
                     exit_price = ?, 
                     resolved_outcome = ?,
                     closed_at = CURRENT_TIMESTAMP,
                     result_pnl_percent = ((? - entry_price) / entry_price) * 100
                 WHERE id = ?`,
                [exitPrice, resolvedOutcome, exitPrice, id],
                function(err) {
                    if (err) return reject(err);
                    resolve(this.changes);
                }
            );
        });
    },

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
     * Get all challenge trades for a specific user and strategy
     */
    getChallengeTradesForUser: (chatId, strategyId) => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT status, result_pnl_percent, bet_amount, created_at, outcome, resolved_outcome
                 FROM user_signal_logs 
                 WHERE chat_id = ? AND strategy = ?
                 ORDER BY created_at DESC`,
                [chatId, strategyId],
                (err, rows) => {
                    if (err) return reject(err);
                    resolve(rows || []);
                }
            );
        });
    },
    resetPortfolio: (chatId, strategyId) => {
        return new Promise((resolve, reject) => {
            db.serialize(() => {
                db.run("BEGIN TRANSACTION");
                
                // 1. Reset Balance to $20.00
                db.run(`INSERT OR REPLACE INTO strategy_portfolios (user_id, strategy_id, balance, locked, is_challenge_active) 
                        VALUES (?, ?, 20.0, 0.0, 1)`, [chatId, strategyId]);
                
                // 2. Close any OPEN positions (Void them so they don't affect the new run)
                db.run(`UPDATE user_signal_logs SET status = 'CLOSED_RESET', resolved_outcome = 'RESET' 
                        WHERE chat_id = ? AND strategy = ? AND status = 'OPEN'`, [chatId, strategyId]);

                db.run("COMMIT", (err) => {
                    if (err) {
                        db.run("ROLLBACK");
                        return reject(err);
                    }
                    resolve(true);
                });
            });
        });
    },
    toggleStrategy: (chatId, strategyId, isActive) => {
        return new Promise((resolve, reject) => {
            const val = isActive ? 1 : 0;
            db.run(`UPDATE strategy_portfolios SET is_challenge_active = ? WHERE user_id = ? AND strategy_id = ?`, [val, chatId, strategyId], function(err) {
                if (err) return reject(err);
                resolve(this.changes);
            });
        });
    },

    getMiningStats: (days = 1) => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT 
                    COUNT(*) as total,
                    SUM(CASE WHEN result_pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
                    AVG(result_pnl_percent) as avg_roi,
                    SUM(CASE WHEN status = 'OPEN' THEN 1 ELSE 0 END) as pending
                 FROM user_signal_logs
                 WHERE strategy = 'shadow_mining' 
                   AND created_at >= datetime('now', '-' || ? || ' days')`,
                [days],
                (err, rows) => {
                    if (err) return reject(err);
                    const r = rows[0] || {};
                    resolve({
                        total: r.total || 0,
                        wins: r.wins || 0,
                        avg_roi: r.avg_roi || 0,
                        pending: r.pending || 0
                    });
                }
            );
        });
    },
    
    anyUserHasPosition,
    getOpenPositions,

    getStrategyOpenPositions: (chatId, strategyId) => {
        return new Promise((resolve, reject) => {
            db.all(
                `SELECT l.id, l.bet_amount, l.entry_price, l.outcome, s.condition_id 
                 FROM user_signal_logs l
                 JOIN signals s ON l.signal_id = s.id
                 WHERE l.chat_id = ? AND l.strategy = ? AND l.status = 'OPEN'`,
                [chatId, strategyId],
                (err, rows) => {
                    if (err) reject(err);
                    resolve(rows || []);
                }
            );
        });
    },
    closePosition
};
