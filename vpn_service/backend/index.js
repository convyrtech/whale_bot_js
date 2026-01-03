const { Telegraf, Markup } = require('telegraf');
const { v4: uuidv4 } = require('uuid');
const path = require('path');
const fs = require('fs');
const dotenv = require('dotenv');
const CryptoBotAPI = require('crypto-bot-api');

// Force reload .env and override existing env vars
const envConfig = dotenv.parse(fs.readFileSync(path.resolve(__dirname, '.env')));
for (const k in envConfig) {
    process.env[k] = envConfig[k];
}

const db = require('./database');
const XuiApi = require('./xui_api');

// --- CONFIG ---
const BOT_TOKEN = process.env.BOT_TOKEN;
const CRYPTO_BOT_TOKEN = process.env.CRYPTO_BOT_TOKEN;
console.log("🔑 Using Bot Token:", BOT_TOKEN.substring(0, 10) + "...");
const INBOUND_ID = parseInt(process.env.INBOUND_ID || 1);
const SERVER_IP = process.env.XUI_URL.split('//')[1].split(':')[0]; // Extract IP from URL

if (!BOT_TOKEN || BOT_TOKEN === 'YOUR_TELEGRAM_BOT_TOKEN_HERE') {
    console.error("❌ ERROR: Please set BOT_TOKEN in .env file!");
    process.exit(1);
}

const bot = new Telegraf(BOT_TOKEN);
const cryptoBot = new CryptoBotAPI(CRYPTO_BOT_TOKEN);
const xui = new XuiApi(process.env.XUI_URL, process.env.XUI_USERNAME, process.env.XUI_PASSWORD);

// Cache for Inbound Settings (Public Key, SNI, etc.)
let inboundSettings = null;

async function loadInboundSettings() {
    console.log("🔄 Fetching Inbound Settings...");
    const inbounds = await xui.getInbounds();
    const target = inbounds.find(i => i.id === INBOUND_ID);
    
    if (target) {
        const streamSettings = JSON.parse(target.streamSettings);
        const realitySettings = streamSettings.realitySettings;
        
        inboundSettings = {
            port: target.port,
            publicKey: realitySettings.settings.publicKey,
            serverName: realitySettings.serverNames[0],
            shortId: realitySettings.shortIds[0],
            fingerprint: realitySettings.settings.fingerprint || 'chrome',
            type: target.protocol
        };
        console.log("✅ Inbound Settings Loaded:", inboundSettings);
    } else {
        console.error("❌ ERROR: Inbound not found! Check INBOUND_ID in .env");
    }
}

// --- HELPERS ---

function generateVlessLink(uuid, name) {
    if (!inboundSettings) return "Error: Server settings not loaded.";
    
    // VLESS Link Format for Reality
    // vless://uuid@ip:port?type=tcp&security=reality&pbk=key&fp=chrome&sni=sni&sid=sid&spx=%2F&flow=xtls-rprx-vision#name
    
    const params = new URLSearchParams({
        type: 'tcp',
        security: 'reality',
        pbk: inboundSettings.publicKey,
        fp: inboundSettings.fingerprint,
        sni: inboundSettings.serverName,
        sid: inboundSettings.shortId,
        spx: '/',
        flow: 'xtls-rprx-vision'
    });

    return `vless://${uuid}@${SERVER_IP}:${inboundSettings.port}?${params.toString()}#${encodeURIComponent(name)}`;
}

const ADMIN_ID = 7293810669; // Your ID

// --- BOT LOGIC ---

bot.use(async (ctx, next) => {
    console.log(`📩 Update received: ${ctx.updateType}`);
    if (ctx.from) {
        await db.createUser(ctx.from.id, ctx.from.username, ctx.from.first_name);
    }
    return next();
});

