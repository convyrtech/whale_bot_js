const fetch = require('node-fetch');
const puppeteer = require('puppeteer');
const math = require('./math_utils');

// Configuration
const API_BASE_URL = 'https://data-api.polymarket.com';
const GRAPHQL_ENDPOINT = 'https://api.goldsky.com/api/public/project_cl6mb8i9h0003e201j6li0diw/subgraphs/pnl-subgraph/0.0.14/gn';
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

// 1. Fetch Trades
async function fetchTrades(limit = 200) {
    try {
        const response = await fetch(`${API_BASE_URL}/trades?limit=${limit}`);
        if (!response.ok) {
            console.error(`❌ fetchTrades API Error: ${response.status} ${response.statusText}`);
            throw new Error(`API Error: ${response.statusText}`);
        }
        const trades = await response.json();
        if (process.env.DEBUG_TRADES === '1') console.log(`✅ fetchTrades: Got ${trades.length} trades from API`);
        return trades;
    } catch (error) {
        console.error(`❌ fetchTrades Error (attempt 1): ${error.message}`);
        try {
            await new Promise(r => setTimeout(r, 500));
            const response2 = await fetch(`${API_BASE_URL}/trades?limit=${limit}`);
            if (response2.ok) {
                const trades = await response2.json();
                console.log(`✅ fetchTrades retry: Got ${trades.length} trades`);
                return trades;
            }
        } catch (err) {
            console.error(`❌ fetchTrades Error (attempt 2): ${err.message}`);
        }
        console.warn('⚠️ fetchTrades returning empty array');
        return [];
    }
}

// 2. Fetch User History (GraphQL)
async function fetchUserHistory(address, currentTradeValue = 0) {
    if ((currentTradeValue || 0) < 5) {
        if (process.env.DEBUG_TRADES === '1') console.log(`[fetchUserHistory] Trade $${currentTradeValue} < $5 threshold. Skipping wallet analysis.`);
        return { pnl: 0, medianPnl: 0, winrate: 0, winrateLowerBound: 0, totalVolume: 0, totalTrades: 0, status: 'skipped_low_value' };
    }
    const addrKey = String(address || '').toLowerCase();
    const cached = whaleCache.get(addrKey);
    if (cached && (Date.now() - cached.timestamp) < CACHE_TTL_MS) {
        return cached.data;
    }
    const query = `
    {
      userPositions(where: {user: "${address.toLowerCase()}", closed: true}, first: 1000) {
        profit
        outcomeIndex
        totalBought
      }
    }
    `;
    
    try {
        console.log("Fetching history for: " + address);
        const response = await fetch(GRAPHQL_ENDPOINT, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ query })
        });
        
        if (!response.ok) return { pnl: 0, medianPnl: 0, winrate: 0, winrateLowerBound: 0, totalVolume: 0, totalTrades: 0 };
        const data = await response.json();
        if (data.errors || !data.data || !data.data.userPositions) return { pnl: 0, medianPnl: 0, winrate: 0, winrateLowerBound: 0, totalVolume: 0, totalTrades: 0 };
        
        const positions = data.data.userPositions;
        let totalRealizedPnl = 0;
        let wins = 0;
        let losses = 0;
        let totalVolume = 0;
        const pnlList = [];
        
        for (const p of positions) {
            let pnl = math.normalizePolymarketValue(p.profit || 0);
            const bought = math.normalizePolymarketValue(p.totalBought || 0);
            
            totalRealizedPnl += pnl;
            totalVolume += bought;
            
            pnlList.push(pnl);
            if (pnl > 0) wins++;
            else if (pnl < 0) losses++;
        }
        
        const closedCount = positions.length;
        if (closedCount === 0) {
            console.log("⚠️ No history for " + address + " (New wallet?)");
        }
        
        let winrate = 0;
        if (closedCount > 0) winrate = (wins / closedCount) * 100;
        
        // Quantitative Metrics
        const medianPnl = math.calculateMedian(pnlList);
        const winrateLowerBound = math.wilsonScoreLowerBound(wins, closedCount) * 100;
        console.log("Stats for " + address + ": Positions=" + closedCount + ", Profit=" + totalRealizedPnl.toFixed(0));

        const result = {
            pnl: totalRealizedPnl,
            medianPnl: medianPnl,
            winrate: winrate,
            winrateLowerBound: winrateLowerBound,
            totalVolume: totalVolume,
            totalTrades: closedCount
        };
        whaleCache.set(addrKey, { data: result, timestamp: Date.now() });
        return result;
    } catch (error) {
        console.error('GraphQL Error:', error);
        return { pnl: 0, medianPnl: 0, winrate: 0, winrateLowerBound: 0, totalVolume: 0, totalTrades: 0 };
    }
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

module.exports = {
    fetchTrades,
    fetchUserHistory,
    generateCardImage,
    fmt,
    categorizeMarket,
    extractLeague,
    getWhaleCacheSize: () => whaleCache.size
};
