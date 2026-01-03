const { Telegraf } = require('telegraf');
const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });

console.log("🛠️ Starting DEBUG BOT...");
console.log("Token:", process.env.BOT_TOKEN);

const bot = new Telegraf(process.env.BOT_TOKEN);

bot.use((ctx, next) => {
    console.log("📩 Update:", ctx.updateType);
    return next();
});

bot.start((ctx) => {
    console.log("▶️ /start received");
    ctx.reply("✅ DEBUG BOT IS WORKING");
});

bot.on('message', (ctx) => {
    console.log("💬 Message:", ctx.message.text);
    ctx.reply("Echo: " + ctx.message.text);
});

bot.launch().then(() => {
    console.log("🚀 Debug Bot Launched");
}).catch(e => {
    console.error("❌ Launch Error:", e);
});

// Enable graceful stop
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));