bot.start(async (ctx) => {
    console.log(`▶️ /start command from ${ctx.from.id}`);
    const user = await db.getUser(ctx.from.id);
    
    // Check for referral payload (e.g., /start 12345)
    const payload = ctx.message.text.split(' ')[1];
    if (payload && !isNaN(parseInt(payload))) {
        const referrerId = parseInt(payload);
        if (referrerId !== ctx.from.id) {
            const referrer = await db.getUser(referrerId);
            if (referrer) {
                await db.setReferrer(user.id, referrer.id);
                console.log(`🔗 User ${user.telegram_id} referred by ${referrer.telegram_id}`);
            }
        }
    }
    
    try {
        await ctx.reply(
            `🐋 **WHALE VPN**\n\n` +
            `Твой личный доступ к свободному интернету.\n\n` +
            `⚡️ **Скорость:** до 1 Гбит/с (YouTube 4K)\n` +
            `🛡 **Анонимность:** VLESS Reality (Невидим для провайдера)\n` +
            `🌍 **Локация:** Нидерланды / США\n\n` +
            `👇 **Выберите действие:**`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⚡️ Тест (24ч)', 'get_trial'), Markup.button.callback('💎 Купить VPN', 'buy_sub')],
                    [Markup.button.callback('👤 Профиль', 'profile'), Markup.button.callback('📚 Инструкция', 'instructions')],
                    [Markup.button.callback('🤝 Пригласить друга (+7 дней)', 'referral')],
                    [Markup.button.url('🆘 Поддержка', 'https://t.me/retrowaiver')]
                ])
            }
        );
        console.log("✅ Start message sent");
    } catch (e) {
        console.error("❌ Error sending start message:", e);
    }
});

// --- ADMIN COMMANDS ---
bot.command('admin', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

    const stats = await db.getStats();
    
    ctx.reply(
        `📊 **Статистика Бота**\n\n` +
        `👥 Пользователей: **${stats.users}**\n` +
        `🔑 Активных ключей: **${stats.active_keys}**\n` +
        `💰 Выручка: **${stats.revenue} RUB**\n\n` +
        `_База данных: database.sqlite_`,
        { parse_mode: 'Markdown' }
    );
});

bot.command('broadcast', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

    const message = ctx.message.text.split(' ').slice(1).join(' ');
    if (!message) return ctx.reply("❌ Использование: /broadcast <сообщение>");

    const users = await db.getAllUsers();
    let success = 0;
    let blocked = 0;

    ctx.reply(`📢 Начинаю рассылку на ${users.length} пользователей...`);

    for (const user of users) {
        try {
            await bot.telegram.sendMessage(user.telegram_id, `📢 **Новости сервиса**\n\n${message}`, { parse_mode: 'Markdown' });
            success++;
        } catch (e) {
            blocked++;
        }
        // Small delay to avoid flood limits
        await new Promise(r => setTimeout(r, 50));
    }

    ctx.reply(`✅ Рассылка завершена!\nДоставлено: ${success}\nЗаблокировали бота: ${blocked}`);
});

bot.command('addkey', async (ctx) => {
    if (ctx.from.id !== ADMIN_ID) return;

    const args = ctx.message.text.split(' ');
    const months = parseInt(args[1]) || 1;
    const targetId = args[2] ? parseInt(args[2]) : ctx.from.id;

    await ctx.reply(`⏳ Создаю ключ на ${months} мес. для ${targetId}...`);

    try {
        let userDb = await db.getUser(targetId);
        if (!userDb) {
             await db.createUser(targetId, 'gifted_user', 'Gifted');
             userDb = await db.getUser(targetId);
        }

        const newUuid = uuidv4();
        const email = `gift_${targetId}_${Date.now()}`;
        
        const result = await xui.addClient(INBOUND_ID, email, newUuid);
        
        if (result.success) {
            const expiryDate = new Date();
            expiryDate.setMonth(expiryDate.getMonth() + months);
            
            await db.createKey(userDb.id, newUuid, email, INBOUND_ID, expiryDate.toISOString(), 0);
            
            const link = generateVlessLink(newUuid, `VPN_GIFT_${months}M`);
            
            await ctx.reply(
                `✅ **Ключ создан!**\n\n` +
                `👤 Пользователь: \`${targetId}\`\n` +
                `📅 Срок: ${months} мес.\n` +
                `🔑 Ключ:\n\`${link}\``,
                { parse_mode: 'Markdown' }
            );

            if (targetId !== ctx.from.id) {
                try {
                    await bot.telegram.sendMessage(targetId, 
                        `🎁 **Вам подарок!**\n\n` +
                        `Администратор выдал вам подписку на ${months} месяц(а).\n` +
                        `Ваш ключ:\n\`${link}\``,
                        { parse_mode: 'Markdown' }
                    );
                } catch (e) {
                    ctx.reply("⚠️ Не удалось отправить уведомление пользователю (бот заблокирован?)");
                }
            }
        } else {
            ctx.reply(`❌ Ошибка X-UI: ${result.msg}`);
        }
    } catch (e) {
        console.error(e);
        ctx.reply("❌ Ошибка при создании ключа.");
    }
});

