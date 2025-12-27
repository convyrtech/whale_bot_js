# 📉 QUANT STRATEGY ROADMAP: PROJECT "WHALE HUNTER"
**Status:** ACTIVE
**Objective:** Maximize Absolute PnL (Profit & Loss)
**Risk Tolerance:** Aggressive (Smart Alpha)
**Deadline:** ASAP (Investors are watching)

---

## 📊 PHASE 1: DATA SUPREMACY (The Foundation)
*We cannot trade what we cannot measure. We need a statistical edge.*

- [ ] **Automated Whale Grading (Daily Cron Job)**
    - *Current:* Static VIP list (manual).
    - *Target:* Script that runs every 24h, scans all 3000+ tracked wallets, calculates `(Winrate * Volume) / Variance`, and automatically updates `VIP_WHALES` and `BLACKLIST`.
    - *Goal:* Remove human bias. Let the math pick the leaders.

- [ ] **"Shadow" Validation**
    - *Current:* We log "Shadow Bets".
    - *Target:* Compare "Shadow Entry Price" vs "Real Execution Price". Calculate **Slippage Impact**.
    - *Goal:* Determine if our execution speed is fast enough to be profitable on high-volatility markets.

## 🧠 PHASE 2: STRATEGY REFINEMENT (The Alpha)
*Refining the logic to squeeze every cent of profit.*

- [ ] **Strategy: "Inverse The Public" (Fade the Losers)**
    - *Hypothesis:* Retail traders lose money 80% of the time.
    - *Action:* Identify "Anti-Whales" (Winrate < 15% over 50 trades).
    - *Logic:* When Anti-Whale buys YES, we buy NO immediately.
    - *Sizing:* Increase bet size on Inverse signals (statistically higher probability than following winners).

- [ ] **Strategy: "Consensus Engine"**
    - *Hypothesis:* One whale can be wrong. Three whales are rarely wrong.
    - *Action:* Trigger a **MAX BET** only if ≥3 VIP Whales enter the same outcome within 1 hour.

- [ ] **Exit Strategy: "Copy-Sell" (The Safety Net)**
    - *Current:* We hold until market resolution. Capital is locked for too long.
    - *Target:* If the Whale sells their position, we MUST sell immediately.
    - *Goal:* Cut losses early and free up capital (Velocity of Money).

## 💰 PHASE 3: CAPITAL EFFICIENCY (The Bankroll)
*Don't let money rot. Make it work.*

- [ ] **Dynamic Kelly Criterion Sizing**
    - *Current:* Static $4 or $40 bets.
    - *Target:* Bet size = `f * (bp - q) / b`.
    - *Logic:* If a signal has 90% confidence, bet 10% of bankroll. If 55% confidence, bet 1%.
    - *Goal:* Exponential growth on sure bets, survival on risky ones.

- [ ] **Portfolio Rebalancing**
    - *Action:* Hard cap on "Sports" category (high variance). Unlimited cap on "Politics" (high edge).

## 🛠 PHASE 4: INFRASTRUCTURE (The Engine)
*Speed kills. Latency is the enemy.*

- [ ] **Direct Contract Interaction (Bypass API)**
    - *Current:* Using Polymarket API (HTTP).
    - *Target:* Direct RPC calls to Polygon blockchain for trade execution.
    - *Goal:* Save ~200-500ms per trade. Beat other bots.

---

## 📝 ANALYST NOTES
> "The market is a device for transferring money from the impatient to the patient." - Buffett.
> But in HFT (High Frequency Trading), the market transfers money from the *slow* to the *fast*.

**Immediate Next Step:** Implement **"Copy-Sell"** logic. We are currently holding bags if a whale dumps. This is a critical leak.
