require('dotenv').config();
process.env.NTBA_FIX_350 = process.env.NTBA_FIX_350 || '1';
const TelegramBot = require('node-telegram-bot-api');
const axios = require('axios');
const db = require('./database');
const ui = require('./keyboards');
const logic = require('./whale_logic');
const forwardTester = require('./forward_tester');
const math = require('./math_utils');
const fs = require('fs');
const path = require('path');

process.on('unhandledRejection', (reason) => {
    try { console.error('unhandledRejection', reason); } catch (_) {}
});
process.on('uncaughtException', (err) => {
    try { console.error('uncaughtException', err && err.stack || err); } catch (_) {}
});

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN || 'YOUR_TELEGRAM_TOKEN';

const bot = new TelegramBot(TELEGRAM_TOKEN, { polling: { interval: 300, params: { timeout: 10 } } });
db.initDb();
bot.on('polling_error', (err) => { try { console.error("polling_error", err.message); } catch (_) {} });

// Heartbeat + Bankruptcy alert state
let lastScanTs = 0;
const lowBalanceAlertSent = {};

bot.setMyCommands([
    { command: '/start', description: '▶️ Запустить' },
    { command: '/menu', description: '📱 Главное меню' },
    { command: '/settings', description: '⚙️ Настройки' },
    { command: '/stop', description: '⏸ Остановить' },
    { command: '/stats', description: '📊 Статистика' },
    { command: '/challenge_start', description: '💎 Challenge Mode' },
    { command: '/portfolio', description: '💰 Портфель' },
    { command: '/challenge_stats', description: '📈 Статистика челленджа' },
    { command: '/help', description: '❓ Помощь' },
    { command: '/faq', description: '📚 FAQ' },
    { command: '/guide', description: '📘 Гайд' },
    { command: '/report', description: '📈 Отчёт' },
    { command: '/feedback', description: '💬 Обратная связь' }
]);

console.log("🐳 Whale Bot v3.0 (Commercial Grade) Started...");
forwardTester.startService();

const userStates = {};

const HISTORY_DIR = path.resolve(__dirname, 'data', 'history');
fs.mkdirSync(HISTORY_DIR, { recursive: true });
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
const TG_MIN_INTERVAL_MS = 50;
let lastTgSendTs = 0;

