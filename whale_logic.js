const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const math = require('./math_utils');
const logger = require('./utils/logger');

// Configuration
const API_BASE_URL = 'https://data-api.polymarket.com';
const GRAPHQL_ENDPOINTS = [
    'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/polymarket/prod/gn',
    'https://subgraph-backup.polymarket.com/subgraphs/name/polymarket/matic-graph-fast'
];
const whaleCache = new Map();
const CACHE_TTL_MS = 60 * 60 * 1000;
setInterval(() => {
    const now = Date.now();
    for (const [key, val] of whaleCache.entries()) {
        if (!val || !val.timestamp || now - val.timestamp > CACHE_TTL_MS) {
            whaleCache.delete(key);
        }
    }
}, CACHE_TTL_MS);

// Format Currency
const fmt = (num) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 }).format(num);

const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'application/json',
    'Origin': 'https://polymarket.com',
    'Referer': 'https://polymarket.com/'
};

// 1. Fetch Trades
async function fetchTrades(limit = 200) {
    try {
        const response = await fetch(`${API_BASE_URL}/trades?limit=${limit}`, { headers: HEADERS });
        if (!response.ok) {
            logger.error(`❌ fetchTrades API Error: ${response.status} ${response.statusText}`);
            throw new Error(`API Error: ${response.statusText}`);
        }
        const trades = await response.json();
        if (process.env.DEBUG_TRADES === '1') logger.debug(`✅ fetchTrades: Got ${trades.length} trades from API`);
        return trades;
    } catch (error) {
        if (error.code === 'ECONNRESET' || error.message.includes('ECONNRESET')) {
            logger.warn("⚠️ NETWORK ERROR (ECONNRESET): Connection blocked. Please enable VPN!");
        } else {
            logger.error(`❌ fetchTrades Error (attempt 1): ${error.message}`);
        }
        try {
            await new Promise(r => setTimeout(r, 2000)); // Wait longer for network issues
            const response2 = await fetch(`${API_BASE_URL}/trades?limit=${limit}`);
            if (response2.ok) {
                const trades = await response2.json();
                logger.info(`✅ fetchTrades retry: Got ${trades.length} trades`);
                return trades;
            }
        } catch (err) {
            logger.error(`❌ fetchTrades Error (attempt 2): ${err.message}`);
        }
        logger.warn('⚠️ fetchTrades returning empty array');
        return [];
    }
}

// 2. Fetch User History (Hybrid: Goldsky Graph + Data API Fallback)
async function fetchUserHistory(address, currentTradeValue = 0) {
    if ((currentTradeValue || 0) < 5) {
        if (process.env.DEBUG_TRADES === '1') logger.debug(`[fetchUserHistory] Trade $${currentTradeValue} < $5 threshold. Skipping wallet analysis.`);
        return { pnl: 0, medianPnl: 0, winrate: 0, winrateLowerBound: 0, totalVolume: 0, totalTrades: 0, status: 'skipped_low_value' };
    }

    const userId = address.toLowerCase();

    // CACHE CHECK
    const cached = whaleCache.get(userId);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        return cached.data;
    }

    // --- STRATEGY A: GOLDSKY GRAPHQL (The "Smart" Way) ---
    try {
        const result = await fetchHistoryGraphQL(userId);
        if (result) {
            logger.debug(`✅ Goldsky Stats for ${userId}: PnL=$${result.pnl.toFixed(0)}, WR=${result.winrate.toFixed(1)}%`);
            whaleCache.set(userId, { data: result, timestamp: Date.now() });
            return result;
        }
    } catch (e) {
        logger.warn(`GraphQL failed for ${userId}, switching to Data API fallback.`);
    }

    // --- STRATEGY B: DATA API FALLBACK (The "Sniper" Way) ---
    try {
        logger.debug(`Fetching history for: ${userId} via Data API (Fallback)`);
        const result = await fetchHistoryDataApi(userId);
        whaleCache.set(userId, { data: result, timestamp: Date.now() });
        return result;
    } catch (error) {
        logger.error('Data API Error:', error);
        return { pnl: 0, medianPnl: 0, winrate: 0, winrateLowerBound: 0, totalVolume: 0, totalTrades: 0 };
    }
}

