const path = require('path');
require('dotenv').config({ path: path.resolve(__dirname, '../.env') });
const axios = require('axios');

async function testPaths() {
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

    // 2. Test Paths
    const paths = [
        'panel/api/inbounds/list',
        'xui/api/inbounds/list',
        'api/inbounds/list',
        'panel/inbound/list',
        'server/status'
    ];

    for (const p of paths) {
        try {
            console.log(`Testing POST ${p}...`);
            const res = await client.post(p, {});
            console.log(`   ✅ Status: ${res.status}, Success: ${res.data?.success}`);
        } catch (e) {
            console.log(`   ❌ Error: ${e.message} (Status: ${e.response?.status})`);
        }
    }
}

testPaths();