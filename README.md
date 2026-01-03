# 🐳 Polywhale Bot v3.0 (Diamond Edition)

Precision whale tracking and automated trading for Polymarket with quantitative risk management.

## 🚀 Key Features
- **Strategy Insider:** Detects high-conviction "fresh" wallets and tracks insider movements.
- **Kelly Criterion:** Advanced money management that scales bets based on statistical edge.
- **Flash Boost:** 25% bet boost for high-conviction signals (Score 85+) resolving in < 6 hours.
- **Toxic Zone Filtering:** Automatically ignores trades with 40-70% probability to avoid high-efficiency "noise".
- **Multi-Strategy Portfolios:** Split capital across Sniper, Insider, Trend, and Shadow Mining strategies.

## 🛠️ Setup
1. **Clone the repo:**
   ```bash
   git clone <your-repo-url>
   cd whale_bot_js
   ```
2. **Install dependencies:**
   ```bash
   npm install
   ```
3. **Configure Environment:** Create a `.env` file with your keys:
   - `TELEGRAM_TOKEN`
   - `DB_PATH` (defaults to whale_bot.db)

4. **Run the bot:**
   ```bash
   node index.js
   ```

## 📊 Analytics
Use the `/stats` command in Telegram to see:
- **Risk Profile:** Performance by odds-bucket (Longshots vs. Safe bets).
- **Speed Profile:** Capital velocity tracking (Flash vs. Swing trades).
- **Portfolio Health:** Real-time equity and locked funds tracking.

## ⚖️ License
MIT