// Helper: Goldsky GraphQL
async function fetchHistoryGraphQL(userId) {
    const query = `
        query GetUserHistory($id: ID!) {
            user(id: $id) {
                # Get PnL data
                userPositions(first: 200, orderBy: updated, orderDirection: desc) {
                    buyAmount
                    sellAmount
                    payout
                    market {
                        slug
                        question
                    }
                }
            }
            # Get First Transaction for Account Age
            transactions(first: 1, orderBy: timestamp, orderDirection: asc, where: { user: $id }) {
                timestamp
            }
        }
    `;

    // Use the first valid endpoint from our list (or just the main one)
    const endpoint = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/polymarket/prod/gn';

    const response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ query, variables: { id: userId } })
    });

    if (!response.ok) return null;
    const json = await response.json();
    if (!json.data || !json.data.user) return null;

    const positions = json.data.user.userPositions || [];
    const firstTx = (json.data.transactions && json.data.transactions[0]) ? json.data.transactions[0] : null;

    // Calculate Account Age
    let firstTradeTimestamp = 0;
    if (firstTx) {
        firstTradeTimestamp = Number(firstTx.timestamp) * 1000;
        logger.debug(`[Stats] Wallet ${userId} Age: ${((Date.now() - firstTradeTimestamp) / (86400000)).toFixed(1)} days`);
    }

    if (positions.length === 0 && firstTradeTimestamp === 0) return null;

    let items = [];

    for (const pos of positions) {
        const bought = Number(pos.buyAmount) || 0;
        const sold = Number(pos.sellAmount) || 0;
        const payout = Number(pos.payout) || 0;

        // Only count closed or partially closed positions for PnL
        if (sold > 0 || payout > 0) {
            const profit = (sold + payout) - bought;
            const market = pos.market || {};
            const cat = categorizeMarket(market.question, market.slug);

            items.push({
                pnl: profit,
                volume: bought,
                category: cat,
                isWin: profit > 0
            });
        }
    }


    const result = calculateStats(items);
    result.firstTradeTimestamp = firstTradeTimestamp;
    return result;
}

// Helper: Data API
async function fetchHistoryDataApi(userId) {
    // 1. Fetch Active Positions (for PnL)
    const posResponse = await fetch(`https://data-api.polymarket.com/positions?user=${userId}`, { headers: HEADERS });
    let positions = [];
    if (posResponse.ok) positions = await posResponse.json();

    // 2. Fetch Recent Trades (for Volume & Count)
    const tradesResponse = await fetch(`https://data-api.polymarket.com/trades?maker_address=${userId}&limit=500`, { headers: HEADERS });
    let trades = [];
    if (tradesResponse.ok) trades = await tradesResponse.json();

    if (positions.length === 0 && trades.length === 0) {
        return calculateStats([]);
    }

    let items = [];

    // A. Process Positions (Closed/Active PnL)
    for (const p of positions) {
        const pnl = Number(p.cashPnl) || 0;
        const market = p.market || {};
        const cat = categorizeMarket(market.question, market.slug);

        items.push({
            pnl: pnl,
            volume: 0, // Volume handled by trades
            category: cat,
            isWin: pnl > 0
        });
    }

    // B. Process Trades (Volume) - Note: This is imperfect mixing, but serves the purpose
    // Ideally we'd link trades to positions, but for now we just want volume stats.
    // We'll add "dummy" items for volume if we want to track volume per category, 
    // but calculateStats mainly uses volume for global. 
    // Let's try to extract category from trades for volume tracking.
    let volumeByCat = {};
    let totalVolume = 0;

    for (const t of trades) {
        const vol = (Number(t.price || 0) * Number(t.size || 0));
        totalVolume += vol;
        const cat = categorizeMarket(t.title, t.slug);
        volumeByCat[cat] = (volumeByCat[cat] || 0) + vol;
    }

    // Merge volume into stats? 
    // For simplicity in Data API fallback, we might just use global volume 
    // or try to attribute it. 
    // Let's just pass the items we have from positions for PnL/Winrate, 
    // and pass a separate volume map if needed.
    // Actually, calculateStats can take an optional volume override.

    const stats = calculateStats(items);
    stats.global.totalVolume = totalVolume; // Override global volume with trade volume

    // Update category volumes
    for (const [cat, vol] of Object.entries(volumeByCat)) {
        if (stats[cat]) stats[cat].totalVolume = vol;
        else stats[cat] = { ...stats.global, totalVolume: vol, totalTrades: 0, pnl: 0 }; // Stub if no positions but has volume
    }

    return stats;
}

