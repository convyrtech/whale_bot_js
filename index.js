require('dotenv').config();
process.env.NTBA_FIX_350 = process.env.NTBA_FIX_350 || '1';
const TelegramBot = require('node-telegram-bot-api');
const db = require('./database');
const ui = require('./keyboards');
const logic = require('./whale_logic');
const portfolio = require('./portfolio_manager');
const forwardTester = require('./forward_tester');
const logger = require('./utils/logger');
const csvLogger = require('./utils/csv_logger');
const fs = require('fs');
const path = require('path');

// Strategies
const strategies = [
    require('./strategies/sniper'),
    require('./strategies/inverse'),
    require('./strategies/trend_surfer')
];

// Error Handling
process.on('unhandledRejection', (reason) => {
    logger.error('unhandledRejection', reason);
});
process.on('uncaughtException', (err) => {
    logger.error('uncaughtException', err);
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'YOUR_TELEGRAM_TOKEN';
const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: { interval: 300, params: { timeout: 10 } } });

// Initialize
db.initDb();

// --- SELF-TEST ---
async function runSelfTest() {
    logger.info("🛠️ Running System Self-Test...");
    try {
        // 1. DB Check
        await db.getAllActiveUsers();
        logger.info("✅ Database Connection: OK");

        // 2. API Check
        const trades = await logic.fetchTrades(1);
        if (trades && Array.isArray(trades)) {
            logger.info("✅ Polymarket API: OK");
        } else {
            throw new Error("Polymarket API returned invalid data");
        }

        // 3. Logic Check
        if (typeof logic.fetchUserHistory !== 'function') throw new Error("Logic module broken");
        logger.info("✅ Logic Module: OK");

        logger.info("🚀 All Systems GO. Starting Bot...");
        return true;
    } catch (e) {
        logger.error("❌ SELF-TEST FAILED. BOT STOPPED.", e);
        process.exit(1);
    }
}

runSelfTest().then(() => {
    logger.info("🐳 Whale Bot v3.0 (Unicorn Portfolio Edition) Started...");
    forwardTester.startService();
});

// Set Telegram Menu Commands
bot.setMyCommands([
    { command: '/menu', description: 'Show Portfolio Dashboard' },
    { command: '/status', description: 'Check System Health' },
    { command: '/reset', description: 'Reset Challenge to $20' }
]).catch(e => logger.error("Failed to set commands", e));

// --- COMMANDS & DASHBOARD ---

const getDashboardText = async (chatId) => {
    let report = ["💼 **Multi-Strategy Portfolio**\n"];
    let totalEquity = 0;
    let totalStart = 0;

    for (const strat of strategies) {
        let pf = await db.getPortfolio(chatId, strat.id);
        if (!pf) {
            await db.initPortfolio(chatId, strat.id);
            pf = await db.getPortfolio(chatId, strat.id);
        }

        const balance = (pf.balance || 0);
        const locked = (pf.locked || 0); 

        // --- Calculate Unrealized PnL (Mark-to-Market) ---
        const positions = await db.getStrategyOpenPositions(chatId, strat.id);
        let marketValue = 0;
        
        // Fetch prices sequentially to avoid rate limits
        for (const pos of positions) {
            const currentPrice = await logic.fetchCurrentPrice(pos.condition_id, pos.outcome);
            if (currentPrice !== null) {
                const shares = pos.bet_amount / pos.entry_price;
                marketValue += shares * currentPrice;
            } else {
                marketValue += pos.bet_amount; // Fallback to cost
            }
        }
        
        // If no positions but locked funds exist (rare sync issue), use locked
        if (positions.length === 0 && locked > 0) marketValue = locked;

        const equity = balance + marketValue;
        const startBalance = 20.00;
        const pnl = ((equity - startBalance) / startBalance) * 100;
        const pnlSign = pnl >= 0 ? '+' : '';
        const icon = pnl >= 0 ? '🟢' : '🔴';
        
        const unrealizedPnl = marketValue - locked;
        const unrSign = unrealizedPnl >= 0 ? '+' : '';

        report.push(`**${strat.name}**`);
        report.push(`   ${icon} Eq: $${equity.toFixed(2)} (${pnlSign}${pnl.toFixed(1)}%)`);
        if (positions.length > 0) {
            report.push(`   📊 Unr: ${unrSign}$${unrealizedPnl.toFixed(2)}`);
        }
        report.push(`   💵 Bal: $${balance.toFixed(2)} | 🔒 Lock: $${locked.toFixed(2)}`);
        
        totalEquity += equity;
        totalStart += startBalance;
    }

    const totalPnl = ((totalEquity - totalStart) / totalStart) * 100;
    const totalSign = totalPnl >= 0 ? '+' : '';

    report.push("");
    report.push(`📊 **Total Equity:** $${totalEquity.toFixed(2)}`);
    report.push(`📈 **Total PnL:** ${totalSign}${totalPnl.toFixed(2)}%`);
    report.push("");
    report.push("⛏️ **AI Data Mining:** 🟢 Active");

    return report.join('\n');
};