function escapeMarkdown(text) {
    // Telegram parse_mode: 'Markdown' (v1) escaping
    return String(text ?? '').replace(/([_*\[\]\(\)`])/g, '\\$1');
}
async function safeSendPhoto(chatId, imageBuffer, options) {
    const now = Date.now();
    const wait = Math.max(0, TG_MIN_INTERVAL_MS - (now - lastTgSendTs));
    if (wait > 0) await sleep(wait);
    lastTgSendTs = Date.now();
    try {
        return await bot.sendPhoto(chatId, imageBuffer, options, { filename: 'card.png', contentType: 'image/png' });
    } catch (err) {
        const msg = String(err && err.message || '');
        const is429 = msg.toLowerCase().includes('too many requests') || (err.response && err.response.status === 429);
        if (is429) {
            let waitMs = 1500;
            try {
                const b = err.response && err.response.body || '';
                if (b && typeof b === 'string') {
                    const m = b.match(/retry_after\":\s*(\d+)/i);
                    if (m) waitMs = Number(m[1]) * 1000;
                }
                const m2 = msg.match(/retry after (\d+)/i);
                if (m2) waitMs = Number(m2[1]) * 1000;
            } catch (_) {}
            await sleep(waitMs);
            return await bot.sendPhoto(chatId, imageBuffer, options, { filename: 'card.png', contentType: 'image/png' });
        }
        throw err;
    }
}
async function logTradeToHistory(trade, tradeValueUsd) {
    const dateStr = new Date().toISOString().slice(0, 10);
    const filePath = path.join(HISTORY_DIR, `trades_${dateStr}.csv`);
    const exists = fs.existsSync(filePath);
    if (!exists) {
        await fs.promises.writeFile(filePath, 'timestamp,transactionHash,maker_address,market_slug,outcome,side,price,size,volume_usd,market_title\n');
    }
    const ts = trade.timestamp ? Math.floor(Number(trade.timestamp)) : (trade.created_at ? Math.floor(new Date(trade.created_at).getTime() / 1000) : Math.floor(Date.now() / 1000));
    const hash = String(trade.transactionHash || '');
    const maker = String(trade.maker_address || trade.proxyWallet || trade.user || '');
    const slug = String(trade.slug || trade.market_slug || '');
    const outcome = String(trade.outcome || '');
    const side = String((trade.side || '').toUpperCase());
    const price = Number(trade.price || 0);
    const size = Number(trade.size || 0);
    const volume = Number(tradeValueUsd || 0);
    const title = String(trade.title || '').replace(/[\r\n]+/g, ' ').replace(/,/g, '.');
    const line = [ts, hash, maker, slug, outcome, side, price, size, volume, title].join(',');
    await fs.promises.appendFile(filePath, line + '\n');
}

async function pollClosedNotifications() {
    try {
        const items = await db.getUnnotifiedClosedSignals();
        if (!items || items.length === 0) return;
        for (const it of items) {
            const chatId = it.chat_id;
            const status = it.status || 'CLOSED';
            const roi = Number(it.result_pnl_percent || 0);
            const sign = roi > 0 ? '+' : '';
            const resolved = escapeMarkdown(it.resolved_outcome || it.outcome || '');
            // Compute payout if bet was placed
            let msg = '';
            // Fetch bet_amount for this user log
            let bet = 0;
            try {
                const logs = await db.getUserLogsBySignalId(it.signal_id);
                const row = (logs || []).find(r => r.chat_id === chatId);
                if (row && row.bet_amount) bet = Number(row.bet_amount || 0);
            } catch (_) {}
            
            // Handle VOID/REFUND separately
            if (status === 'CLOSED_VOID' || resolved === 'VOID') {
                if (bet > 0) {
                    try {
                        const pf = await db.getPortfolio(chatId);
                        const balance = pf ? Number(pf.balance || 0).toFixed(2) : '—';
                        msg = `♻️ **Market Voided/Refunded**\nРынок: ${escapeMarkdown(it.outcome || '—')}\n🏁 Stake returned to balance: $${bet.toFixed(2)}\n💰 New Balance: $${balance}`;
                    } catch (_) {
                        msg = `♻️ **Market Voided/Refunded**\nРынок: ${escapeMarkdown(it.outcome || '—')}\nВаша ставка возвращена.`;
                    }
                } else {
                    msg = `♻️ **Market Voided/Refunded**\nРынок: ${escapeMarkdown(it.outcome || '—')}\nРезультат: Ничья/Отмена.`;
                }
            } else if (bet > 0) {
                const payoutFactor = Math.max(0, 1 + (roi / 100));
                const payout = Math.round(bet * payoutFactor * 100) / 100;
                try {
                    // Portfolio already updated by forward_tester - just read current balance
                    const pf = await db.getPortfolio(chatId);
                    const balance = pf ? Number(pf.balance || 0).toFixed(2) : '—';
                    msg = roi > 0
                        ? `✅ **WIN!**\nРынок: ${resolved}\nРезультат: ${sign}${roi.toFixed(0)}%\n🏁 Trade Closed. Payout: $${payout.toFixed(2)}\n💰 New Balance: $${balance}`
                        : `❌ **LOSS.**\nРынок: ${resolved}\nРезультат: ${roi.toFixed(0)}%\n🏁 Trade Closed. Payout: $0.00\n💰 New Balance: $${balance}`;
                } catch (_) {
                    msg = roi > 0
                        ? `✅ **WIN!** Сигнал закрыт в плюс.\nРынок: ${resolved}\nВаш результат: ${sign}${roi.toFixed(0)}%`
                        : `❌ **LOSS.** Рынок закрыт.\nРезультат: ${roi.toFixed(0)}% (С учетом комиссий)`;
                }
            } else {
                msg = roi > 0
                    ? `✅ **WIN!** Сигнал закрыт в плюс.\nРынок: ${resolved}\nВаш результат: ${sign}${roi.toFixed(0)}%`
                    : `❌ **LOSS.** Рынок закрыт.\nРезультат: ${roi.toFixed(0)}% (С учетом комиссий)`;
            }
            try {
                await bot.sendMessage(chatId, msg, { parse_mode: 'Markdown' });
            } catch (_) {}
            try {
                await db.markUserSignalLogNotified(it.id);
            } catch (_) {}
        }
    } catch (_) {}
}

setInterval(pollClosedNotifications, 60000);
bot.onText(/\/start/, async (msg) => {
    const chatId = msg.chat.id;
    await db.createUser(chatId);
    const welcome = [
        "� Добро пожаловать в Whale Tracker Bot!",
        "",
        "🔍 Мы анализируем крупные сделки на Polymarket, проверяем историю кошельков и отбираем только проверенных китов.",
        "",
        "🎯 Что внутри:",
        "• Честные метрики: PnL, винрейт, объём, сделки",
        "• Гибкие фильтры: сумма, категория, тип кита, винрейт",
        "• Paper trading: реалистичные расчёты (0.01% комиссия)",
        "• Авто-проверка результатов каждые 10 мин",
        "",
        "🚀 Быстрый старт:",
        "1) /guide — выберите пресет риска",
        "2) /settings — тонкая настройка фильтров",
        "3) Нажмите «▶️ Запустить»",
        "",
        "📊 Аналитика:",
        "• /stats — общая статистика paper trading",
        "• /report — подробный анализ по китам и категориям",
        "• /status — состояние системы",
        "",
        "💬 Помощь: /help /faq /feedback"
    ].join('\n');
    bot.sendMessage(chatId, welcome, {
        reply_markup: ui.mainMenu
    });
});

bot.onText(/\/menu/, async (msg) => {
    bot.sendMessage(msg.chat.id, "👋 Главное меню", { reply_markup: ui.mainMenu, parse_mode: 'Markdown' });
});

bot.onText(/\/settings/, async (msg) => {
    const user = await db.getUser(msg.chat.id);
    bot.sendMessage(msg.chat.id, "⚙️ Настройки Фильтров", { reply_markup: ui.settingsMenu(user), parse_mode: 'Markdown' });
});

bot.onText(/\/stop/, async (msg) => {
    await db.updateUser(msg.chat.id, { active: 0 });
    bot.sendMessage(msg.chat.id, "⏸ Уведомления остановлены.\nВключить снова: /start", { reply_markup: ui.mainMenu });
});

bot.onText(/\/stats/, async (msg) => {
    const chatId = msg.chat.id;
    const DAYS = Number(process.env.STATS_WINDOW_DAYS || 30);
    const roiMode = (process.env.ROI_MODE || 'realistic').toLowerCase();
    const modeLabel = roiMode === 'conservative' ? '⚠️ Консервативный (стресс-тест)' : '✅ Реалистичный (0.01% комис.)';
    
    const stats = await db.getSignalStats(DAYS);
    const lines = [
        '📊 **Статистика Paper Trading**',
        '',
        `📅 Период: ${DAYS} дней`,
        `🔬 Режим расчёта: ${modeLabel}`,
        '',
        `✅ Закрыто сделок: ${stats.total}`,
        `🎯 Успешных: ${stats.wins} • Винрейт: ${stats.winrate.toFixed(1)}%`,
        `📈 Средний ROI: ${stats.avg_pnl_capped.toFixed(1)}% (кап ±1000%)`,
        `📊 Медианный ROI: ${stats.median_pnl.toFixed(1)}%`,
        ''
    ];
    
    if (stats.buy_count > 0 || stats.sell_count > 0) {
        lines.push('🔍 **По направлениям:**');
        if (stats.buy_count > 0) {
            lines.push(`   BUY: ${stats.buy_wins}/${stats.buy_count} • ${stats.buy_winrate.toFixed(1)}% винрейт`);
        }
        if (stats.sell_count > 0) {
            lines.push(`   SELL: ${stats.sell_wins}/${stats.sell_count} • ${stats.sell_winrate.toFixed(1)}% винрейт`);
        }
        lines.push('');
    }
    
    lines.push(`⏳ Ожидают закрытия: ${stats.pending}`);
    lines.push('');
    lines.push('_Обновляется автоматически каждые 10 минут._');
    lines.push('_Подробная аналитика: /report_');
    
    bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
});

// Challenge Mode commands
bot.onText(/\/challenge_start/, async (msg) => {
    const chatId = msg.chat.id;
    await db.createUser(chatId);
    // Reset portfolio and activate challenge
    try {
        await db.initPortfolio(chatId);
        await db.updatePortfolio(chatId, { balanceDelta: 0, lockedDelta: 0, is_challenge_active: 1 });
        await db.updateUser(chatId, { strategy_name: 'challenge_20', active: 1 });
        await bot.sendMessage(chatId, "🟢 Challenge Started. Balance: $20.00", { parse_mode: 'Markdown', reply_markup: ui.mainMenu });
    } catch (e) {
        await bot.sendMessage(chatId, "⚠️ Не удалось инициализировать Challenge.", { parse_mode: 'Markdown', reply_markup: ui.mainMenu });
    }
});

bot.onText(/\/portfolio/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        let pf = await db.getPortfolio(chatId);
        if (!pf) { await db.initPortfolio(chatId); pf = await db.getPortfolio(chatId); }
        const balance = Number(pf.balance || 0).toFixed(2);
        const locked = Number(pf.locked || 0).toFixed(2);
        const equity = Number(pf.equity || (pf.balance + pf.locked) || 0).toFixed(2);
        await bot.sendMessage(chatId, `💰 Balance: $${balance} | 🔒 Locked: $${locked} | 📈 Equity: $${equity}`, { parse_mode: 'Markdown', reply_markup: ui.mainMenu });
    } catch (e) {
        await bot.sendMessage(chatId, "⚠️ Ошибка чтения портфеля.", { parse_mode: 'Markdown', reply_markup: ui.mainMenu });
    }
});

bot.onText(/\/challenge_stats/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const pf = await db.getPortfolio(chatId);
        if (!pf) {
            await bot.sendMessage(chatId, "⚠️ Challenge Mode не активирован. Используйте /challenge_start");
            return;
        }
        
        // Get all challenge trades
        const rows = await db.getChallengeTradesForUser(chatId);
        
        const balance = Number(pf.balance || 0);
        const locked = Number(pf.locked || 0);
        const equity = balance + locked;
        const startBalance = 20.0;
        const totalRoi = ((equity - startBalance) / startBalance) * 100;
        
        const closed = rows.filter(r => r.status === 'CLOSED' || r.status === 'CLOSED_VOID');
        const pending = rows.filter(r => r.status === 'OPEN');
        const wins = closed.filter(r => Number(r.result_pnl_percent || 0) > 0);
        const losses = closed.filter(r => Number(r.result_pnl_percent || 0) < 0);
        const voids = closed.filter(r => r.status === 'CLOSED_VOID');
        
        const winrate = closed.length > 0 ? (wins.length / closed.length * 100) : 0;
        
        // Best/Worst trades
        const sorted = closed.filter(r => r.status !== 'CLOSED_VOID').sort((a, b) => Number(b.result_pnl_percent || 0) - Number(a.result_pnl_percent || 0));
        const best = sorted[0];
        const worst = sorted[sorted.length - 1];
        
        const safeOutcome = (text) => escapeMarkdown(text || '—');
        
        const lines = [
            '💎 **Challenge Mode Stats**',
            '',
            `💰 **Portfolio:**`,
            `  • Balance: $${balance.toFixed(2)}`,
            `  • Locked: $${locked.toFixed(2)}`,
            `  • Equity: $${equity.toFixed(2)}`,
            `  • ROI: ${totalRoi > 0 ? '+' : ''}${totalRoi.toFixed(1)}% (с $${startBalance.toFixed(2)})`,
            '',
            `📊 **Performance:**`,
            `  • Закрыто: ${closed.length} (${wins.length}W / ${losses.length}L${voids.length > 0 ? ' / ' + voids.length + 'V' : ''})`,
            `  • Винрейт: ${winrate.toFixed(1)}%`,
            `  • Ожидают: ${pending.length}`,
            ''
        ];
        
        if (best) {
            const bestRoi = Number(best.result_pnl_percent || 0);
            const bestPayout = Number(best.bet_amount || 0) * (1 + bestRoi / 100);
            lines.push(`🏆 **Best Trade:** ${safeOutcome(best.outcome)}`);
            lines.push(`  • ROI: +${bestRoi.toFixed(0)}% ($${bestPayout.toFixed(2)} payout)`);
        }
        
        if (worst) {
            const worstRoi = Number(worst.result_pnl_percent || 0);
            lines.push(`💀 **Worst Trade:** ${safeOutcome(worst.outcome)}`);
            lines.push(`  • ROI: ${worstRoi.toFixed(0)}%`);
        }
        
        if (closed.length === 0) {
            lines.push('_Пока нет закрытых сделок._');
        }
        
        lines.push('');
        lines.push('_Только Smart Whales (строгий фильтр)_');
        lines.push('_Сайзинг: 10% от баланса, мин $1_');
        
        await bot.sendMessage(chatId, lines.join('\n'), { parse_mode: 'Markdown' });
    } catch (e) {
        console.error('Challenge stats error:', e);
        await bot.sendMessage(chatId, "⚠️ Ошибка загрузки статистики.", { parse_mode: 'Markdown' });
    }
});

bot.onText(/\/help/, async (msg) => {
    const text = [
        "❓ Помощь",
        "",
        "🐋 **Основные команды:**",
        "• «▶️ Запустить» — включает рассылку сигналов",
        "• /settings — настройка фильтров (мин. ставка, тип кита, категории)",
        "• /guide — готовые пресеты (Консервативный/Агрессивный)",
        "• «⏸ Остановить» — пауза уведомлений",
        "",
        "📊 **Аналитика:**",
        "• /stats — общая статистика paper trading",
        "• /report — детальный анализ по китам, категориям, стратегиям",
        "• /status — состояние системы (пендинг/закрыто, режим)",
        "",
        "🎯 **Фильтр события:**",
        "Нажмите «🎯 Событие» и введите часть названия или slug.",
        "Примеры: «trump», «bitcoin», «nfl-week-1»",
        "Чтобы очистить — «🧹 Очистить фильтр события».",
        "",
        "💬 /feedback — отправить отзыв или вопрос"
    ].join('\n');
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/faq/, async (msg) => {
    const text = [
        "📚 FAQ — частые вопросы",
        "",
        "🧹 **Что такое paper trading?**",
        "Мы не касаемся реальных активов. Все сделки — виртуальные, для полу тестирования стратегий китов.",
        "",
        "📈 **Режим расчёта (Realistic)**",
        "✓ Основной режим. Основан на реальных условиях Polymarket:",
        "• 0% комиссия (глобально)",
        "• 0.01% для тейкеров в сегменте USA",
        "• Минимальные спрэды и слиппейдж",
        "",
        "⚠️ **Консервативный режим** (стресс-тест)",
        "Опциональный. Используя ROI_MODE=conservative, мы подражаем худшим условиям (0.5% слиппейдж = 50x страховка). Полезно для очень консервативных трейдеров.",
        "",
        "🎉 **Очки в /stats:**",
        "• Винрейт: % успешных сигналов",
        "• Средний ROI: среднее по всем делам",
        "• Медианный ROI: середина (50% работают лучше, 50% — хуже)",
        "",
        "🐋 **Типы китов:**",
        "• Умный кит: винрейт > 40%, реальные прибыли",
        "• Кит: реальные прибыли, большие объёмы",
        "• Устойчиво теряют: негативные результаты",
        "",
        "📋 **Аналитика (/report):**",
        "Показывает лучшие стратегии, категории, китов и комбинации кит-категория за 30 дней.",
        "",
        "📦 **Уведомления о закрытии:**",
        "Когда рынок закрылся, ты получишь уведомление: WIN/LOSS и твой ROI %.",
        "",
        "💬 Это всё? Э ты можешь /feedback — отправь любой вопрос или отзыв."
    ].join('\n');
    bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
});

bot.onText(/\/status/, async (msg) => {
    try {
        const roiMode = (process.env.ROI_MODE || 'realistic').toLowerCase();
        const modeLabel = roiMode === 'conservative' ? '⚠️ Консервативный (стресс-тест)' : '✅ Реалистичный';
        const debugOn = process.env.FORWARD_DEBUG === '1';
        const batchLimit = Number(process.env.FORWARD_BATCH_LIMIT || '200');
        const checkInterval = 10; // minutes
        const secondsAgo = lastScanTs > 0 ? Math.max(0, Math.floor((Date.now() - lastScanTs) / 1000)) : null;
        const whalesCached = typeof logic.getWhaleCacheSize === 'function' ? logic.getWhaleCacheSize() : 0;
        
        // Get counts from DB
        const pending = await new Promise((resolve, reject) => {
            db.get(`SELECT COUNT(*) as cnt FROM user_signal_logs WHERE status = 'OPEN'`, [], (err, row) => {
                if (err) return reject(err);
                resolve(row ? row.cnt : 0);
            });
        });
        
        const closed = await new Promise((resolve, reject) => {
            db.get(`SELECT COUNT(*) as cnt FROM user_signal_logs WHERE status = 'CLOSED'`, [], (err, row) => {
                if (err) return reject(err);
                resolve(row ? row.cnt : 0);
            });
        });
        
        const errors = await new Promise((resolve, reject) => {
            db.get(`SELECT COUNT(*) as cnt FROM user_signal_logs WHERE status = 'ERROR'`, [], (err, row) => {
                if (err) return reject(err);
                resolve(row ? row.cnt : 0);
            });
        });
        
        const text = [
            '📋 **Состояние системы**',
            '',
            `📈 Режим расчёта: ${modeLabel}`,
            `📂 Закрыто: ${closed}`,
            `⏳ Ожидают: ${pending}`,
            `❌ Ошибки: ${errors}`,
            '',
            `⏱️ Last Scan: ${secondsAgo !== null ? secondsAgo + 's ago' : '—'}`,
            `🐳 Whales Cached: ${whalesCached}`,
            '',
            `🔍 Проверка рэзолюций каждые ${checkInterval} мин.`,
            `📅 Макс сигналов/прогон: ${batchLimit}`,
            `🔧 Логи дебага: ${debugOn ? '✅ ВКЛЮЧЕНЫ' : '⚠️ отключены'}`,
            '',
            '_Цифры обновляются каждые 10 мин._'
        ].join('\n');
        bot.sendMessage(msg.chat.id, text, { parse_mode: 'Markdown' });
    } catch (err) {
        bot.sendMessage(msg.chat.id, `❌ Ошибка: ${err.message}`);
    }
});

bot.onText(/\/feedback/, async (msg) => {
    const chatId = msg.chat.id;
    userStates[chatId] = 'waiting_feedback';
    bot.sendMessage(chatId, "✍️ Напишите ваше предложение или описание проблемы.\nМы ответим при необходимости.", { reply_markup: { force_reply: true, selective: true } });
});

bot.onText(/\/guide/, async (msg) => {
    const text = [
        "📘 Гайд: безопасные сценарии",
        "",
        "Консервативный:",
        "• Мин. ставка: $1000",
        "• Тип: Умные киты",
        "• Категория: Политика",
        "",
        "Сбалансированный:",
        "• Мин. ставка: $500",
        "• Тип: Киты",
        "• Категория: Все",
        "",
        "Продвинутый:",
        "• Мин. ставка: $250",
        "• Тип: Все",
        "• Категория: Спорт/Политика",
        "",
        "Нажмите пресет ниже, потом «▶️ Запустить».",
    ].join('\n');
    const kb = {
        inline_keyboard: [
            [
                { text: "🛡️ Консервативный", callback_data: "apply_preset|conservative" },
                { text: "⚖️ Сбалансированный", callback_data: "apply_preset|balanced" },
                { text: "🚀 Продвинутый", callback_data: "apply_preset|pro" }
            ]
        ]
    };
    bot.sendMessage(msg.chat.id, text, { reply_markup: kb });
});

bot.onText(/\/report/, async (msg) => {
    const chatId = msg.chat.id;
    try {
        const user = await db.getUser(chatId);
        const stake = Number(user?.virtual_stake_usd || 100);
        const [strategies, buckets, cats] = await Promise.all([
            db.getStrategyStats(30),
            db.getOddsBucketStats(30),
            db.getCategoryLeagueStats(30)
        ]);
        // Prefer user delivery logs for whale stats; fall back to raw signals for completeness
        let whales = await db.getWhaleStats(30);
        if (!whales || whales.length === 0) {
            whales = await db.getWhaleStatsFromSignals(30);
        }
        const whaleCats = await db.getWhaleCategoryStats(30);
        const lines = [];
        lines.push("📈 Отчёт за 30 дней");
        lines.push("");
        lines.push(`Базовая виртуальная ставка: $${stake}`);
        lines.push("");
        lines.push("Стратегии:");
        strategies.slice(0, 5).forEach(s => {
            const winrate = s.total ? (s.wins * 100.0 / s.total) : 0;
            const avgRoi = Number((s.avg_roi_capped ?? s.avg_roi) || 0);
            const pnlUsd = (avgRoi / 100) * stake * (s.total || 0);
            lines.push(`• ${s.strategy}: ${winrate.toFixed(1)}% винрейт, ROI ${avgRoi.toFixed(1)}%, PnL ~$${pnlUsd.toFixed(0)} (${s.total} сделок)`);
        });
        lines.push("");
        lines.push("Диапазоны коэффициентов:");
        buckets.forEach(b => {
            const winrate = b.total ? (b.wins * 100.0 / b.total) : 0;
            const avgRoi = Number((b.avg_roi_capped ?? b.avg_roi) || 0);
            const pnlUsd = (avgRoi / 100) * stake * (b.total || 0);
            lines.push(`• ${b.bucket}: ${winrate.toFixed(1)}% винрейт, ROI ${avgRoi.toFixed(1)}%, PnL ~$${pnlUsd.toFixed(0)} (${b.total})`);
        });
        lines.push("");
        lines.push("Категории/Лиги (топ‑5):");
        cats.slice(0, 5).forEach(c => {
            const winrate = c.total ? (c.wins * 100.0 / c.total) : 0;
            const cat = c.category || '—';
            const league = c.league || '—';
            const avgRoi = Number((c.avg_roi_capped ?? c.avg_roi) || 0);
            const pnlUsd = (avgRoi / 100) * stake * (c.total || 0);
            lines.push(`• ${cat}/${league}: ${winrate.toFixed(1)}% винрейт, ROI ${avgRoi.toFixed(1)}%, PnL ~$${pnlUsd.toFixed(0)} (${c.total})`);
        });
        lines.push("");
        lines.push("Киты (топ‑5):");
        (whales || []).slice(0, 5).forEach(w => {
            const winrate = w.total ? (w.wins * 100.0 / w.total) : 0;
            const avgRoi = Number((w.avg_roi_capped ?? w.avg_roi) || 0);
            const short = (w.whale || '').slice(0, 6) + '...' + (w.whale || '').slice(-4);
            lines.push(`• ${short}: ${winrate.toFixed(1)}% винрейт, ROI ${avgRoi.toFixed(1)}% (${w.total} сделок)`);
        });
        const bad = (whales || []).filter(w => w.total >= 5).sort((a, b) => (a.wins * 1.0 / a.total) - (b.wins * 1.0 / b.total)).slice(0, 5);
        if (bad.length) {
            lines.push("");
            lines.push("Анти‑лидеры (≥5 сделок):");
            bad.forEach(w => {
                const winrate = w.total ? (w.wins * 100.0 / w.total) : 0;
                const short = (w.whale || '').slice(0, 6) + '...' + (w.whale || '').slice(-4);
                lines.push(`• ${short}: ${winrate.toFixed(1)}% винрейт (${w.total})`);
            });
        }
        const wcTop = whaleCats.filter(x => x.total >= 5).sort((a, b) => (b.wins * 1.0 / b.total) - (a.wins * 1.0 / a.total)).slice(0, 5);
        if (wcTop.length) {
            lines.push("");
            lines.push("Лучшие пары Кит/Категория (топ‑5):");
            wcTop.forEach(x => {
                const winrate = x.total ? (x.wins * 100.0 / x.total) : 0;
                const short = (x.whale || '').slice(0, 6) + '...' + (x.whale || '').slice(-4);
                const cat = x.category || '—';
                lines.push(`• ${short}/${cat}: ${winrate.toFixed(1)}% (${x.total})`);
            });
        }
        bot.sendMessage(chatId, lines.join('\n'));
    } catch (e) {
        bot.sendMessage(chatId, "❌ Ошибка генерации отчёта. Попробуйте позже.");
    }
});

bot.on('callback_query', async (query) => {
    const chatId = query.message.chat.id;
    const data = query.data;
    let user = await db.getUser(chatId);
    if (!user) {
        await db.createUser(chatId);
        user = await db.getUser(chatId);
    }
    if (data === 'menu_settings') {
        bot.editMessageText("⚙️ **Настройки Фильтров**\n\nВыберите параметр для изменения:", {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: ui.settingsMenu(user)
        });
    } else if (data === 'menu_challenge') {
        bot.editMessageText("💎 **Challenge Mode**\n\n🎯 Автоматическое управление портфелем\n💰 Старт: $20\n📊 Сайзинг: 10% от баланса\n🧠 Только Smart Whales (строгий фильтр)\n\n_Выберите действие:_", {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: ui.challengeMenu
        });
    } else if (data === 'menu_main') {
        bot.editMessageText("👋 **Главное Меню**", {
            chat_id: chatId,
            message_id: query.message.message_id,
            parse_mode: 'Markdown',
            reply_markup: ui.mainMenu
        });
    } else if (data === 'challenge_start') {
        await db.createUser(chatId);
        try {
            await db.initPortfolio(chatId);
            await db.updatePortfolio(chatId, { balanceDelta: 0, lockedDelta: 0, is_challenge_active: 1 });
            await db.updateUser(chatId, { strategy_name: 'challenge_20', active: 1 });
            bot.answerCallbackQuery(query.id, { text: "🟢 Challenge Started!" });
            await bot.sendMessage(chatId, "🟢 **Challenge Started**\n💰 Balance: $20.00\n🎯 Стратегия: Smart Whales Only\n📊 Сайзинг: 10% от баланса", { parse_mode: 'Markdown', reply_markup: ui.mainMenu });
        } catch (e) {
            bot.answerCallbackQuery(query.id, { text: "⚠️ Ошибка инициализации" });
        }
    } else if (data === 'challenge_portfolio') {
        try {
            let pf = await db.getPortfolio(chatId);
            if (!pf) { await db.initPortfolio(chatId); pf = await db.getPortfolio(chatId); }
            const balance = Number(pf.balance || 0).toFixed(2);
            const locked = Number(pf.locked || 0).toFixed(2);
            const equity = Number(pf.equity || (pf.balance + pf.locked) || 0).toFixed(2);
            bot.answerCallbackQuery(query.id);
            await bot.sendMessage(chatId, `💰 **Портфель**\n\n💵 Balance: $${balance}\n🔒 Locked: $${locked}\n📈 Equity: $${equity}`, { parse_mode: 'Markdown', reply_markup: ui.mainMenu });
        } catch (e) {
            bot.answerCallbackQuery(query.id, { text: "⚠️ Ошибка чтения портфеля" });
        }
    } else if (data === 'challenge_stats') {
        bot.answerCallbackQuery(query.id);
        await bot.sendMessage(chatId, "📊 Используйте команду /challenge_stats для детальной статистики челленджа", { reply_markup: ui.mainMenu });
    } else if (data === 'cmd_start') {
        await db.updateUser(chatId, { active: 1 });
        bot.answerCallbackQuery(query.id, { text: "✅ Бот запущен!" });
    } else if (data === 'cmd_stop') {
        await db.updateUser(chatId, { active: 0 });
        bot.answerCallbackQuery(query.id, { text: "⏸ Бот остановлен." });
    } else if (data === 'set_winrate_min') {
        userStates[chatId] = 'waiting_winrate_min';
        bot.sendMessage(chatId, "✍️ Введите минимальный винрейт кита (в %):\nДиапазон: 0–100", { reply_markup: { force_reply: true, selective: true } });
    } else if (data === 'set_winrate_max') {
        userStates[chatId] = 'waiting_winrate_max';
        bot.sendMessage(chatId, "✍️ Введите максимальный винрейт кита (в %):\nДиапазон: 0–100", { reply_markup: { force_reply: true, selective: true } });
    } else if (data === 'clear_winrate_filter') {
        await db.updateUser(chatId, { filter_winrate_min_percent: 0, filter_winrate_max_percent: 100 });
        bot.answerCallbackQuery(query.id, { text: "🧹 Фильтр винрейта сброшен" });
        const updatedUser = await db.getUser(chatId);
        bot.editMessageReplyMarkup(ui.settingsMenu(updatedUser), { chat_id: chatId, message_id: query.message.message_id });
    } else if (data.startsWith('open_market|')) {
        const parts = data.split('|');
        const slug = parts[1] || '';
        const cond = parts[2] || '';
        const url = slug ? `https://polymarket.com/event/${slug}` : (cond ? `https://polymarket.com/market/${cond}` : '');
        if (!url) {
            bot.answerCallbackQuery(query.id, { text: "⚠️ Ссылка недоступна" });
            await db.logAction(chatId, 'open_market_error', { slug, cond });
            bot.sendMessage(chatId, "⚠️ Не удалось определить ссылку на рынок. Попробуйте позже.");
        } else {
            bot.answerCallbackQuery(query.id, { text: "🔗 Открываю рынок..." });
            await db.logAction(chatId, 'open_market', { url, slug, cond });
            bot.sendMessage(chatId, `🔗 Ссылка на рынок:\n${url}`);
        }
    } else if (data.startsWith('details|')) {
        const parts = data.split('|');
        let addr = '';
        let cond = '';
        let slug = '';
        if (parts.length === 2) {
            const p = await db.getCallbackPayload(parts[1]);
            addr = p?.addr || '';
            cond = p?.cond || '';
            slug = p?.slug || '';
        } else {
            addr = parts[1] || '';
            cond = parts[2] || '';
            slug = parts[3] || '';
        }
        bot.answerCallbackQuery(query.id, { text: "⏳ Загружаю данные..." });
        await db.logAction(chatId, 'details_click', { addr, cond, slug });
        try {
            const info = await logic.fetchUserHistory(addr);
            let marketInfo = null;
            if (cond) {
                try {
                    const resp = await axios.get(`https://clob.polymarket.com/markets/${cond}`, { timeout: 7000 });
                    marketInfo = resp.data;
                } catch (e) {}
            }
            const lines = [];
            if (info) {
                lines.push(`🐋 Профиль: ${addr.slice(0,6)}...${addr.slice(-4)}`);
                lines.push(`PnL: ${(info.pnl > 0 ? '+' : '')}${logic.fmt(info.pnl)}`);
                lines.push(`Винрейт: ${info.winrate.toFixed(1)}%`);
                lines.push(`Объём: ${logic.fmt(info.totalVolume)}`);
            }
            if (marketInfo) {
                lines.push(`Рынок: ${marketInfo.question}`);
                lines.push(`Статус: ${marketInfo.closed ? 'Закрыт' : 'Открыт'}`);
                if (marketInfo.closed) {
                    const w = marketInfo.tokens.find(t => t.winner);
                    if (w) lines.push(`Победил исход: ${w.outcome}`);
                }
            }
            if (lines.length === 0) lines.push('Нет данных для отображения.');
            bot.sendMessage(chatId, lines.join('\n'));
        } catch (err) {
            bot.sendMessage(chatId, "❌ Ошибка загрузки данных. Попробуйте позже.");
        }
    } else if (data === 'set_min_bet') {
        userStates[chatId] = 'waiting_min_bet';
        bot.sendMessage(chatId, "✍️ Введите минимальную сумму ставки (в $):", { reply_markup: { force_reply: true, selective: true } });
    } else if (data === 'set_virtual_stake') {
        userStates[chatId] = 'waiting_virtual_stake';
        bot.sendMessage(chatId, "✍️ Введите виртуальную сумму ставки для отчётов (в $):", { reply_markup: { force_reply: true, selective: true } });
    } else if (data === 'set_min_pnl_total') {
        userStates[chatId] = 'waiting_min_pnl_total';
        bot.sendMessage(chatId, "✍️ Введите минимальный общий PnL кита (в $):", { reply_markup: { force_reply: true, selective: true } });
    } else if (data === 'set_min_pnl_recent') {
        userStates[chatId] = 'waiting_min_pnl_recent';
        bot.sendMessage(chatId, "✍️ Введите минимальный PnL за последние 10 сделок (в $):", { reply_markup: { force_reply: true, selective: true } });
    } else if (data === 'set_market_filter') {
        userStates[chatId] = 'waiting_market_filter';
        bot.sendMessage(chatId, "✍️ Введите ключевое слово или slug события.\nПримеры: trump, bitcoin, nfl-week-1\nНапишите off чтобы выключить.", { reply_markup: { force_reply: true, selective: true } });
    } else if (data === 'clear_market_filter') {
        await db.updateUser(chatId, { filter_market_slug: null });
        bot.answerCallbackQuery(query.id, { text: "🧹 Фильтр события очищен" });
        const updatedUser = await db.getUser(chatId);
        bot.editMessageReplyMarkup(ui.settingsMenu(updatedUser), { chat_id: chatId, message_id: query.message.message_id });
    } else if (data === 'toggle_whale_type') {
        const types = ['all', 'whale', 'smart_whale', 'hamster'];
        const currentIdx = types.indexOf(user.filter_whale_type);
        const nextType = types[(currentIdx + 1) % types.length];
        await db.updateUser(chatId, { filter_whale_type: nextType });
        bot.answerCallbackQuery(query.id, { text: `Тип: ${nextType}` });
        await db.logAction(chatId, 'toggle_whale_type', { from: user.filter_whale_type, to: nextType });
        const updatedUser = await db.getUser(chatId);
        bot.editMessageReplyMarkup(ui.settingsMenu(updatedUser), {
            chat_id: chatId,
            message_id: query.message.message_id
        });
    } else if (data === 'toggle_market_category') {
        const categories = ['all', 'crypto', 'politics', 'sports', 'weather', 'other'];
        const currentIdx = categories.indexOf(user.filter_market_category || 'all');
        const nextCategory = categories[(currentIdx + 1) % categories.length];
        await db.updateUser(chatId, { filter_market_category: nextCategory });
        bot.answerCallbackQuery(query.id, { text: `Категория: ${nextCategory}` });
        await db.logAction(chatId, 'toggle_market_category', { from: user.filter_market_category, to: nextCategory });
        const updatedUser = await db.getUser(chatId);
        bot.editMessageReplyMarkup(ui.settingsMenu(updatedUser), {
            chat_id: chatId,
            message_id: query.message.message_id
        });
    } else if (data.startsWith('apply_preset|')) {
        const preset = data.split('|')[1];
        let params = {};
        if (preset === 'conservative') {
            params = { min_bet: 1000, filter_whale_type: 'smart_whale', filter_market_category: 'politics', min_pnl_total: 10000, strategy_name: 'conservative' };
        } else if (preset === 'balanced') {
            params = { min_bet: 500, filter_whale_type: 'whale', filter_market_category: 'all', min_pnl_total: 5000, strategy_name: 'balanced' };
        } else if (preset === 'pro') {
            params = { min_bet: 250, filter_whale_type: 'all', filter_market_category: 'sports', min_pnl_total: 2000, strategy_name: 'pro' };
        }
        await db.updateUser(chatId, params);
        await db.logAction(chatId, 'apply_preset', { preset, params });
        bot.answerCallbackQuery(query.id, { text: "✅ Пресет применён" });
        const updatedUser = await db.getUser(chatId);
        bot.sendMessage(chatId, "Настройки обновлены. Откройте «⚙️ Настройки Фильтров» для просмотра.", { reply_markup: ui.settingsMenu(updatedUser) });
    }
});

bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const state = userStates[chatId];
    if (!state) return;
    const input = msg.text;
    if (state === 'waiting_min_bet') {
        const val = parseInt(input);
        if (!isNaN(val) && val >= 0 && val <= 10000000) {
            await db.updateUser(chatId, { min_bet: val });
            bot.sendMessage(chatId, `✅ Минимальная ставка установлена: $${val}`, { reply_markup: ui.mainMenu });
        } else {
            bot.sendMessage(chatId, "❌ Ошибка. Введите число.");
        }
    } else if (state === 'waiting_virtual_stake') {
        const val = parseInt(input);
        if (!isNaN(val) && val > 0 && val <= 100000) {
            await db.updateUser(chatId, { virtual_stake_usd: val });
            bot.sendMessage(chatId, `✅ Виртуальная ставка для отчётов: $${val}`, { reply_markup: ui.mainMenu });
        } else {
            bot.sendMessage(chatId, "❌ Ошибка. Введите число.");
        }
    } else if (state === 'waiting_min_pnl_total') {
        const val = parseInt(input);
        if (!isNaN(val) && val >= 0 && val <= 100000000) {
            await db.updateUser(chatId, { min_pnl_total: val });
            bot.sendMessage(chatId, `✅ Мин. общий PnL установлен: $${val}`, { reply_markup: ui.mainMenu });
        }
    } else if (state === 'waiting_min_pnl_recent') {
        const val = parseInt(input);
        if (!isNaN(val) && val >= 0 && val <= 100000000) {
            await db.updateUser(chatId, { min_pnl_recent: val });
            bot.sendMessage(chatId, `✅ Мин. недавний PnL установлен: $${val}`, { reply_markup: ui.mainMenu });
        }
    } else if (state === 'waiting_market_filter') {
        const val = input.toLowerCase() === 'off' ? null : input;
        await db.updateUser(chatId, { filter_market_slug: val });
        bot.sendMessage(chatId, `✅ Фильтр по событию: ${val ? val : 'Выключен'}`, { reply_markup: ui.mainMenu });
    } else if (state === 'waiting_winrate_min') {
        const val = parseInt(input);
        if (!isNaN(val) && val >= 0 && val <= 100) {
            const user = await db.getUser(chatId);
            const max = (user.filter_winrate_max_percent !== undefined && user.filter_winrate_max_percent !== null) ? user.filter_winrate_max_percent : 100;
            const newMin = Math.min(val, max);
            await db.updateUser(chatId, { filter_winrate_min_percent: newMin });
            bot.sendMessage(chatId, `✅ Мин. винрейт установлен: ${newMin}%`, { reply_markup: ui.mainMenu });
        } else {
            bot.sendMessage(chatId, "❌ Ошибка. Введите число от 0 до 100.");
        }
    } else if (state === 'waiting_winrate_max') {
        const val = parseInt(input);
        if (!isNaN(val) && val >= 0 && val <= 100) {
            const user = await db.getUser(chatId);
            const min = (user.filter_winrate_min_percent !== undefined && user.filter_winrate_min_percent !== null) ? user.filter_winrate_min_percent : 0;
            const newMax = Math.max(val, min);
            await db.updateUser(chatId, { filter_winrate_max_percent: newMax });
            bot.sendMessage(chatId, `✅ Макс. винрейт установлен: ${newMax}%`, { reply_markup: ui.mainMenu });
        } else {
            bot.sendMessage(chatId, "❌ Ошибка. Введите число от 0 до 100.");
        }
    } else if (state === 'waiting_feedback') {
        const feedback = (input || '').trim();
        if (feedback.length > 0) {
            try {
                await db.logAction(chatId, 'feedback', { text: feedback });
            } catch (_) {}
            bot.sendMessage(chatId, "✅ Спасибо! Ваше сообщение отправлено.", { reply_markup: ui.mainMenu });
        } else {
            bot.sendMessage(chatId, "❌ Пустое сообщение. Напишите текст и отправьте.", { reply_markup: ui.mainMenu });
        }
    }
    delete userStates[chatId];
});

