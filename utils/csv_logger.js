const fs = require('fs');
const path = require('path');

// Ensure data/history directory exists
const LOG_DIR = path.resolve(__dirname, '..', 'data', 'history');
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

const getFilePath = () => {
    const date = new Date().toISOString().split('T')[0];
    return path.join(LOG_DIR, `trades_ml_${date}.csv`);
};

// Updated Header with ML Features
const HEADER = 'timestamp,transactionHash,maker_address,market_slug,condition_id,outcome,side,price,size,volume_usd,whale_pnl,whale_winrate,bot_score,market_title';

/**
 * Logs a trade with ML features to the daily CSV file.
 * @param {Object} trade - The trade object from Data API
 * @param {Object} whaleStats - Point-in-time stats of the whale
 * @param {number} botScore - The calculated score (0-100)
 */
function logTradeToCSV(trade, whaleStats = {}, botScore = 0) {
    try {
        const filePath = getFilePath();
        
        // Create file with header if it doesn't exist
        if (!fs.existsSync(filePath)) {
            fs.writeFileSync(filePath, HEADER + '\n');
        }

        // Extract fields
        const ts = trade.timestamp ? trade.timestamp : Math.floor(Date.now() / 1000);
        const txHash = trade.transactionHash || '';
        const maker = trade.maker_address || trade.proxyWallet || '';
        const slug = trade.slug || trade.market_slug || '';
        const condId = trade.conditionId || trade.condition_id || '';
        const outcome = trade.outcome || '';
        const side = trade.side || '';
        const price = Number(trade.price || 0);
        const size = Number(trade.size || 0);
        const vol = price * size;
        
        // ML Features
        // Handle both new structured stats (with .global) and old flat stats
        const stats = whaleStats.global || whaleStats;
        const pnl = stats.pnl || 0;
        const winrate = stats.winrate || 0;
        const score = botScore || 0;

        // Sanitize title
        const title = (trade.title || '').replace(/,/g, ' ').replace(/[\r\n]+/g, ' ').trim();

        const row = `${ts},${txHash},${maker},${slug},${condId},${outcome},${side},${price},${size},${vol},${pnl},${winrate},${score},${title}`;
        
        fs.appendFileSync(filePath, row + '\n');
    } catch (e) {
        console.error("CSV Log Error:", e.message);
    }
}

module.exports = { logTradeToCSV };