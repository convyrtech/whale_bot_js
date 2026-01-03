const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const axios = require('axios');
const { v4: uuidv4 } = require('uuid');

async function testAddClientPaths() {
    const baseUrl = process.env.XUI_URL.endsWith('/') ? process.env.XUI_URL : process.env.XUI_URL + '/';
    console.log(`Base URL: ${baseUrl}`);

    const client = axios.create({
        baseURL: baseUrl,
        withCredentials: true,
        headers: { 'Content-Type': 'application/json' }
    });

    // 1. Login
    try {
        const loginRes = await client.post('login', {
            username: process.env.XUI_USERNAME,
            password: process.env.XUI_PASSWORD
        });
        
        if (loginRes.data.success) {
            console.log("✅ Login OK");
            const cookies = loginRes.headers['set-cookie'];
            client.defaults.headers.Cookie = cookies.map(c => c.split(';')[0]).join('; ');
        } else {
            console.log("❌ Login Failed");
            return;
        }
    } catch (e) {
        console.log("❌ Login Error:", e.message);
        return;
    }

    // 2. Prepare Payload
    const uuid = uuidv4();
    const email = `debug_${Date.now()}`;
    const inboundId = parseInt(process.env.INBOUND_ID || 1);
    
    const clientData = {
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

    const settings = {
        clients: [clientData]
    };

    const payload = {
        id: inboundId,
        settings: JSON.stringify(settings)
    };

    // 3. Test Paths
    const paths = [
        'panel/api/inbounds/addClient',
        'xui/api/inbounds/addClient',
        'api/inbounds/addClient',
        'panel/inbound/addClient',
        'server/inbounds/addClient'
    ];

    for (const p of paths) {
        try {
            console.log(`Testing POST ${p}...`);
            const res = await client.post(p, payload);
            console.log(`   ✅ Status: ${res.status}, Success: ${res.data?.success}, Msg: ${res.data?.msg}`);
            if (res.data?.success) {
                console.log("   🎉 FOUND IT!");
                break;
            }
        } catch (e) {
            console.log(`   ❌ Error: ${e.message} (Status: ${e.response?.status})`);
        }
    }
}

testAddClientPaths();