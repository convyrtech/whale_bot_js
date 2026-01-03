const { Telegraf } = require('telegraf');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

const bot = new Telegraf(process.env.BOT_TOKEN);

async function check() {
    try {
        console.log("Checking bot connection...");
        const me = await bot.telegram.getMe();
        console.log("✅ Bot Info:", me);
        
        console.log("Deleting webhook...");
        await bot.telegram.deleteWebhook();
        console.log("✅ Webhook deleted. Polling should work now.");
        
    } catch (e) {
        console.error("❌ Connection Error:", e.message);
        if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT') {
            console.error("⚠️ It seems Telegram API is blocked or unreachable.");
        }
    }
}

check();