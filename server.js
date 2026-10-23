const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const axios = require('axios');
const path = require('path');
const sqlite3 = require('sqlite3').verbose();
const bcrypt = require('bcrypt');

const app = express();
const PORT = process.env.PORT || 3000;

app.set('trust proxy', 1);

const HOST_URL = process.env.RENDER_EXTERNAL_URL || 'https://steam-backend-88lk.onrender.com';
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';

const db = new sqlite3.Database('./database.sqlite', (err) => {
    if (err) console.error('Fehler beim Öffnen der Datenbank:', err.message);
    else console.log('Verbunden mit der SQLite-Datenbank.');
});

db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE,
        password TEXT,
        steam_id TEXT,
        steam_name TEXT
    )`);
});

app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'steam_app_super_secret_key_99',
    resave: false,
    saveUninitialized: false,
    cookie: { secure: false }
}));

app.use(passport.initialize());
app.use(passport.session());
app.use(express.static(__dirname));

if (STEAM_API_KEY) {
    passport.use(new SteamStrategy({
        returnURL: `${HOST_URL}/auth/steam/return`,
        realm: `${HOST_URL}/`,
        apiKey: STEAM_API_KEY,
        passReqToCallback: true
    },
    async function(req, identifier, profile, done) {
        const localUserId = req.session.localUserId; 
        if (!localUserId) {
             return done(null, false, { message: 'Bitte zuerst lokal anmelden.' });
        }
        db.run(`UPDATE users SET steam_id = ?, steam_name = ? WHERE id = ?`, 
            [profile.id, profile.displayName, localUserId], 
            function(err) {
                if (err) return done(err);
                const userObj = {
                    id: localUserId,
                    steamId: profile.id,
                    steamName: profile.displayName
                };
                return done(null, userObj);
            }
        );
    }));
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.post('/auth/register', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });

    try {
        const hashedPassword = await bcrypt.hash(password, 10);
        db.run(`INSERT INTO users (username, password) VALUES (?, ?)`, [username, hashedPassword], function(err) {
            if (err) {
                if (err.message.includes('UNIQUE constraint failed')) {
                    return res.status(400).json({ error: 'Benutzername existiert bereits.' });
                }
                return res.status(500).json({ error: 'Fehler bei der Registrierung.' });
            }
            req.session.localUserId = this.lastID;
            res.json({ success: true, userId: this.lastID, username: username });
        });
    } catch (e) {
        res.status(500).json({ error: 'Serverfehler.' });
    }
});

app.post('/auth/login', (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Benutzername und Passwort erforderlich.' });

    db.get(`SELECT * FROM users WHERE username = ?`, [username], async (err, user) => {
        if (err) return res.status(500).json({ error: 'Datenbankfehler.' });
        if (!user) return res.status(401).json({ error: 'Benutzer nicht gefunden.' });

        const match = await bcrypt.compare(password, user.password);
        if (!match) return res.status(401).json({ error: 'Falsches Passwort.' });

        req.session.localUserId = user.id;
        res.json({ 
            success: true, 
            userId: user.id, 
            username: user.username,
            steamId: user.steam_id,
            steamName: user.steam_name
        });
    });
});

app.post('/auth/logout', (req, res) => {
    req.session.destroy();
    res.json({ success: true });
});

app.post('/auth/steam/unlink', (req, res) => {
    if (!req.session.localUserId) return res.status(401).json({ error: 'Nicht angemeldet.' });
    
    db.run(`UPDATE users SET steam_id = NULL, steam_name = NULL WHERE id = ?`, [req.session.localUserId], (err) => {
        if (err) return res.status(500).json({ error: 'Fehler beim Trennen.' });
        res.json({ success: true });
    });
});

app.get('/auth/steam', (req, res, next) => {
    if (!STEAM_API_KEY) return res.status(500).send('Fehler: STEAM_API_KEY fehlt!');
    if (!req.session.localUserId) return res.status(401).send('Bitte logge dich zuerst in der App ein.');
    passport.authenticate('steam')(req, res, next);
});

app.get('/auth/steam/return', 
    passport.authenticate('steam', { failureRedirect: '/?error=steam_failed' }),
    (req, res) => {
        res.redirect(`/?steam_linked=true&steamid=${req.user.steamId}&steamname=${encodeURIComponent(req.user.steamName)}`);
    }
);

app.get('/api/achievements', async (req, res) => {
    const { steamid, appid } = req.query;
    if (!steamid || !appid) return res.status(400).json({ error: 'steamid und appid fehlen' });
    if (!STEAM_API_KEY) return res.status(500).json({ error: 'STEAM_API_KEY fehlt' });
    
    try {
        const response = await axios.get(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?appid=${appid}&key=${STEAM_API_KEY}&steamid=${steamid}`);
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Fehler beim Abrufen der Steam-Erfolge' });
    }
});

app.post('/api/igdb', async (req, res) => {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) return res.status(500).json({ error: 'Twitch Credentials fehlen.' });
    try {
        const tokenRes = await axios.post(`https://id.twitch.tv/oauth2/token?client_id=${TWITCH_CLIENT_ID}&client_secret=${TWITCH_CLIENT_SECRET}&grant_type=client_credentials`);
        const accessToken = tokenRes.data.access_token;
        let bodyData = {};
        
        if (typeof req.body === 'string') {
            try { bodyData = JSON.parse(req.body); } catch (e) { bodyData = { query: req.body }; }
        } else { 
            bodyData = req.body || {}; 
        }

        if (bodyData.action === 'twitch_viewers') {
            const gameName = bodyData.gameName;
            if (!gameName) return res.json({ viewers: 0, streams: 0 });
            
            const gameRes = await axios.get(`https://api.twitch.tv/helix/games?name=${encodeURIComponent(gameName)}`, { headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${accessToken}` } });
            if (!gameRes.data.data || gameRes.data.data.length === 0) return res.json({ viewers: 0, streams: 0 });
            
            const twitchGameId = gameRes.data.data[0].id;
            const streamsRes = await axios.get(`https://api.twitch.tv/helix/streams?game_id=${twitchGameId}&first=100`, { headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${accessToken}` } });
            
            let totalViewers = 0, activeStreams = 0;
            if (streamsRes.data.data) {
                activeStreams = streamsRes.data.data.length;
                totalViewers = streamsRes.data.data.reduce((sum, s) => sum + s.viewer_count, 0);
            }
            return res.json({ viewers: totalViewers, streams: activeStreams });
        }

        let query = 'fields name, summary, cover.url, rating, genres.name, platforms.name, first_release_date; sort rating desc; limit 20;';
        if (bodyData.query) query = bodyData.query;
        else if (typeof req.body === 'string' && req.body.trim().startsWith('fields')) query = req.body;

        const igdbRes = await axios.post('https://api.igdb.com/v4/games', query, {
            headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'text/plain' }
        });
        res.json(igdbRes.data);
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => console.log(`Server laeuft auf Port ${PORT}`));