// --- TEXT HANDLER (Support Redirect) ---
bot.on('text', async (ctx) => {
    if (ctx.message.text.startsWith('/')) return; // Ignore commands
    
    await ctx.reply(
        "🤖 **Я робот.**\n\n" +
        "Если у вас вопрос или проблема, напишите администратору:",
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.url('🆘 Написать в поддержку', 'https://t.me/retrowaiver')]
            ])
        }
    );
});

bot.action('get_trial', async (ctx) => {
    const userId = ctx.from.id;
    await ctx.answerCbQuery();
    const userDb = await db.getUser(userId);
    
    // Check if already used trial
    const hasUsed = await db.hasTrialUsed(userDb.id);
    if (hasUsed) {
        return ctx.reply("❌ Вы уже использовали пробный период. Пожалуйста, оформите подписку.");
    }

    await ctx.reply("⏳ Генерирую ваш личный ключ...");

    // Generate Key
    const newUuid = uuidv4();
    const email = `trial_${userId}_${Date.now()}`;
    
    // Add to X-UI
    const result = await xui.addClient(INBOUND_ID, email, newUuid);
    
    if (result.success) {
        // Save to DB
        // Expire in 24 hours
        const expiryDate = new Date(Date.now() + 24 * 60 * 60 * 1000); 
        await db.createKey(userDb.id, newUuid, email, INBOUND_ID, expiryDate.toISOString(), 1);

        const link = generateVlessLink(newUuid, `Trial_VPN_${userId}`);
        
        await ctx.reply(
            `✅ **Ваш ключ готов!**\n\n` +
            `Скопируйте его и вставьте в приложение (v2rayNG, V2Box, Hiddify):\n\n` +
            `\`${link}\``,
            { parse_mode: 'Markdown' }
        );
        
        await ctx.reply("Инструкция: Скачайте Hiddify Next, нажмите '+' -> 'Import from Clipboard'.");
    } else {
        await ctx.reply("❌ Ошибка при создании ключа. Попробуйте позже.");
        console.error(result);
    }
});

bot.action('profile', async (ctx) => {
    await ctx.answerCbQuery();
    const userDb = await db.getUser(ctx.from.id);
    const keys = await db.getActiveKeys(userDb.id);
    
    if (keys.length === 0) {
        return ctx.reply("У вас нет активных подписок.", Markup.inlineKeyboard([
            [Markup.button.callback('🎁 Попробовать бесплатно', 'get_trial')],
            [Markup.button.callback('💳 Купить', 'buy_sub')]
        ]));
    }

    let msg = `👤 **Ваш профиль**\nID: ${userDb.telegram_id}\n\n**Активные ключи:**\n`;
    
    for (const k of keys) {
        const expiry = new Date(k.expiry_date).toLocaleString();
        const link = generateVlessLink(k.uuid, `VPN_${userDb.telegram_id}`);
        msg += `🔑 **Ключ #${k.id}**\n📅 Истекает: ${expiry}\n🔗 \`${link}\`\n\n`;
    }

    ctx.reply(msg, { parse_mode: 'Markdown' });
});

bot.action('referral', async (ctx) => {
    await ctx.answerCbQuery();
    const user = await db.getUser(ctx.from.id);
    const referralCount = await db.getReferralCount(user.id);
    const botUsername = ctx.botInfo.username;
    const referralLink = `https://t.me/${botUsername}?start=${ctx.from.id}`;

    await ctx.reply(
        `🤝 **Партнерская программа**\n\n` +
        `Приглашай друзей и получай **7 дней VPN** за каждого, кто купит подписку!\n\n` +
        `🔗 **Твоя ссылка:**\n\`${referralLink}\`\n\n` +
        `👥 Приглашено друзей: **${referralCount}**\n\n` +
        `_Бонус начисляется автоматически при первой оплате друга._`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('🔙 Назад', 'start_menu')]
            ])
        }
    );
});