const processedTrades = new Set();
let loopRunning = false;
async function runBotLoop() {
    if (loopRunning) return;
    loopRunning = true;
    try {
        const trades = await logic.fetchTrades(200);
        lastScanTs = Date.now();
        console.log("🔍 Scanned " + trades.length + " trades. Checking...");
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
            const priceNum = Number(trade.price ?? 0);
            const sizeNum = Number(trade.size ?? 0);
            let tradeValueUsd = (isFinite(priceNum) ? priceNum : 0) * (isFinite(sizeNum) ? sizeNum : 0);
            if (!isFinite(tradeValueUsd) || tradeValueUsd < 0) tradeValueUsd = 0;
            const walletAddress = trade.proxyWallet || trade.maker_address || trade.user;
            const marketSlug = trade.slug || trade.market_slug || trade.conditionId || trade.condition_id; 
            if (!walletAddress) continue;
            const addrStr = String(walletAddress || '').toLowerCase();
            if (!addrStr.startsWith('0x') || addrStr.includes('zero') || addrStr.includes('null') || addrStr.includes('undefined')) { 
                console.log("Invalid Wallet: " + walletAddress); 
                continue; 
            }
            
            // ANTI-AMNESIA: Check DB for duplicate transaction_hash BEFORE processing
            if (trade.transactionHash && await db.checkSignalExists(trade.transactionHash)) {
                // Trade already processed in previous run — skip silently
                processedTrades.add(tradeId);
                continue;
            }
            
            // Log all trades to CSV history, even small ones
            logTradeToHistory(trade, tradeValueUsd).catch(() => {});

            // Hard Filters (protect deposit): apply BEFORE saving/sending
            const side = (String(trade.side || 'BUY')).toUpperCase();
            if (side === 'SELL') { console.log("⛔ Hard Filter: SELL disabled for " + tradeId); continue; }
            if (priceNum > 0.75) { console.log("⛔ Hard Filter: Price " + priceNum.toFixed(2) + " > 0.75 for " + tradeId); continue; }
            if (tradeValueUsd < 50) { console.log("⛔ Hard Filter: Value $" + tradeValueUsd.toFixed(0) + " < $50 for " + tradeId); continue; }
            const tradeTimeMs = trade.timestamp ? (Number(trade.timestamp) * 1000) : (trade.created_at ? new Date(trade.created_at).getTime() : Date.now());
            const lagSeconds = Math.max(0, (Date.now() - tradeTimeMs) / 1000);
            console.log(`🐳 Analyzing wallet: ${walletAddress} (Lag: ${lagSeconds.toFixed(1)}s)`);
            await new Promise(r => setTimeout(r, 250));
            const userData = await logic.fetchUserHistory(walletAddress, tradeValueUsd);
            if (!userData) continue;
            
            // Honest Whale Classification
            let whaleStatus = '🐟 Трейдер'; // Default
            if (userData.pnl > 0) whaleStatus = '🐋 Кит';
            
            // Smart Whale: Significant Profit AND Statistical Consistency (Positive Median & Lower Bound Winrate > 40%)
            if (userData.pnl > 5000 && userData.medianPnl > 0 && userData.winrateLowerBound > 40) {
                whaleStatus = '🧠 Умный Кит';
            }
            
            if (userData.pnl < -1000) whaleStatus = '🐹 Хомяк';

            const sideRu = side === 'BUY' ? '🟢 ПОКУПКА' : '🔴 ПРОДАЖА';
            const outcomeRu = trade.outcome === 'Yes' ? 'Да' : (trade.outcome === 'No' ? 'Нет' : trade.outcome);
            const viewData = {
                whale_status: whaleStatus,
                wallet_short: walletAddress.slice(0, 6) + '...' + walletAddress.slice(-4),
                pnl: userData.pnl,
                pnl_fmt: (userData.pnl > 0 ? '+' : '') + logic.fmt(userData.pnl),
                median_pnl: userData.medianPnl,
                median_fmt: (userData.medianPnl > 0 ? '+' : '') + logic.fmt(userData.medianPnl),
                // Show Raw Winrate AND Conservative Lower Bound
                winrate_fmt: `${userData.winrate.toFixed(0)}% (CI>${userData.winrateLowerBound.toFixed(0)}%)`,
                volume_fmt: logic.fmt(userData.totalVolume),
                trade_size_fmt: logic.fmt(tradeValueUsd),
                total_trades_fmt: (userData.totalTrades || 0).toLocaleString('en-US'),
                market_question: trade.title || 'Unknown Market',
                outcome: outcomeRu,
                side: sideRu,
                timestamp: new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
            };
            try {
                let outcomeCanonical = trade.outcome || '';
                let condIdForSave = trade.conditionId || trade.condition_id || '';
                if (!condIdForSave) {
                    const slugCandidate = trade.eventSlug || trade.slug || trade.market_slug || '';
                    if (slugCandidate) {
                        try {
                            const resp = await axios.get(`https://polymarket.com/api/events/${slugCandidate}`, { timeout: 7000 });
                            const data = resp.data;
                            if (data && Array.isArray(data.markets)) {
                                const out = (trade.outcome || '').toLowerCase();
                                const found = data.markets.find(m => (m.tokens || []).some(t => (t.outcome || '').toLowerCase() === out)) || data.markets[0];
                                if (found && (found.conditionId || found.id)) {
                                    condIdForSave = found.conditionId || found.id;
                                }
                            }
                        } catch (e) {}
                    }
                }
                if (condIdForSave) {
                    try {
                        const vresp = await axios.get(`https://clob.polymarket.com/markets/${condIdForSave}`, { timeout: 7000 });
                        if (!vresp || !vresp.data) {
                            condIdForSave = '';
                        } else {
                            const tokens = Array.isArray(vresp.data.tokens) ? vresp.data.tokens : [];
                            const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
                            const target = norm(outcomeCanonical);
                            let found = tokens.find(t => norm(t.outcome) === target);
                            if (!found) {
                                found = tokens.find(t => {
                                    const m = norm(t.outcome);
                                    return m.includes(target) || target.includes(m);
                                });
                            }
                            if (!found && tokens.length === 2) {
                                const labels = tokens.map(t => norm(t.outcome));
                                if (labels.includes('yes') && labels.includes('no')) {
                                    if (target === 'up' || target === 'bull' || target === 'yes') found = tokens.find(t => norm(t.outcome) === 'yes');
                                    if (target === 'down' || target === 'bear' || target === 'no') found = tokens.find(t => norm(t.outcome) === 'no');
                                }
                            }
                            if (found && found.outcome) {
                                outcomeCanonical = found.outcome;
                                const idx = tokens.findIndex(t => t.outcome === found.outcome);
                                viewData._tokenIndex = idx >= 0 ? idx : null;
                            }
                        }
                    } catch (_) { condIdForSave = ''; }
                }
                viewData._outcomeCanonical = outcomeCanonical;
                if (condIdForSave) {
                    const signalId = await db.saveSignal({
                        market_slug: trade.slug || trade.market_slug || '',
                        event_slug: trade.eventSlug || trade.slug || '',
                        condition_id: condIdForSave,
                        outcome: outcomeCanonical || '',
                        side: side,
                        entry_price: trade.price || 0,
                        size_usd: tradeValueUsd,
                        whale_address: walletAddress,
                        token_index: viewData._tokenIndex ?? null,
                        transaction_hash: trade.transactionHash || null
                    });
                    const cat = logic.categorizeMarket(trade.title, marketSlug);
                    const league = logic.extractLeague(trade.title, marketSlug);
                    viewData._signalId = signalId;
                    viewData._category = cat;
                    viewData._league = league;
                } else {
                    await db.logAction(0, 'skip_save_signal_no_condition', { market_slug: marketSlug, title: trade.title });
                    const cat = logic.categorizeMarket(trade.title, marketSlug);
                    const league = logic.extractLeague(trade.title, marketSlug);
                    viewData._signalId = null;
                    viewData._category = cat;
                    viewData._league = league;
                }
            } catch (err) {}
            let imageBuffer = null;
            console.log("Matching against " + activeUsers.length + " users...");
            for (const user of activeUsers) {
                // Challenge Mode: automatic portfolio management
                if ((user.strategy_name || '').toLowerCase() === 'challenge_20') {
                    try {
                        // Ignore manual filters; enforce core hard filters
                        if (side === 'SELL') { console.log("⛔ Challenge: SELL skipped for " + tradeId); continue; }
                        if (priceNum > 0.75) { console.log("⛔ Challenge: Price " + priceNum.toFixed(2) + " > 0.75 for " + tradeId); continue; }

                        // Smart Whale strict check
                        const isSmart = (userData.pnl > 5000 && userData.medianPnl > 0 && userData.winrateLowerBound > 40);
                        if (!isSmart) { console.log("⛔ Challenge: Not a Smart Whale for user " + user.chat_id); continue; }

                        // Portfolio
                        let pf = await db.getPortfolio(user.chat_id);
                        if (!pf) { await db.initPortfolio(user.chat_id); pf = await db.getPortfolio(user.chat_id); }
                        const balanceNum = Number(pf.balance || 0);
                        const betTentative = balanceNum * 0.10;
                        if (balanceNum < 1 || betTentative < 1) {
                            if (!lowBalanceAlertSent[user.chat_id]) {
                                const balStr = balanceNum.toFixed(2);
                                try { await bot.sendMessage(user.chat_id, `⚠️ **WARNING:** Баланс ($${balStr}) слишком мал для минимальной ставки ($1). Торговля приостановлена.`, { parse_mode: 'Markdown' }); } catch (_) {}
                                lowBalanceAlertSent[user.chat_id] = true;
                            }
                            console.log("⛔ Challenge: Balance/BET < $1 for user " + user.chat_id);
                            continue;
                        }
                        let bet = Math.max(1, betTentative);
                        bet = Math.min(bet, balanceNum);
                        bet = Math.round(bet * 100) / 100;

                        await db.updatePortfolio(user.chat_id, { balanceDelta: -bet, lockedDelta: bet });

                        // Log user signal with bet_amount
                        if (viewData._signalId) {
                            await db.logUserSignal(user.chat_id, viewData._signalId, {
                                strategy: 'challenge_20',
                                side: side,
                                entry_price: Number(trade.price || 0),
                                size_usd: tradeValueUsd,
                                bet_amount: bet,
                                category: viewData._category,
                                league: viewData._league,
                                outcome: viewData._outcomeCanonical || (trade.outcome || ''),
                                token_index: viewData._tokenIndex ?? null
                            });
                        }

                        // Notify bet placement
                        try {
                            await bot.sendMessage(user.chat_id, `💎 Bet Placed: $${bet.toFixed(2)}`, { parse_mode: 'Markdown' });
                        } catch (_) {}
                    } catch (e) { console.error("Challenge mode error:", e && e.message || e); }
                    // Skip custom flow for challenge users
                    continue;
                }
                if (tradeValueUsd < user.min_bet) { console.log("Custom Filter Failed: Bet $" + tradeValueUsd.toFixed(0) + " < User Min $" + user.min_bet); continue; }
                const ftype = user.filter_whale_type || 'all';
                if (ftype === 'smart_whale') {
                    if (!(userData.pnl > 5000 && userData.medianPnl > 0 && userData.winrateLowerBound > 40)) { console.log("User " + user.chat_id + " skipped. Reason: Not a Smart Whale"); continue; }
                } else if (ftype === 'all') {
                    if (userData.pnl < user.min_pnl_total) { console.log("Custom Filter Failed: Total PnL $" + userData.pnl.toFixed(0) + " < User Min $" + user.min_pnl_total); continue; }
                    const wrMinOnly = (user.filter_winrate_min_percent !== undefined && user.filter_winrate_min_percent !== null) ? user.filter_winrate_min_percent : 0;
                    const wrRaw = userData.winrate || 0;
                    if (wrRaw < wrMinOnly) { console.log("Custom Filter Failed: Winrate " + wrRaw.toFixed(0) + "% < User Min " + wrMinOnly + "%"); continue; }
                } else {
                    if (ftype === 'hamster' && userData.pnl >= 0) { console.log("User " + user.chat_id + " skipped. Reason: Hamster requires negative PnL"); continue; }
                    if (ftype === 'whale' && userData.pnl <= 0) { console.log("User " + user.chat_id + " skipped. Reason: Whale requires positive PnL"); continue; }
                    if (user.filter_market_slug) {
                        const q = user.filter_market_slug.toLowerCase();
                        if (!trade.title.toLowerCase().includes(q) && !marketSlug.includes(q)) { console.log("User " + user.chat_id + " skipped. Reason: Market slug filter '" + q + "' mismatch"); continue; }
                    }
                    if (user.filter_market_category && user.filter_market_category !== 'all') {
                        const tradeCategory = logic.categorizeMarket(trade.title, marketSlug);
                        if (tradeCategory !== user.filter_market_category) { console.log("User " + user.chat_id + " skipped. Reason: Category " + tradeCategory + " != " + user.filter_market_category); continue; }
                    }
                    const wrMin = (user.filter_winrate_min_percent !== undefined && user.filter_winrate_min_percent !== null) ? user.filter_winrate_min_percent : 0;
                    const wrMax = (user.filter_winrate_max_percent !== undefined && user.filter_winrate_max_percent !== null) ? user.filter_winrate_max_percent : 100;
                    const wr = userData.winrate || 0;
                    if (wr < wrMin || wr > wrMax) { console.log("User " + user.chat_id + " skipped. Reason: Filter Winrate " + wrMin + "-" + wrMax + " vs Whale " + wr.toFixed(0)); continue; }
                }
                if (!imageBuffer) {
                    try {
                        console.log("🎨 Generating card for " + tradeId);
                        imageBuffer = await Promise.race([
                            logic.generateCardImage(viewData),
                            new Promise((resolve) => setTimeout(() => resolve(null), 5000))
                        ]);
                        if (!imageBuffer) {
                            console.log("⏱️ Card generation timeout, fallback to text for " + tradeId);
                        }
                    } catch (e) {
                        console.error("Card generation error: " + (e && e.message || e));
                        imageBuffer = null;
                    }
                }
                try {
                    let logSide = side;
                    let logEntry = trade.price || 0;
                    if (user.filter_whale_type === 'hamster') {
                        logSide = (side === 'BUY' ? 'SELL' : 'BUY');
                    }
                    if (viewData._signalId) {
                        await db.logUserSignal(user.chat_id, viewData._signalId, {
                            strategy: user.strategy_name || 'custom',
                            side: logSide,
                            entry_price: logEntry,
                            size_usd: tradeValueUsd,
                            category: viewData._category,
                            league: viewData._league,
                            outcome: viewData._outcomeCanonical || (trade.outcome || ''),
                            token_index: viewData._tokenIndex ?? null
                        });
                    }
                } catch (e) {}
                const marketQuestionSafe = escapeMarkdown(viewData.market_question);
                const outcomeSafe = escapeMarkdown(outcomeRu);
                const caption = `🚨 **Сигнал Кита**\n\nОбнаружен ${escapeMarkdown(whaleStatus)}!\nСобытие: ${marketQuestionSafe}\nДействие: ${escapeMarkdown(sideRu)} ${escapeMarkdown(viewData.trade_size_fmt)} на исход "${outcomeSafe}"`;

                // Risk Warning System (Polymarket Native Style)
                const rawPrice = isFinite(Number(trade.price)) ? Number(trade.price) : 0.5;
                // Симулируем вход на $1000, чтобы проверить глубину стакана
                const simulatedExecution = math.applyConservativeSlippage(rawPrice, tradeValueUsd);
                // Считаем, на сколько процентов цена уйдет против юзера
                const slippageDiff = Math.abs((simulatedExecution - rawPrice) / rawPrice) * 100;

                if (slippageDiff > 5.0) {
                    // Ситуация: Кит вымел стакан. Покупка "по рынку" принесет мгновенный убыток.
                    // Байт: "Кит сдвинул рынок. Не будь хомяком, не переплачивай."
                    caption += "\n🌊 **Whale moved the market!** Liquidity is thin.\n🧱 **Smart Move:** Use Limit Orders. Don't buy at market price.";
                } else if (slippageDiff > 2.0) {
                    // Ситуация: Волатильность.
                    // Байт: "Цена скачет. Будь внимателен."
                    caption += "\n⚡️ **High Volatility.** Price is heating up.\n👀 **Tip:** Check the price before confirming.";
                } else {
                    // Ситуация: Ликвидности много, можно брать.
                    // Байт: "Зеленый свет."
                    caption += "\n💎 **Solid Liquidity.** Good entry zone.";
                }

                const eventSlug = trade.eventSlug || trade.slug || '';
                const condId = trade.conditionId || trade.condition_id || '';
                const firstRow = [{ text: "🔎 Профиль Polymarket", url: `https://polymarket.com/profile/${walletAddress}` }];
                if (eventSlug) {
                    firstRow.push({ text: "🗓️ Событие", url: `https://polymarket.com/event/${eventSlug}` });
                } else if (condId) {
                    firstRow.push({ text: "🗓️ Рынок", url: `https://polymarket.com/market/${condId}` });
                }
                const payloadId = await db.saveCallbackPayload({ addr: walletAddress, cond: condId, slug: eventSlug });
                const marketUrl = eventSlug ? `https://polymarket.com/event/${eventSlug}` : (condId ? `https://polymarket.com/market/${condId}` : `https://polymarket.com/`);
                const buttons = {
                    inline_keyboard: [
                        firstRow,
                        [
                            { text: "📊 Подробнее", callback_data: `details|${payloadId}` },
                            { text: "👉 Открыть рынок", url: marketUrl }
                        ]
                    ]
                };
                try {
                    if (TELEGRAM_TOKEN !== 'YOUR_TELEGRAM_TOKEN') {
                        if (imageBuffer) {
                            console.log("🚀 Sending photo to " + user.chat_id);
                            await safeSendPhoto(user.chat_id, imageBuffer, {
                                caption: caption,
                                parse_mode: 'Markdown',
                                reply_markup: buttons
                            });
                        } else {
                            // Fallback: send text if image not available or timed out
                            await bot.sendMessage(user.chat_id, caption, {
                                parse_mode: 'Markdown',
                                reply_markup: buttons
                            });
                        }
                    }
                } catch (err) {
                    try {
                        const msg = String(err && err.message || '');
                        if (msg.toLowerCase().includes('chat not found')) {
                            await db.updateUser(user.chat_id, { active: 0 });
                            await db.logAction(user.chat_id, 'deactivate_chat_not_found', { error: msg });
                        }
                    } catch (_) {}
                }
            }
        }
    } catch (e) {}
    loopRunning = false;
}

setInterval(runBotLoop, 2000);
runBotLoop();