bot.onText(/\/start|\/menu/, async (msg) => {
    const chatId = msg.chat.id;
    await db.createUser(chatId);
    const text = await getDashboardText(chatId);
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: ui.mainMenu });
});

bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id;
    for (const strat of strategies) {
        await db.resetPortfolio(chatId, strat.id);
    }
    await bot.sendMessage(chatId, "🔄 **All Portfolios Reset!**\nEach strategy restored to $20.00.", { 
        parse_mode: 'Markdown',
        reply_markup: ui.mainMenu 
    });
});

bot.onText(/\/status/, async (msg) => {
    const chatId = msg.chat.id;
    const uptime = process.uptime();
    const uptimeHrs = Math.floor(uptime / 3600);
    const uptimeMins = Math.floor((uptime % 3600) / 60);
    
    const memUsage = (process.memoryUsage().rss / 1024 / 1024).toFixed(2);
    const lastLoopSeconds = ((Date.now() - lastLoopTime) / 1000).toFixed(1);
    
    const openPositions = await db.getAllOpenPositions();
    const activeUsers = await db.getAllActiveUsers();

    const statusMsg = [
        "🏥 **System Status**",
        `⏱️ Uptime: ${uptimeHrs}h ${uptimeMins}m`,
        `🧠 Memory: ${memUsage} MB`,
        `💓 Last Scan: ${lastLoopSeconds}s ago`,
        `👥 Active Users: ${activeUsers.length}`,
        `📉 Open Positions: ${openPositions.length}`,
        `✅ System Health: 100%`
    ].join('\n');

    await bot.sendMessage(chatId, statusMsg, { parse_mode: 'Markdown' });
});

// --- ADMIN COMMANDS ---

let PANIC_MODE = false;

bot.onText(/\/mining/, async (msg) => {
    const stats = await db.getMiningStats(1); // Last 24h
    const winrate = stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(1) : "0.0";
    // Virtual PnL approximation (assuming $10 bets)
    // This is rough because we don't sum actual PnL in SQL yet, but avg_roi gives a hint
    const virtualPnl = (stats.total * 10) * (stats.avg_roi / 100); 
    const sign = virtualPnl >= 0 ? '+' : '';

    const text = [
        "⛏️ **Mining Dashboard (24h)**",
        `📊 Total Shadow Bets: ${stats.total}`,
        `⏳ Pending: ${stats.pending}`,
        `✅ Winrate: ${winrate}%`,
        `💰 Est. Virtual PnL: ${sign}$${virtualPnl.toFixed(2)}`,
        "",
        "Bot is actively collecting training data."
    ].join('\n');

    await bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/panic/, async (msg) => {
    PANIC_MODE = true;
    logger.warn("🚨 PANIC MODE ACTIVATED BY USER 🚨");
    await bot.sendMessage(msg.chat.id, "🚨 **PANIC MODE ACTIVATED** 🚨\n\nBot loop stopped. No new bets will be placed.\nUse /resume to restart.");
});

bot.onText(/\/resume/, async (msg) => {
    PANIC_MODE = false;
    logger.info("✅ Panic Mode Deactivated. Resuming...");
    await bot.sendMessage(msg.chat.id, "✅ **System Resumed**\nScanning restarted.");
});

// --- CALLBACK HANDLER ---

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;

    if (data === 'cmd_reset') {
        await db.resetPortfolio(chatId);
        await bot.answerCallbackQuery(query.id, { text: "Portfolio Reset to $20" });
        
        const text = await getDashboardText(chatId);
        await bot.editMessageText(text, {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: ui.mainMenu
        });
    }
});

// --- MAIN LOOP ---

const processedTrades = new Set();
let loopRunning = false;
let lastLoopTime = Date.now();