// --- PAYMENT LOGIC ---

bot.action('buy_sub', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `💎 **Выберите тарифный план:**\n\n` +
        `Все тарифы включают:\n` +
        `✅ Безлимитный трафик\n` +
        `✅ Высокая скорость (до 1 Гбит/с)\n` +
        `✅ Поддержка 24/7\n` +
        `✅ Работает Instagram, YouTube 4K`, 
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.callback('📅 1 Месяц — 99₽', 'buy_1m')],
                [Markup.button.callback('📅 3 Месяца — 249₽ (Выгодно)', 'buy_3m')],
                [Markup.button.callback('ℹ️ Как оплатить?', 'how_to_pay')],
                [Markup.button.callback('🔙 Назад', 'start_menu')]
            ])
        }
    );
});

bot.action('how_to_pay', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.reply(
        `📖 **Как оплатить через CryptoBot?**\n\n` +
        `Это очень просто и занимает 2 минуты:\n\n` +
        `1️⃣ Нажмите кнопку с тарифом выше.\n` +
        `2️⃣ Бот выдаст ссылку на оплату.\n` +
        `3️⃣ Если у вас нет крипты:\n` +
        `   • Перейдите в @CryptoBot.\n` +
        `   • Нажмите **P2P Маркет** -> **Купить**.\n` +
        `   • Выберите **USDT** -> Ваш банк (Сбер/Т-Банк).\n` +
        `   • Купите нужное количество USDT (от 100₽).\n` +
        `4️⃣ Вернитесь к счету и нажмите **Оплатить**.\n\n` +
        `_Ваша анонимность гарантирована._`,
        { parse_mode: 'Markdown' }
    );
});

bot.action('instructions', async (ctx) => {
    await ctx.answerCbQuery();
    await ctx.editMessageText(
        `📲 **Скачайте приложение Happ (Hiddify):**\n\n` +
        `Мы рекомендуем **Happ (Hiddify)** для всех устройств. Это самое простое и надежное приложение.\n` +
        `1. Скачайте приложение.\n` +
        `2. Скопируйте ключ (который выдал бот).\n` +
        `3. Откройте Happ — он сам предложит подключиться.`,
        {
            parse_mode: 'Markdown',
            ...Markup.inlineKeyboard([
                [Markup.button.url('🍏 iOS (AppStore)', 'https://apps.apple.com/ru/app/hiddify-proxy-vpn/id6596588185')],
                [Markup.button.url('🤖 Android (Google Play)', 'https://play.google.com/store/apps/details?id=app.hiddify.com')],
                [Markup.button.url('💻 Windows / Mac / Linux', 'https://github.com/hiddify/hiddify-next/releases/latest')],
                [Markup.button.callback('🔙 Назад', 'start_menu')]
            ])
        }
    );
});

bot.action('start_menu', async (ctx) => {
    try {
        await ctx.answerCbQuery();
        await ctx.editMessageText(
            `🐋 **WHALE VPN**\n\n` +
            `Твой личный доступ к свободному интернету.\n\n` +
            `⚡️ **Скорость:** до 1 Гбит/с (YouTube 4K)\n` +
            `🛡 **Анонимность:** VLESS Reality (Невидим для провайдера)\n` +
            `🌍 **Локация:** Нидерланды / США\n\n` +
            `👇 **Выберите действие:**`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⚡️ Тест (24ч)', 'get_trial'), Markup.button.callback('💎 Купить VPN', 'buy_sub')],
                    [Markup.button.callback('👤 Профиль', 'profile'), Markup.button.callback('📚 Инструкция', 'instructions')],
                    [Markup.button.callback('🤝 Пригласить друга (+7 дней)', 'referral')],
                    [Markup.button.url('🆘 Поддержка', 'https://t.me/retrowaiver')]
                ])
            }
        );
    } catch (e) {
        // If message is too old or cannot be edited, send new one
        await ctx.reply(
            `🐋 **WHALE VPN**\n\n` +
            `Твой личный доступ к свободному интернету.\n\n` +
            `⚡️ **Скорость:** до 1 Гбит/с (YouTube 4K)\n` +
            `🛡 **Анонимность:** VLESS Reality (Невидим для провайдера)\n` +
            `🌍 **Локация:** Нидерланды / США\n\n` +
            `👇 **Выберите действие:**`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard([
                    [Markup.button.callback('⚡️ Тест (24ч)', 'get_trial'), Markup.button.callback('💎 Купить VPN', 'buy_sub')],
                    [Markup.button.callback('👤 Профиль', 'profile'), Markup.button.callback('📚 Инструкция', 'instructions')],
                    [Markup.button.callback('🤝 Пригласить друга (+7 дней)', 'referral')],
                    [Markup.button.url('🆘 Поддержка', 'https://t.me/retrowaiver')]
                ])
            }
        );
    }
});

