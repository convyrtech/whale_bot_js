const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.resolve(__dirname, '../whale_bot.db');
const db = new sqlite3.Database(dbPath);

function runQuery(query, params = []) {
    return new Promise((resolve, reject) => {
        db.all(query, params, (err, rows) => {
            if (err) reject(err);
            else resolve(rows);
        });
    });
}

async function analyze() {
    console.log("📊 --- DEEP DIVE STATISTICS --- 📊\n");

    try {
        // 1. OVERALL STATS
        const overall = await runQuery(`
            SELECT 
                COUNT(*) as total_closed,
                SUM(CASE WHEN result_pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
                AVG(result_pnl_percent) as avg_pnl,
                SUM(size_usd) as total_volume
            FROM signals 
            WHERE status = 'CLOSED'
        `);
        
        const totalClosed = overall[0].total_closed;
        const wins = overall[0].wins;
        const winrate = totalClosed > 0 ? (wins / totalClosed * 100).toFixed(2) : 0;
        
        console.log(`🏆 Overall Winrate: ${winrate}% (${wins}/${totalClosed})`);
        console.log(`💰 Avg PnL per Trade: ${overall[0].avg_pnl ? overall[0].avg_pnl.toFixed(2) : 0}%`);
        console.log(`💸 Total Volume Traded: $${overall[0].total_volume ? overall[0].total_volume.toFixed(2) : 0}\n`);

        // 2. CATEGORY ANALYSIS (Inferred from slug)
        console.log("📂 --- PERFORMANCE BY CATEGORY ---");
        const signals = await runQuery("SELECT market_slug, result_pnl_percent FROM signals WHERE status = 'CLOSED'");
        
        const categories = {
            'Crypto (15m/Short)': { wins: 0, total: 0, pnl: 0 },
            'Crypto (Daily/Long)': { wins: 0, total: 0, pnl: 0 },
            'Sports (NBA/NFL/etc)': { wins: 0, total: 0, pnl: 0 },
            'Politics/News': { wins: 0, total: 0, pnl: 0 },
            'Other': { wins: 0, total: 0, pnl: 0 }
        };

        signals.forEach(s => {
            let cat = 'Other';
            const slug = (s.market_slug || '').toLowerCase();
            
            if (slug.includes('updown') || slug.includes('up-or-down')) {
                if (slug.includes('15m')) cat = 'Crypto (15m/Short)';
                else cat = 'Crypto (Daily/Long)';
            } else if (slug.includes('nba') || slug.includes('nfl') || slug.includes('soccer') || slug.includes('football') || slug.includes('ufc')) {
                cat = 'Sports (NBA/NFL/etc)';
            } else if (slug.includes('trump') || slug.includes('biden') || slug.includes('election') || slug.includes('musk') || slug.includes('tweet')) {
                cat = 'Politics/News';
            }

            categories[cat].total++;
            if (s.result_pnl_percent > 0) categories[cat].wins++;
            categories[cat].pnl += s.result_pnl_percent;
        });

        console.table(Object.entries(categories).map(([name, stats]) => ({
            Category: name,
            Trades: stats.total,
            Winrate: stats.total > 0 ? (stats.wins / stats.total * 100).toFixed(1) + '%' : '0%',
            AvgPnL: stats.total > 0 ? (stats.pnl / stats.total).toFixed(1) + '%' : '0%'
        })).filter(r => r.Trades > 0));

        // 3. WHALE ANALYSIS
        console.log("\n🐋 --- TOP 5 WORST WHALES (Don't follow these!) ---");
        const whales = await runQuery(`
            SELECT 
                whale_address,
                COUNT(*) as count,
                SUM(CASE WHEN result_pnl_percent > 0 THEN 1 ELSE 0 END) as wins,
                AVG(result_pnl_percent) as avg_pnl
            FROM signals 
            WHERE status = 'CLOSED'
            GROUP BY whale_address
            HAVING count >= 2
            ORDER BY avg_pnl ASC
            LIMIT 5
        `);
        
        console.table(whales.map(w => ({
            Address: w.whale_address.slice(0, 8) + '...',
            Trades: w.count,
            Winrate: (w.wins / w.count * 100).toFixed(0) + '%',
            AvgPnL: w.avg_pnl.toFixed(0) + '%'
        })));

        // 4. LONG TERM BETS ANALYSIS (Open bets)
        console.log("\n⏳ --- LONG TERM / STUCK BETS (Open > 24h) ---");
        const openBets = await runQuery(`
            SELECT id, market_slug, created_at 
            FROM signals 
            WHERE status = 'OPEN'
        `);
        
        const now = Date.now();
        let longBetsCount = 0;
        const longBets = [];

        openBets.forEach(b => {
            const created = new Date(b.created_at).getTime();
            const diffHours = (now - created) / (1000 * 60 * 60);
            if (diffHours > 24) {
                longBetsCount++;
                if (longBets.length < 5) longBets.push({
                    id: b.id,
                    slug: b.market_slug,
                    age_hours: diffHours.toFixed(1)
                });
            }
        });

        console.log(`Total Open Bets: ${openBets.length}`);
        console.log(`Bets open longer than 24h: ${longBetsCount}`);
        if (longBets.length > 0) {
            console.table(longBets);
        } else {
            console.log("No bets open longer than 24h found.");
        }

    } catch (e) {
        console.error("Analysis failed:", e);
    }
}

analyze();
