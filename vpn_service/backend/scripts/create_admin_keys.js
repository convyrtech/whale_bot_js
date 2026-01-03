const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const { v4: uuidv4 } = require('uuid');
const db = require('../database');
const XuiApi = require('../xui_api');

const INBOUND_ID = parseInt(process.env.INBOUND_ID || 1);
const SERVER_IP = process.env.XUI_URL.split('//')[1].split(':')[0];

// Mock inbound settings for link generation (since we can't load async in top level easily without init)
// We will fetch them in main
let inboundSettings = null;

async function getSettings(xui) {
    const inbounds = await xui.getInbounds();
    const target = inbounds.find(i => i.id === INBOUND_ID);
    if (target) {
        const streamSettings = JSON.parse(target.streamSettings);
        const realitySettings = streamSettings.realitySettings;
        return {
            port: target.port,
            publicKey: realitySettings.settings.publicKey,
            serverName: realitySettings.serverNames[0],
            shortId: realitySettings.shortIds[0],
            fingerprint: realitySettings.settings.fingerprint || 'chrome'
        };
    }
    return null;
}

function generateLink(uuid, name, settings) {
    const params = new URLSearchParams({
        type: 'tcp',
        security: 'reality',
        pbk: settings.publicKey,
        fp: settings.fingerprint,
        sni: settings.serverName,
        sid: settings.shortId,
        spx: '/',
        flow: 'xtls-rprx-vision'
    });
    return `vless://${uuid}@${SERVER_IP}:${settings.port}?${params.toString()}#${encodeURIComponent(name)}`;
}

async function createVipKey(xui, name) {
    const uuid = uuidv4();
    const email = `admin_${name}_${Date.now()}`;
    
    // expiryTime: 0 means UNLIMITED in X-UI
    // limitIp: 0 means UNLIMITED devices
    const client = {
        id: uuid,
        email: email,
        flow: "xtls-rprx-vision",
        limitIp: 0, 
        totalGB: 0,
        expiryTime: 0, 
        enable: true,
        tgId: "",
        subId: ""
    };

    const settings = { clients: [client] };
    
    console.log(`Creating VIP key for ${name}...`);
    const res = await xui.client.post('xui/api/inbounds/addClient', {
        id: INBOUND_ID,
        settings: JSON.stringify(settings)
    });

    if (res.data && res.data.success) {
        // Save to DB with year 2099
        // We use a dummy user_id 0 for admins if they aren't in DB, or we can just skip DB for personal use.
        // But let's add to DB so the bot doesn't delete them if we ever run a cleanup script that checks X-UI vs DB.
        // Actually, our cleanup script only checks DB expired keys. So if we don't add to DB, it's safe from cleanup.
        // BUT, let's add to DB for record keeping.
        
        // We'll assume user_id 1 (You) for both, or just create a dummy record.
        await db.createKey(1, uuid, email, INBOUND_ID, '2099-12-31T23:59:59.000Z', 0);
        return uuid;
    } else {
        console.error(`Failed to create key: ${res.data?.msg}`);
        return null;
    }
}

async function main() {
    const xui = new XuiApi(process.env.XUI_URL, process.env.XUI_USERNAME, process.env.XUI_PASSWORD);
    const login = await xui.login();
    
    if (!login) {
        console.log("Login failed");
        return;
    }

    const settings = await getSettings(xui);
    if (!settings) {
        console.log("Could not load inbound settings");
        return;
    }

    // 1. Key for YOU
    const uuid1 = await createVipKey(xui, "OWNER");
    if (uuid1) {
        console.log("\n👑 **OWNER KEY (Для тебя):**");
        console.log(generateLink(uuid1, "MY_VIP_VPN", settings));
    }

    // 2. Key for FRIEND
    const uuid2 = await createVipKey(xui, "FRIEND");
    if (uuid2) {
        console.log("\n🤝 **FRIEND KEY (Для друга):**");
        console.log(generateLink(uuid2, "FRIEND_VIP_VPN", settings));
    }
}

main();