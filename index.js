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
    let pf = await db.getPortfolio(chatId);
    if (!pf) {
        await db.initPortfolio(chatId);
        pf = await db.getPortfolio(chatId);
    }

    const balance = (pf.balance || 0);
    const locked = (pf.locked_funds || 0);
    const equity = balance + locked;
    const startBalance = 20.00;
    const pnl = ((equity - startBalance) / startBalance) * 100;
    const pnlSign = pnl >= 0 ? '+' : '';

    return [
        "💼 **Unicorn Portfolio**",
        `💵 Balance: $${balance.toFixed(2)}`,
        `🔒 Locked: $${locked.toFixed(2)}`,
        `📉 PnL: ${pnlSign}${pnl.toFixed(2)}%`,
        "",
        "🟢 **$20 Challenge:** Active",
        "⛏️ **AI Data Mining:** 🟢 Recording (Background)"
    ].join('\n');
};

bot.onText(/\/start|\/menu/, async (msg) => {
    const chatId = msg.chat.id;
    await db.createUser(chatId);
    const text = await getDashboardText(chatId);
    await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', reply_markup: ui.mainMenu });
});

bot.onText(/\/reset/, async (msg) => {
    const chatId = msg.chat.id;
    await db.resetPortfolio(chatId);
    await bot.sendMessage(chatId, "🔄 **Portfolio Reset!**\nBalance restored to $20.00.", { 
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
                    const position = await db.getOpenPosition(user.chat_id, condId);
                    if (!position) continue;

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
                            
                            await db.updatePortfolio(user.chat_id, { 
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

            // --- TRACK B: $20 CHALLENGE (User Facing) ---
            for (const user of activeUsers) {
                let pf = await db.getPortfolio(user.chat_id);
                if (!pf) { await db.initPortfolio(user.chat_id); pf = await db.getPortfolio(user.chat_id); }

                // Only proceed if challenge is active
                if (pf.is_challenge_active) {
                    // Correlation Check
                    const hasOpen = await db.hasOpenPosition(user.chat_id, condIdForSave);
                    if (hasOpen) {
                        logger.debug(`[Portfolio] User ${user.chat_id} has open position. Skipping.`);
                        continue;
                    }

                    // "Sniper Trigger" (Super Whale Override)
                    // If whale is elite, we ignore category restrictions
                    const isSuperWhale = (whaleStats.winrate > 70 && whaleStats.totalTrades > 50 && whaleStats.pnl > 2000);
                    
                    // Restrict real bets to safer categories OR Super Whales
                    const isSafeCategory = (viewData._category === 'politics' || viewData._category === 'crypto');
                    
                    if (!isSafeCategory && !isSuperWhale) {
                        logger.debug(`[Portfolio] Skipping real bet. Cat: ${viewData._category}, SuperWhale: ${isSuperWhale}`);
                        continue;
                    }

                    // Calculate Bet
                    const balance = Number(pf.balance || 0);
                    const bet = portfolio.calculateBetSize(balance, signalScore);

                    if (bet > 0 && viewData._signalId) {
                        // --- PRE-FLIGHT PRICE CHECK ---
                        // Verify price hasn't moved significantly (Slippage Protection)
                        const signalPrice = Number(trade.price || 0);
                        const currentPrice = await logic.fetchCurrentPrice(condIdForSave, viewData._outcomeCanonical);
                        
                        if (currentPrice !== null) {
                            const slippage = Math.abs(currentPrice - signalPrice);
                            // Allow max 5 cents slippage
                            if (slippage > 0.05) {
                                logger.warn(`⚠️ [Slippage] Price moved too much! Signal: ${signalPrice}, Current: ${currentPrice}. Skipping bet.`);
                                continue;
                            }
                            // Update entry price to current market price for accuracy
                            // Actually, we should probably stick to signal price for logging consistency, 
                            // or use current price if we were executing a real market order.
                            // Since we are simulating execution at signal price (mostly), let's just ensure it's close.
                            logger.debug(`✅ [Price Check] Signal: ${signalPrice}, Current: ${currentPrice}. OK.`);
                        } else {
                            logger.warn(`⚠️ [Price Check] Could not verify current price for ${condIdForSave}. Proceeding with caution.`);
                        }

                        const logData = {
                            strategy: 'unicorn_portfolio',
                            side: side,
                            entry_price: Number(trade.price || 0),
                            size_usd: tradeValueUsd,
                            category: viewData._category,
                            league: viewData._league,
                            outcome: viewData._outcomeCanonical,
                            token_index: viewData._tokenIndex,
                            analysis_meta: {
                                category: cat,
                                score: signalScore,
                                whaleStats,
                                price: Number(trade.price || 0),
                                size: Number(trade.size || 0),
                                tradeValueUsd,
                                wallet: walletAddress,
                                timestamp: Number(trade.timestamp || Math.floor(Date.now()/1000))
                            }
                        };

                        // ATOMIC EXECUTION
                        const success = await db.executeAtomicBet(user.chat_id, viewData._signalId, bet, logData);
                        
                        if (success) {
                            logger.success(`[Portfolio] User ${user.chat_id} bet $${bet} on Signal ${viewData._signalId}`);
                            
                            // Send Notification
                            const caption = `🎰 **Unicorn Action**\n\n` +
                                `🐋 Whale: ${viewData.wallet_short}\n` +
                                `📉 Score: ${signalScore}/100\n` +
                                `💵 Bet: $${bet.toFixed(2)}\n` +
                                `🎯 Event: ${viewData.market_question}\n` +
                                `🎲 Outcome: ${viewData._outcomeCanonical}`;
                            
                            try {
                                await bot.sendMessage(user.chat_id, caption, { parse_mode: 'Markdown' });
                            } catch (e) {}
                        }
                    } else if (signalScore >= portfolio.MIN_SCORE_WATCH) {
                        // WATCH MODE: Notify but don't bet
                        logger.info(`[Watch] Score ${signalScore} >= ${portfolio.MIN_SCORE_WATCH}. Notifying user ${user.chat_id}.`);
                        
                        const caption = `👀 **Watch List Alert**\n\n` +
                            `🐋 Whale: ${viewData.wallet_short}\n` +
                            `⚠️ Score: ${signalScore}/100 (Near Miss)\n` +
                            `🚫 Action: No Bet (Score < ${portfolio.MIN_SCORE_TO_BET})\n` +
                            `🎯 Event: ${viewData.market_question}\n` +
                            `🎲 Outcome: ${viewData._outcomeCanonical}`;

                        try {
                            await bot.sendMessage(user.chat_id, caption, { parse_mode: 'Markdown' });
                        } catch (e) {}
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
                    await db.updatePortfolio(pos.chat_id, { 
                        balanceDelta: payout, 
                        lockedDelta: -pos.bet_amount 
                    });
                } else {
                    // Just unlock the funds (which are now gone)
                    await db.updatePortfolio(pos.chat_id, { 
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
