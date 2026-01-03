const axios = require('axios');
const qs = require('qs');

class XuiApi {
    constructor(url, username, password) {
        // Ensure URL ends with slash for correct relative path resolution
        this.url = url.endsWith('/') ? url : url + '/';
        this.username = username;
        this.password = password;
        this.cookie = null;
        
        this.client = axios.create({
            baseURL: this.url,
            withCredentials: true,
            headers: {
                'Content-Type': 'application/json',
                'Accept': 'application/json'
            }
        });
    }

    async login() {
        try {
            const loginData = {
                username: this.username,
                password: this.password
            };
            
            // Use relative path 'login' so it appends to baseURL (which includes the subpath)
            const response = await this.client.post('login', loginData);
            
            if (response.data && response.data.success) {
                // Extract cookie
                const cookies = response.headers['set-cookie'];
                if (cookies) {
                    this.cookie = cookies.map(c => c.split(';')[0]).join('; ');
                    this.client.defaults.headers.Cookie = this.cookie;
                    return true;
                }
            }
            console.error("Login failed:", response.data);
            return false;
        } catch (error) {
            console.error("Login error:", error.message);
            return false;
        }
    }

    async getInbounds() {
        if (!this.cookie) await this.login();
        try {
            // Use relative path (Found via debug: xui/api/inbounds/list)
            // UPDATE: It seems some versions mix paths. Let's try 'panel/api/inbounds/list' first, then fallback?
            // Actually, let's stick to what worked for list: 'xui/api/inbounds/list'
            // BUT, addClient worked on 'panel/api/inbounds/addClient'.
            // This is messy. Let's try to standardize on 'panel/api' if possible, or handle both.
            
            let response;
            try {
                response = await this.client.post('panel/api/inbounds/list');
            } catch (e) {
                response = await this.client.post('xui/api/inbounds/list');
            }

            if (response.data && response.data.success) {
                return response.data.obj;
            }
            return [];
        } catch (error) {
            console.error("Get Inbounds error:", error.message);
            return [];
        }
    }

    async addClient(inboundId, email, uuid) {
        if (!this.cookie) await this.login();
        
        // Structure for VLESS client in 3x-ui
        const client = {
            id: uuid,
            email: email,
            flow: "xtls-rprx-vision", // Standard for Reality
            limitIp: 5, // Anti-Abuse: Max 5 devices per key
            totalGB: 0,
            expiryTime: 0,
            enable: true,
            tgId: "",
            subId: ""
        };

        const settings = {
            clients: [client]
        };

        try {
            // Use relative path. Debug confirmed 'panel/api/inbounds/addClient' works.
            const response = await this.client.post('panel/api/inbounds/addClient', {
                id: inboundId,
                settings: JSON.stringify(settings)
            });
            
            return response.data;
        } catch (error) {
            console.error("Add Client error:", error.message);
            // Fallback to xui/api just in case
            try {
                const response = await this.client.post('xui/api/inbounds/addClient', {
                    id: inboundId,
                    settings: JSON.stringify(settings)
                });
                return response.data;
            } catch (e2) {
                return { success: false, msg: error.message + " | " + e2.message };
            }
        }
    }

    async deleteClient(inboundId, uuid) {
        if (!this.cookie) await this.login();
        try {
            // 3x-ui delete client endpoint
            // Try panel/api first
            try {
                const response = await this.client.post(`panel/api/inbounds/${inboundId}/delClient/${uuid}`);
                return response.data;
            } catch (e) {
                const response = await this.client.post(`xui/api/inbounds/${inboundId}/delClient/${uuid}`);
                return response.data;
            }
        } catch (error) {
            console.error("Delete Client error:", error.message);
            return { success: false, msg: error.message };
        }
    }
}

module.exports = XuiApi;