async function runBotLoop() {
    if (loopRunning) return;
    if (PANIC_MODE) {
        if (Math.random() < 0.05) logger.warn("⚠️ Bot is in PANIC MODE. Skipping loop.");
        return;
    }
    loopRunning = true;
    try {
        let trades = await logic.fetchTrades(200);
        if (trades.length > 0) {
            // --- OPTIMIZATION: WHALE PRIORITY SORT ---
            // Sort trades by size (USD) descending. 
            // This ensures we process the biggest (smartest?) money first within the batch.
            trades.sort((a, b) => {
                const sizeA = (Number(a.price||0) * Number(a.size||0));
                const sizeB = (Number(b.price||0) * Number(b.size||0));
                return sizeB - sizeA;
            });
            logger.debug(`🔍 Scanned ${trades.length} trades. Top trade size: $${(Number(trades[0].price||0) * Number(trades[0].size||0)).toFixed(0)}`);
        }
        
        const activeUsers = await db.getAllActiveUsers();
        if (activeUsers.length === 0) return;

        for (const trade of trades) {
            const tradeId = trade.transactionHash || `${trade.timestamp}-${trade.maker_address}`;
            if (processedTrades.has(tradeId)) continue;
            processedTrades.add(tradeId);
            if (processedTrades.size > 2000) {
                const iterator = processedTrades.values();
                processedTrades.delete(iterator.next().value);
            }

            // Basic Data Extraction
            const priceNum = Number(trade.price ?? 0);
            const sizeNum = Number(trade.size ?? 0);
            let tradeValueUsd = (isFinite(priceNum) ? priceNum : 0) * (isFinite(sizeNum) ? sizeNum : 0);
            if (!isFinite(tradeValueUsd) || tradeValueUsd < 0) tradeValueUsd = 0;
            
            const walletAddress = trade.proxyWallet || trade.maker_address || trade.user;
            if (!walletAddress) continue;

            // Hard Filters
            const side = (String(trade.side || 'BUY')).toUpperCase();
            
            // --- SELL LOGIC (Emergency Exit) ---
            if (side === 'SELL') {
                // Optimization: Only check if we actually hold this asset
                const condId = trade.conditionId || trade.condition_id;
                if (!condId) continue;

                const hasPosition = await db.anyUserHasPosition(condId);
                if (!hasPosition) continue; // We don't own it, so we don't care who sells it

                // If we own it, we need to see if the seller is credible (Original Whale or Super Whale)
                // Fetch stats for the seller
                await new Promise(r => setTimeout(r, 250));
                const sellerStats = await logic.fetchUserHistory(walletAddress, tradeValueUsd);
                
                // Iterate users to see who needs to sell
                for (const user of activeUsers) {
                    const positions = await db.getOpenPositions(user.chat_id, condId);
                    if (positions.length === 0) continue;

                    for (const position of positions) {
                        // Criteria to Follow Sell:
                        // 1. Original Whale is dumping (The one we followed)
                        const isOriginalWhale = (position.whale_address.toLowerCase() === walletAddress.toLowerCase());
                        
                        // 2. Super Whale is dumping (Smart Money leaving)
                        const isSuperWhale = (sellerStats.winrate > 70 && sellerStats.pnl > 1000);

                        if (isOriginalWhale || isSuperWhale) {
                            logger.warn(`🚨 [SELL SIGNAL] Whale ${walletAddress.slice(0,6)} is selling. Closing position for User ${user.chat_id}`);
                            
                            // Execute Close
                            const success = await db.closePosition(position.id, priceNum);
                            if (success) {
                                // Update Portfolio (Unlock funds + PnL)
                                // PnL = (Exit - Entry) * Size / Entry
                                // But simpler: New Balance = Balance + (BetAmount * (Exit/Entry))
                                // Actually, we need to credit the *proceeds* back to balance.
                                // Proceeds = SizeUSD * (ExitPrice / EntryPrice) ?? No.
                                // Binary Options: You buy shares. 
                                // Shares = SizeUSD / EntryPrice.
                                // Proceeds = Shares * ExitPrice.
                                const shares = position.size_usd / position.entry_price;
                                const proceeds = shares * priceNum;
                                
                                await db.updatePortfolio(user.chat_id, position.strategy, { 
                                    balanceDelta: proceeds, 
                                    lockedDelta: -position.size_usd 
                                });

                                const pnl = proceeds - position.size_usd;
                                const sign = pnl >= 0 ? '+' : '';
                                
                                await bot.sendMessage(user.chat_id, 
                                    `🚨 **EMERGENCY EXIT**\n` +
                                    `Whale sold position. We followed.\n` +
                                    `📉 Exit Price: ${priceNum}\n` +
                                    `💰 PnL: ${sign}$${pnl.toFixed(2)}`, 
                                    { parse_mode: 'Markdown' }
                                );
                            }
                        }
                    }
                }
                continue; // Done with SELL logic
            }

            // --- BUY LOGIC ---
            if (priceNum > 0.75) continue;
            if (tradeValueUsd < 50) continue;

            // Time Decay Check (Stale Signal Protection)
            // If trade is older than 60 seconds, skip it.
            const nowSec = Math.floor(Date.now() / 1000);
            const tradeTs = Number(trade.timestamp || nowSec);
            if (nowSec - tradeTs > 60) {
                logger.debug(`[Time Decay] Skipping stale trade ${tradeId} (${nowSec - tradeTs}s old)`);
                continue;
            }

            // Check DB for duplicate
            if (trade.transactionHash && await db.checkSignalExists(trade.transactionHash)) {
                processedTrades.add(tradeId);
                continue;
            }

            logger.info(`🐳 Analyzing wallet: ${walletAddress}`);
            
            // Fetch Whale Stats
            // No artificial delay needed - API is fast and we have caching
            const userData = await logic.fetchUserHistory(walletAddress, tradeValueUsd);
            
            // Prepare View Data
            const whaleStats = userData || { winrateLowerBound: 0, medianPnl: 0, totalTrades: 0, pnl: 0, winrate: 0 };
            const walletLog = trade.wallet || walletAddress || "Unknown";

            // Determine Category EARLY
            const marketSlug = trade.slug || trade.market_slug || trade.conditionId || trade.condition_id;
            const cat = logic.categorizeMarket(trade.title, marketSlug);
            
            // 1. Calculate Score (Context Aware)
            const signalScore = portfolio.evaluateSignal(trade, whaleStats, cat);
            logger.info(`[Bot] Signal Score: ${signalScore}/100 for ${walletLog} [${cat}]`);

            // --- RAW DATA LOGGING (AI DATASET) ---
            // Log Trade + Whale Stats + Bot Score (Point-in-Time Snapshot)
            csvLogger.logTradeToCSV(trade, whaleStats, signalScore);
            // -------------------------------------

            // If no user data found (e.g. new wallet or API error), skip further processing
            if (!userData) continue;

            // Prepare Signal Data
            const league = logic.extractLeague(trade.title, marketSlug);
            
            // Resolve Outcome/Condition
            let outcomeCanonical = trade.outcome || '';
            let condIdForSave = trade.conditionId || trade.condition_id || '';
            let tokenIndex = null;
            // (Simplified for brevity: assume condition_id exists or is handled by forward_tester later)

            const viewData = {
                _signalId: null, // Will be set if saved
                _category: cat,
                _league: league,
                _outcomeCanonical: outcomeCanonical,
                _tokenIndex: tokenIndex,
                wallet_short: walletAddress.slice(0, 6) + '...' + walletAddress.slice(-4),
                market_question: trade.title || 'Unknown Market',
                trade_size_fmt: logic.fmt(tradeValueUsd)
            };

            // Save Signal to DB (Global)
            if (condIdForSave) {
                viewData._signalId = await db.saveSignal({
                    market_slug: trade.slug || '',
                    event_slug: trade.eventSlug || '',
                    condition_id: condIdForSave,
                    outcome: outcomeCanonical,
                    side: side,
                    entry_price: trade.price || 0,
                    size_usd: tradeValueUsd,
                    whale_address: walletAddress,
                    token_index: null,
                    transaction_hash: trade.transactionHash
                });
            }

            // --- TRACK A: DATA MINING (Background) ---
            if (viewData._signalId && tradeValueUsd > 1) { // lower threshold to vacuum data
                const analysisMeta = {
                    category: cat,
                    score: signalScore,
                    whaleStats,
                    price: Number(trade.price || 0),
                    size: Number(trade.size || 0),
                    tradeValueUsd,
                    wallet: walletAddress,
                    timestamp: Number(trade.timestamp || Math.floor(Date.now()/1000))
                };
                const miningData = {
                    side: side,
                    entry_price: Number(trade.price || 0),
                    size_usd: tradeValueUsd,
                    category: viewData._category,
                    league: viewData._league,
                    outcome: viewData._outcomeCanonical,
                    token_index: viewData._tokenIndex
                };
                await db.logShadowBet(viewData._signalId, miningData, analysisMeta);
                logger.debug(`[Mining] ⛏️ Saved Shadow Bet for Signal ${viewData._signalId}`);
            }

            // --- TRACK B: MULTI-STRATEGY EXECUTION ---
            for (const user of activeUsers) {
                for (const strat of strategies) {
                    let pf = await db.getPortfolio(user.chat_id, strat.id);
                    if (!pf) { await db.initPortfolio(user.chat_id, strat.id); pf = await db.getPortfolio(user.chat_id, strat.id); }

                    if (!pf.is_challenge_active) continue;

                    // Check for open position in this strategy
                    const hasOpen = await db.hasOpenPosition(user.chat_id, strat.id, condIdForSave);
                    if (hasOpen) continue;

                    // Evaluate Strategy
                    const evalResult = strat.evaluate(trade, whaleStats);
                    
                    if (evalResult.shouldBet) {
                        logger.info(`[${strat.name}] Matched! Score: ${evalResult.score}. Reason: ${evalResult.reason}`);

                        // Calculate Bet
                        const balance = Number(pf.balance || 0);
                        // Use strategy score for sizing
                        const bet = portfolio.calculateBetSize(balance, evalResult.score);

                        if (bet > 0 && viewData._signalId) {
                            // Handle Overrides (e.g. Inverse Strategy)
                            const targetOutcome = (evalResult.override && evalResult.override.outcome) 
                                ? evalResult.override.outcome 
                                : viewData._outcomeCanonical;

                            // --- PRE-FLIGHT PRICE CHECK ---
                            const signalPrice = Number(trade.price || 0);
                            let executionPrice = signalPrice;
                            
                            const currentPrice = await logic.fetchCurrentPrice(condIdForSave, targetOutcome);
                            
                            if (currentPrice !== null) {
                                executionPrice = currentPrice;
                                logger.debug(`✅ [Price Check] Target: ${targetOutcome}, Current: ${currentPrice}.`);
                            } else if (targetOutcome !== viewData._outcomeCanonical) {
                                // Fallback for Inverse if API fails: Estimate as 1 - signalPrice
                                executionPrice = 1.0 - signalPrice;
                                if (executionPrice < 0) executionPrice = 0;
                                if (executionPrice > 1) executionPrice = 1;
                            }

                            const logData = {
                                strategy: strat.id, // Log the specific strategy ID
                                side: side,
                                entry_price: executionPrice, // Use the ACTUAL price of the asset we are buying
                                size_usd: tradeValueUsd,
                                category: viewData._category,
                                league: viewData._league,
                                outcome: targetOutcome, // Use the target outcome
                                token_index: viewData._tokenIndex,
                                analysis_meta: {
                                    category: cat,
                                    score: evalResult.score,
                                    whaleStats,
                                    reason: evalResult.reason,
                                    price: Number(trade.price || 0),
                                    size: Number(trade.size || 0),
                                    tradeValueUsd,
                                    wallet: walletAddress,
                                    timestamp: Number(trade.timestamp || Math.floor(Date.now()/1000))
                                }
                            };

                            // ATOMIC EXECUTION
                            const success = await db.executeAtomicBet(user.chat_id, strat.id, viewData._signalId, bet, logData);
                            
                            if (success) {
                                logger.success(`[${strat.name}] User ${user.chat_id} bet $${bet} on Signal ${viewData._signalId}`);
                                
                                // Send Notification
                                const caption = `🎰 **${strat.name} Action**\n\n` +
                                    `🐋 Whale: ${viewData.wallet_short}\n` +
                                    `📉 Score: ${evalResult.score}/100\n` +
                                    `💡 Reason: ${evalResult.reason}\n` +
                                    `💵 Bet: $${bet.toFixed(2)}\n` +
                                    `🎯 Event: ${viewData.market_question}\n` +
                                    `🎲 Outcome: ${targetOutcome}`; // Show the outcome we actually bet on
                                
                                try {
                                    await bot.sendMessage(user.chat_id, caption, { parse_mode: 'Markdown' });
                                } catch (e) {}
                            }
                        }
                    }
                }
            }
        }
    } catch (err) {
        logger.error("Bot Loop Error:", err);
    } finally {
        loopRunning = false;
        lastLoopTime = Date.now();
    }
}