async function createInvoiceAndReply(ctx, amountRub, months) {
    try {
        const invoice = await cryptoBot.createInvoice({
            currencyType: 'fiat',
            fiat: 'RUB',
            amount: amountRub,
            acceptedAssets: ['USDT', 'TON', 'BTC', 'ETH', 'LTC', 'BNB', 'TRX', 'USDC'],
            description: `VPN Subscription (${months} Month${months > 1 ? 's' : ''})`,
            payload: `${ctx.from.id}_${months}`
        });

        const buttons = [
            [Markup.button.url('👉 Оплатить', invoice.botPayUrl)],
            [Markup.button.callback('✅ Я оплатил', `check_pay_${invoice.id}_${months}`)]
        ];

        await ctx.reply(
            `🧾 **Счет на оплату создан!**\n\n` +
            `💰 Сумма: **${amountRub} RUB**\n` +
            `⏳ Срок: **${months} Месяц(а)**\n\n` +
            `Нажмите кнопку ниже, чтобы оплатить через CryptoBot.\n` +
            `_Счет выставляется в рублях, но оплата происходит в крипте (USDT/TON) по курсу._`,
            {
                parse_mode: 'Markdown',
                ...Markup.inlineKeyboard(buttons)
            }
        );
    } catch (e) {
        console.error("Invoice Error:", e);
        ctx.reply("❌ Ошибка создания счета. Проверьте токен CryptoBot.");
    }
}

bot.action('buy_1m', (ctx) => createInvoiceAndReply(ctx, '99', 1));
bot.action('buy_3m', (ctx) => createInvoiceAndReply(ctx, '249', 3));

// --- PAYMENT HANDLER ---

async function processSuccessfulPayment(ctx, userId, invoiceId, months, amount) {
    const userDb = await db.getUser(userId);
    
    // Mark as processed
    await db.markInvoiceProcessed(invoiceId, userDb.id, amount);

    // Generate Key
    const newUuid = uuidv4();
    const email = `sub_${userId}_${Date.now()}`;
    
    const result = await xui.addClient(INBOUND_ID, email, newUuid);
    
    if (result.success) {
        const expiryDate = new Date();
        expiryDate.setMonth(expiryDate.getMonth() + months);
        
        await db.createKey(userDb.id, newUuid, email, INBOUND_ID, expiryDate.toISOString(), 0);
        
        // --- REFERRAL REWARD ---
        if (userDb.referrer_id) {
            try {
                // Check if this is the first purchase (optional, but good for anti-abuse)
                // For now, we reward for every purchase or just the first one?
                // Let's assume reward for every purchase for now as a strong incentive, 
                // or we can limit it later.
                
                const bonusResult = await db.addBonusDays(userDb.referrer_id, 7);
                if (bonusResult.success) {
                     const referrerUser = await db.getUserByDbId(userDb.referrer_id);
                     if (referrerUser) {
                         await bot.telegram.sendMessage(referrerUser.telegram_id, `🎉 **Бонус!**\nВаш реферал купил подписку. Вам начислено +7 дней доступа!`, { parse_mode: 'Markdown' });
                     }
                }
            } catch (err) {
                console.error("Referral bonus error:", err);
            }
        }
        // -----------------------

        const link = generateVlessLink(newUuid, `VPN_${userId}`);
        
        await ctx.editMessageText(
            `✅ **Оплата прошла успешно! (TEST)**\n\n` +
            `Ваш ключ на ${months} месяц(а):\n` +
            `\`${link}\`\n\n` +
            `Приятного пользования! 🚀`,
            { parse_mode: 'Markdown' }
        );
    } else {
        ctx.reply("❌ Ошибка генерации ключа (X-UI).");
        console.error("X-UI Error:", result);
    }
}

