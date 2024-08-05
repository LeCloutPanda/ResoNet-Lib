const {randomUUID, createHash, randomBytes} = require("crypto");
const signalR = require("@microsoft/signalr");

const API = "https://api.resonite.com/";
const ASSET_URL = "https://assets.resonite.com/"
const BADGES_URL = "https://gist.github.com/art0007i/018c94ee9c8701a8c2a0419599d80fbc/raw";
const KEY = "oi+ISZuYtMYtpruYHLQLPkXgPaD+IcaRNXPI7b3Z0iYe5+AcccouLYFI9vloMmYEYDlE1PhDL52GsddfxgQeK4Z_hem84t1OXGUdScFkLSMhJA2te86LBL_rFL4JjO4F_hHHIJH1Gm1IYVuvBQjpb89AJ0D6eamd7u4MxeWeEVE="
const MACHINEID = GenerateRandomMachineId();
const UID = GenerateUID();

function GenerateRandomMachineId(){
    let result = '';
    const characters = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_';
    for (let i = 0; i < 128; i++){
        result += characters.charAt(Math.floor(Math.random() * characters.length));
    }
    return result;
}

function GenerateUID(){ 
    let result = '';
    const data = `resonet-${randomBytes(16).toString('base64')}`;
    result = createHash('sha256').update(data).digest('hex').toUpperCase();
    return result;
}

class ResoNetLib {
    constructor(config) {
        this.config = {
            "username": config.username,
            "password": config.password,
            "TOTP": config.TOTP ?? ""
        }

        this.data = {
            "currentMachineID": MACHINEID,
            "sessionId": UID,
            "userId": "",
            "token": "",
            "fullToken": "",
            "tokenExpiry": "",
            "loggedIn": false
        }

        this.signalRConnection = undefined;
        this.log("Intializing Client.");
    }

    async start() {
        await this.login();
        await this.startSignalR();
    }
    
    async stop() {
        await this.logout();
        await this.stopSignalR();
    }

    async login() {   
        if (this.data.loggedIn) {
            this.error("Already logged in!");
        }

        const loginData = {
            "username": this.config.username,
            "authentication": {
                "$type": "password",
                "password": this.config.password
            },
            "rememberMe": false,
            "secretMachineId": this.data.currentMachineID
        };
    
        const res = await fetch(`${API}/userSessions`,
        {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Content-Length": JSON.stringify(loginData).length,
                "UID": UID,
                "TOTP": this.config.TOTP
            },
            body: JSON.stringify(loginData)
        });
    
        if (res.status === 200){
            const loginResponse = await res.json();
            this.data.userId = loginResponse.entity.userId;
            this.data.token = loginResponse.entity.token;
            this.data.fullToken = `res ${loginResponse.entity.userId}:${loginResponse.entity.token}`;
            this.data.tokenExpiry = loginResponse.entity.expire;
            this.data.loggedIn = true;
        }
        else {
            let response = await res.text();
            throw new Error(`Unexpected return code ${res.status}: ${response}`);
        }
    