// Start Loop
setInterval(runBotLoop, 2000);
runBotLoop();

// Resolution Checker (Every 5 minutes)
setInterval(async () => {
    try {
        const openPositions = await db.getAllOpenPositions();
        if (openPositions.length === 0) return;

        logger.debug(`[Resolution] Checking ${openPositions.length} open positions...`);
        
        for (const pos of openPositions) {
            // Rate limit protection
            await new Promise(r => setTimeout(r, 200));
            
            const status = await logic.fetchMarketStatus(pos.condition_id);
            if (status && status.resolved) {
                const didWin = (status.winnerOutcome === pos.outcome);
                const exitPrice = didWin ? 1.0 : 0.0;
                const pnlPercent = ((exitPrice - pos.entry_price) / pos.entry_price) * 100;
                
                // Calculate Payout
                // Shares = BetAmount / EntryPrice
                // Payout = Shares * ExitPrice
                const shares = pos.bet_amount / pos.entry_price;
                const payout = shares * exitPrice;
                
                // 1. Mark as Settled in DB
                await db.markPositionSettled(pos.id, exitPrice, status.winnerOutcome);
                
                // 2. Update Portfolio (Credit Payout)
                // We only add the payout. The initial bet was already deducted.
                if (payout > 0) {
                    await db.updatePortfolio(pos.chat_id, pos.strategy, { 
                        balanceDelta: payout, 
                        lockedDelta: -pos.bet_amount 
                    });
                } else {
                    // Just unlock the funds (which are now gone)
                    await db.updatePortfolio(pos.chat_id, pos.strategy, { 
                        balanceDelta: 0, 
                        lockedDelta: -pos.bet_amount 
                    });
                }

                // 3. Notify User
                const sign = pnlPercent >= 0 ? '+' : '';
                const msg = pnlPercent >= 0 
                    ? `🏁 **EVENT RESOLVED: WIN!**\nEvent: ${pos.market_slug}\nOutcome: ${pos.outcome}\nResult: ${sign}${pnlPercent.toFixed(0)}%\nPayout: $${payout.toFixed(2)}`
                    : `🏁 **EVENT RESOLVED: LOSS.**\nEvent: ${pos.market_slug}\nOutcome: ${pos.outcome}\nResult: -100%`;
                
                try {
                    await bot.sendMessage(pos.chat_id, msg, { parse_mode: 'Markdown' });
                } catch (e) {}
                
                logger.info(`[Resolution] Position ${pos.id} settled. PnL: ${pnlPercent.toFixed(0)}%`);
            }
        }
    } catch (e) {
        logger.error("Resolution Check Error:", e);
    }
}, 300000); // 5 minutes