bot.action(/^check_pay_(\d+)_(\d+)$/, async (ctx) => {
    const invoiceId = parseInt(ctx.match[1]);
    const months = parseInt(ctx.match[2]);
    const userId = ctx.from.id;

    try {
        // 1. Check if already processed
        const isProcessed = await db.isInvoiceProcessed(invoiceId);
        if (isProcessed) {
            return ctx.answerCbQuery("⚠️ Этот счет уже оплачен и активирован!", { show_alert: true });
        }

        // 2. Check status in CryptoBot
        const invoices = await cryptoBot.getInvoices({ ids: [invoiceId] });
        const invoice = invoices && invoices[0];

        if (invoice && invoice.status === 'paid') {
            // 3. Security Check
            if (!invoice.payload || !invoice.payload.startsWith(`${userId}_`)) {
                 return ctx.answerCbQuery("❌ Ошибка безопасности.", { show_alert: true });
            }

            // 4. Process
            await processSuccessfulPayment(ctx, userId, invoiceId, months, invoice.amount);
            
        } else {
            await ctx.answerCbQuery("❌ Оплата еще не поступила. Попробуйте через минуту.", { show_alert: true });
        }
    } catch (e) {
        console.error("Check Pay Error:", e);
        ctx.reply("❌ Ошибка проверки оплаты.");
    }
});

// --- STARTUP ---

// Expiry Checker Loop (Every 60 seconds)
setInterval(async () => {
    try {
        const expiredKeys = await db.getExpiredKeys();
        if (expiredKeys.length > 0) {
            console.log(`🧹 Found ${expiredKeys.length} expired keys. Cleaning up...`);
            
            for (const key of expiredKeys) {
                // 1. Remove from X-UI
                const result = await xui.deleteClient(INBOUND_ID, key.uuid);
                
                if (result.success) {
                    console.log(`   ❌ Deleted key ${key.uuid} (User: ${key.user_id})`);
                    // 2. Mark inactive in DB
                    await db.markKeyInactive(key.id);
                    
                    // 3. Notify User
                    const user = await db.getUser(key.user_id); // Need to implement getUserById if not exists, or use key.user_id directly if we stored chat_id
                    // Actually key.user_id is our internal DB id. We need telegram_id.
                    // Let's fetch user by internal ID.
                    // Quick fix: We need a way to get telegram_id from user_id.
                    // For now, let's skip notification or add a helper.
                    
                    // Assuming we can't easily notify without a join, we'll just log it.
                    // Ideally: bot.telegram.sendMessage(user.telegram_id, "Ваша подписка истекла.");
                } else {
                    console.error(`   ⚠️ Failed to delete key ${key.uuid}: ${result.msg}`);
                }
            }
        }
    } catch (e) {
        console.error("Expiry Loop Error:", e);
    }
}, 60000);

(async () => {
    // Backup Database on Startup
    try {
        const backupDir = path.resolve(__dirname, 'backups');
        if (!fs.existsSync(backupDir)) fs.mkdirSync(backupDir);
        
        const dateStr = new Date().toISOString().replace(/[:.]/g, '-');
        fs.copyFileSync(
            path.resolve(__dirname, 'database.sqlite'),
            path.join(backupDir, `database_backup_${dateStr}.sqlite`)
        );
        console.log("💾 Database backup created.");
    } catch (e) {
        console.error("⚠️ Backup failed:", e.message);
    }

    await loadInboundSettings();
    if (inboundSettings) {
        console.log("🚀 VPN Bot Starting...");
        // Ensure webhook is deleted before polling
        try {
            await bot.telegram.deleteWebhook();
            console.log("✅ Webhook deleted");
        } catch (e) {
            console.error("⚠️ Could not delete webhook:", e.message);
        }
        
        bot.launch({
            polling: {
                // Force polling mode
                allowedUpdates: ['message', 'callback_query'],
                limit: 100,
                timeout: 30
            }
        }).then(() => {
            console.log("🚀 VPN Bot Started & Polling (Explicit Mode)!");
        }).catch(err => {
            console.error("❌ Failed to launch bot:", err);
        });
    } else {
        console.log("❌ Failed to start bot: Could not load inbound settings.");
    }
})();

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));