        this.log("Successfully Logged in");
    }
    
    async logout() {
        const res = await fetch(`${API}/userSessions/${this.data.userId}/${this.data.token}`,
        {
            method: "DELETE",
            headers: {
                "Authorization": this.data.fullToken
            }
        });
    
        if (res.status !== 200){
            throw new Error(`Unexpected HTTP status when logging out (${res.status} ${res.statusText}): ${res.body}`);
        }
    
        this.data.loggedIn = false;
        this.data.fullToken = "";
        this.data.token = "";
        this.data.userId = "";
    }
    
    async startSignalR() {
        this.signalRConnection = new signalR.HubConnectionBuilder()
        .withUrl(`${API}/hub`, {
            headers: {
                "Authorization": this.data.fullToken,
                "UID": this.data.currentMachineID,
                "SecretClientAccessKey": KEY
            }
        })
        .withAutomaticReconnect()
        .configureLogging(signalR.LogLevel.Critical)
        .build();

        this.signalRConnection.start();
        this.log("Starting SignalR");
    }
    
    async stopSignalR() {
        await this.signalRConnection.stop();
        this.signalRConnection = undefined;
        this.log("Stopping SignalR.");
    }

    async fetchUser(userid) {
        let url = `${API}users/${userid}` + (userid.startsWith('U-') ? "" : "?byusername=true");
        this.log(`Fetching user data for "${userid}"`);
        const res = await fetch(url);

        if (res.ok) {
            const json = await res.json();
            return json;
        } else {
            const text = await res.text();
            return text;
        }
    }

    async fetchUsers(query) {
        var apiUrl = ""
        if (query.startsWith("U-")) apiUrl = `${API}/users/${query}`;
        else apiUrl = `${API}/users?name=${query}`;
        
        this.log(`Fetching users with name of "${query}"`);
        const res = await fetch(apiUrl);

        if (res.ok) {
            const json = await res.json();
            return json;
        } else {
            const text = await res.text();
            return text;
        }
    }

    async addFriend(userid) {
        if (!userid.startsWith("U-")) {
            this.error("Not a valid user id!");
        }

        this.log(`Attemping to add user ${userid} as a contact`);

        const user = await this.fetchUser(userid);
        const contactData = {
            "ownerId": this.data.userId,
            "id": user.id,
            "contactUsername": user.username,
            "contactStatus": "Accepted"
        };

        await this.signalRConnection.send("UpdateContact", contactData).then(() => {
            this.log(`Successfully added user ${userid} as a contact`);
        }).catch(async (error) => {
            this.error(error);
        });
    }
    
    async removeFriend(userid) {
        if (!this.data.loggedIn) {
            this.error("Not logged in! Can't remove friend.");
        }

        if (!userid.startsWith("U-")) {
            this.error("Not a valid user id!");
        }

        this.log(`Attemping to remove user ${userid} as a contact`);

        await fetch(`${API}/users/${this.data.userId}/friends/${userid}`,
        {
            method: "DELETE",
            headers: {
                "Authorization": this.data.fullToken
            }
        }).catch(async (error) => {
            this.error(error);
        });

        const contact = this.getContact(userid);
        contact.contactStatus = "Ignored";
    
        await this.signalRConnection.send("UpdateContact", contact).then(() => {
            this.log(`Successfully removed user ${userid} as a contact`);
        }).catch(async (error) => {
            this.error(error);
        });
    }

    async getContact(userid) {
        if (!userid.startsWith("U-")) {
            this.error("Failed to get contact, Invalid UserID.");
        }
        
        const contacts = await this.fetchContacts();
        const contact = contacts.find(contact => contact.id === userid);
        
        if (contact == null) {
            this.error("No vaid contact found.");
        }
        
        return contact;
    }

    async blockuser(user) {
        // TODO: finish implmenting this function
        this.error("Not implemented yet.")
    }

    async sendRawMessage(messageData){
        await this.signalRConnection.send("SendMessage", messageData).catch(async (error) => {
            this.error(error);
        });
    }

    async sendTextMessage(userid, content) {
        if (!userid.startsWith('U-')) {
            this.error("UserId is not a user id.")
            return;
        } else if (content.trim() == "") {
            this.error("Content is null");
            return;
        }

        const messageData = {
            "id": `MSG-${randomUUID()}`,
            "senderId": this.data.userId,
            "recipientId": userid,
            "messageType": "Text",
            "sendTime": (new Date(Date.now())).toISOString(),
            "lastUpdateTime": (new Date(Date.now())).toISOString(),
            "content": content
        }

        await this.signalRConnection.send("SendMessage", messageData).catch(async (error) => {
            this.error(error);
        });
    }

    async fetchContacts() {
        const res = await fetch(`${API}/users/${this.data.userId}/contacts`, {headers: {"Authorization": this.data.fullToken}});
        let json = await res.json();      
        return json;
    }

    formatIconUrl(url) {
        try {
            return url.replace('resdb://', ASSET_URL).replace('.webp', '').replace('.png', '');
        }
        catch {
            return 'INVALID_URL';
        }
    }

    log(message) {
        console.log(`[${Date.now()} INFO] ${message}`);
    }
    
    warning(message) {
        console.warn(`[${Date.now()} WARN] ${message}`);
    }
    
    error(message) {
        console.error(`[${Date.now()} ERROR] ${message}`);
    }
}
module.exports = ResoNetLib;