function calculateStats(items) {
    // Initialize categories
    const categories = ['global', 'politics', 'sports', 'crypto', 'weather', 'other'];
    const result = {};

    categories.forEach(cat => {
        result[cat] = {
            pnl: 0,
            medianPnl: 0,
            winrate: 0,
            winrateLowerBound: 0,
            totalVolume: 0,
            totalTrades: 0
        };
    });

    // Group items
    const groups = { global: items };
    items.forEach(item => {
        const c = item.category || 'other';
        if (!groups[c]) groups[c] = [];
        groups[c].push(item);
    });

    // Calculate for each group
    for (const [cat, groupItems] of Object.entries(groups)) {
        if (!result[cat]) result[cat] = { pnl: 0, medianPnl: 0, winrate: 0, winrateLowerBound: 0, totalVolume: 0, totalTrades: 0 };

        const count = groupItems.length;
        if (count === 0) continue;

        let totalPnl = 0;
        let totalVolume = 0;
        let wins = 0;
        let pnls = [];

        for (const item of groupItems) {
            totalPnl += item.pnl;
            totalVolume += item.volume;
            if (item.isWin) wins++;
            pnls.push(item.pnl);
        }

        // Median
        pnls.sort((a, b) => a - b);
        const mid = Math.floor(count / 2);
        const medianPnl = count % 2 !== 0 ? pnls[mid] : (pnls[mid - 1] + pnls[mid]) / 2;

        // Winrate
        const winrate = (wins / count) * 100;

        // Wilson Score
        let winrateLowerBound = 0;
        if (count > 0) {
            const z = 1.96;
            const phat = wins / count;
            const lowerBound = (phat + z * z / (2 * count) - z * Math.sqrt((phat * (1 - phat) + z * z / (4 * count)) / count)) / (1 + z * z / count);
            winrateLowerBound = Math.max(0, lowerBound * 100);
        }

        // Streak Calculation (Tilt Protection)
        // Assumes items are roughly ordered by time (descending)
        let currentStreak = 0;
        for (const item of groupItems) {
            if (item.pnl > 0) {
                if (currentStreak >= 0) currentStreak++;
                else break;
            } else if (item.pnl < 0) {
                if (currentStreak <= 0) currentStreak--;
                else break;
            }
        }

        result[cat] = {
            pnl: totalPnl,
            medianPnl: medianPnl,
            winrate: winrate,
            winrateLowerBound: winrateLowerBound,
            totalVolume: totalVolume,
            totalTrades: count,
            streak: currentStreak
        };
    }

    return result;
}