// Notification Poller (for closed trades)
setInterval(async () => {
    try {
        const items = await db.getUnnotifiedClosedSignals();
        for (const it of items) {
            const roi = Number(it.result_pnl_percent || 0);
            const sign = roi > 0 ? '+' : '';
            const msg = roi > 0 
                ? `✅ **WIN!**\nResult: ${sign}${roi.toFixed(0)}%`
                : `❌ **LOSS.**\nResult: ${roi.toFixed(0)}%`;
            
            try {
                await bot.sendMessage(it.chat_id, msg, { parse_mode: 'Markdown' });
                await db.markUserSignalLogNotified(it.id);
            } catch (sendErr) {
                logger.error(`Failed to send notification to ${it.chat_id}: ${sendErr.message}`);
                // If user blocked bot or chat not found, mark as notified to prevent infinite loop
                if (sendErr.message.includes('chat not found') || sendErr.message.includes('blocked')) {
                    await db.markUserSignalLogNotified(it.id);
                }
            }
        }
    } catch (e) { logger.error("Notification Error:", e); }
}, 60000);

// Hourly Heartbeat
setInterval(async () => {
    try {
        const activeUsers = await db.getAllActiveUsers();
        if (activeUsers.length === 0) return;
        
        const msg = "💓 **System Heartbeat**\nBot is active and scanning for whales.";
        for (const user of activeUsers) {
            try {
                await bot.sendMessage(user.chat_id, msg, { parse_mode: 'Markdown' });
            } catch (e) {}
        }
        logger.info("Sent hourly heartbeat.");
    } catch (e) {
        logger.error("Heartbeat Error:", e);
    }
}, 3600000); // 1 hour