// 3. Generate Image (Puppeteer)
async function generateCardImage(data) {
    const browser = await puppeteer.launch({
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const page = await browser.newPage();

    // Determine colors based on PnL
    let color = '#2ea043'; // Green
    let color_dark = '#238636';
    let bg_color = 'rgba(46, 160, 67, 0.15)';
    let pnl_class = 'green';

    if (data.pnl < 0) {
        color = '#f85149'; // Red
        color_dark = '#da3633';
        bg_color = 'rgba(248, 81, 73, 0.15)';
        pnl_class = 'red';
    } else if (data.pnl === 0) {
        color = '#8b949e'; // Gray
        color_dark = '#6e7681';
        bg_color = 'rgba(139, 148, 158, 0.15)';
        pnl_class = '';
    }

    // Median PnL Color
    let median_color = '#8b949e';
    if (data.median_pnl > 0) median_color = '#4ade80';
    else if (data.median_pnl < 0) median_color = '#ef4444';

    const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head>
        <meta charset="UTF-8">
        <style>
            body { background-color: #0d1117; color: #c9d1d9; font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif; display: flex; justify-content: center; align-items: center; height: 100vh; margin: 0; }
            .card { width: 600px; background: #161b22; border: 1px solid #30363d; border-radius: 16px; padding: 24px; box-shadow: 0 10px 30px rgba(0,0,0,0.5); position: relative; overflow: hidden; }
            .card::before { content: ''; position: absolute; top: 0; left: 0; width: 100%; height: 4px; background: linear-gradient(90deg, ${color}, ${color_dark}); }
            .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
            .whale-badge { background: ${bg_color}; color: ${color}; padding: 6px 12px; border-radius: 100px; font-weight: bold; font-size: 14px; display: flex; align-items: center; gap: 6px; }
            .wallet { font-family: 'Consolas', monospace; color: #8b949e; font-size: 14px; }
            .stats-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 16px; margin-bottom: 24px; }
            .stat-box { background: #0d1117; border: 1px solid #30363d; border-radius: 12px; padding: 16px; }
            .stat-label { font-size: 12px; color: #8b949e; margin-bottom: 4px; text-transform: uppercase; letter-spacing: 0.5px; }
            .stat-value { font-size: 24px; font-weight: bold; color: #f0f6fc; }
            .stat-value.green { color: #3fb950; }
            .stat-value.red { color: #f85149; }
            .market-info { border-top: 1px solid #30363d; padding-top: 20px; }
            .market-question { font-size: 18px; font-weight: 600; margin-bottom: 8px; color: #f0f6fc; line-height: 1.4; }
            .trade-details { display: flex; gap: 16px; font-size: 14px; color: #8b949e; }
            .trade-badge { background: #1f6feb; color: white; padding: 2px 8px; border-radius: 4px; font-size: 12px; font-weight: bold; }
            .footer { margin-top: 20px; font-size: 12px; color: #484f58; text-align: right; display: flex; justify-content: space-between; align-items: center; }
            .logo { font-weight: bold; color: #58a6ff; display: flex; align-items: center; gap: 6px; }
        </style>
    </head>
    <body>
        <div class="card">
            <div class="header">
                <div class="whale-badge">${data.whale_status}</div>
                <div class="wallet">${data.wallet_short}</div>
            </div>
            
            <div class="stats-grid">
                <div class="stat-box">
                    <div class="stat-label">Общий PnL</div>
                    <div class="stat-value ${pnl_class}">${data.pnl_fmt}</div>
                </div>
                <div class="stat-box">
                    <div class="stat-label">Винрейт</div>
                    <div class="stat-value">${data.winrate_fmt}</div>
                </div>
                <div class="stat-box">
                    <div class="stat-label">Median PnL</div>
                    <div class="stat-value" style="color: ${median_color}; font-size: 20px;">${data.median_fmt}</div>
                </div>
                <div class="stat-box">
                    <div class="stat-label">Общий Объём</div>
                    <div class="stat-value">${data.volume_fmt}</div>
                </div>
                <div class="stat-box">
                    <div class="stat-label">Сделок</div>
                    <div class="stat-value">${data.total_trades_fmt}</div>
                </div>
            </div>
    
            <div class="market-info">
                <div class="market-question">
                    ${data.market_question}
                </div>
                <div class="trade-details">
                    <span>Исход: <strong style="color: #f0f6fc">${data.outcome}</strong></span>
                    <span class="trade-badge">${data.side}</span>
                </div>
            </div>
            
            <div class="footer">
                <span>${data.timestamp}</span>
                <div class="logo">🦅 WhaleTracker</div>
            </div>
        </div>
    </body>
    </html>
    `;

    await page.setContent(htmlContent);
    const element = await page.$('.card');
    const imageBuffer = await element.screenshot({ type: 'png' });

    await browser.close();
    return imageBuffer;
}

// 4. Categorize Market
function categorizeMarket(title, slug) {
    const t = (title || '').toLowerCase();
    const s = (slug || '').toLowerCase();
    const text = t + ' ' + s;

    if (text.includes('bitcoin') || text.includes('ethereum') || text.includes('crypto') || text.includes('btc') || text.includes('eth') || text.includes('solana') || text.includes('price')) return 'crypto';
    if (text.includes('trump') || text.includes('harris') || text.includes('election') || text.includes('president') || text.includes('senate') || text.includes('democrat') || text.includes('republican')) return 'politics';
    if (text.includes('nfl') || text.includes('nba') || text.includes('football') || text.includes('soccer') || text.includes('game') || text.includes('winner') || text.includes('champions')) return 'sports';
    if (text.includes('temperature') || text.includes('rain') || text.includes('hurricane') || text.includes('weather') || text.includes('snow')) return 'weather';

    return 'other';
}

function extractLeague(title, slug) {
    const t = (title || '').toLowerCase();
    const s = (slug || '').toLowerCase();
    if (t.includes('nfl') || s.includes('nfl')) return 'NFL';
    if (t.includes('nba') || s.includes('nba')) return 'NBA';
    if (t.includes('mlb') || s.includes('mlb')) return 'MLB';
    if (t.includes('nhl') || s.includes('nhl')) return 'NHL';
    if (t.includes('premier league') || s.includes('premier')) return 'Premier League';
    if (t.includes('soccer') || s.includes('soccer') || t.includes('fifa')) return 'Soccer';
    return null;
}

// 5. Fetch Current Price (Pre-Flight Check)
async function fetchCurrentPrice(conditionId, outcome) {
    try {
        // Using Data API to get market details
        const response = await fetch(`${API_BASE_URL}/markets?condition_id=${conditionId}`);
        if (!response.ok) return null;

        const data = await response.json();
        if (!data || data.length === 0) return null;

        const market = data[0];
        if (!market.tokens) return null;

        // Find the token for the outcome
        const token = market.tokens.find(t => t.outcome === outcome);
        if (token) {
            return Number(token.price || 0);
        }
        return null;
    } catch (e) {
        logger.error(`[Price Check] Error fetching price for ${conditionId}: ${e.message}`);
        return null;
    }
}

// 6. Check Market Resolution
// 6. Fetch Market Details (CLOB API - More Reliable for Metadata)
async function fetchMarketDetails(conditionId) {
    try {
        const response = await fetch(`https://clob.polymarket.com/markets/${conditionId}`);
        if (!response.ok) return null;
        return await response.json();
    } catch (e) {
        logger.error(`[Market Details] Error for ${conditionId}: ${e.message}`);
        return null;
    }
}

// 7. Check Market Resolution
async function fetchMarketStatus(conditionId) {
    try {
        // Use CLOB API via fetchMarketDetails
        const m = await fetchMarketDetails(conditionId);
        if (!m) return null;

        // Check if resolved
        if (m.closed || m.resolved_by) { // CLOB uses resolved_by (snake_case) or we check tokens
            if (m.tokens) {
                const winner = m.tokens.find(t => t.winner === true);
                if (winner) return { resolved: true, winnerOutcome: winner.outcome };
            }
            // Fallback: Check if one outcome price is 1.0 (CLOB sometimes doesn't mark winner explicitly in tokens immediately)
            if (m.tokens) {
                const winnerByPrice = m.tokens.find(t => Number(t.price) >= 0.999);
                if (winnerByPrice) return { resolved: true, winnerOutcome: winnerByPrice.outcome };
            }
        }

        return { resolved: false };
    } catch (e) {
        logger.error(`[Resolution Check] Error for ${conditionId}: ${e.message}`);
        return null;
    }
}

module.exports = {
    fetchTrades,
    fetchUserHistory,
    generateCardImage,
    fmt,
    categorizeMarket,
    extractLeague,
    fetchCurrentPrice,
    fetchMarketStatus,
    fetchMarketDetails,
    getWhaleCacheSize: () => whaleCache.size
};
