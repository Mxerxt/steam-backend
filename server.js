const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const axios = require('axios');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// Wichtig für Render (Reverse Proxy)
app.set('trust proxy', 1);

// Feste Live-URL, damit Steam-Return und Realm zu 100% übereinstimmen
const HOST_URL = process.env.RENDER_EXTERNAL_URL || 'https://steam-backend-88lk.onrender.com';
const STEAM_API_KEY = process.env.STEAM_API_KEY || '';
const TWITCH_CLIENT_ID = process.env.TWITCH_CLIENT_ID || '';
const TWITCH_CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET || '';

app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

app.use(session({
    secret: 'steam_app_super_secret_key_99',
    resave: false,
    saveUninitialized: false,
    proxy: true,
    cookie: { 
        secure: true, 
        sameSite: 'lax' 
    }
}));

app.use(passport.initialize());
app.use(passport.session());

// Statische Dateien ausliefern
app.use(express.static(__dirname));

// Passport Steam Setup
if (STEAM_API_KEY) {
    passport.use(new SteamStrategy({
        returnURL: `${HOST_URL}/auth/steam/return`,
        realm: `${HOST_URL}/`,
        apiKey: STEAM_API_KEY
      },
      function(identifier, profile, done) {
        profile.identifier = identifier;
        return done(null, profile);
      }
    ));
}

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(obj));

// 1. Steam Login Route
app.get('/auth/steam', (req, res, next) => {
    if (!STEAM_API_KEY) {
        return res.status(500).send('Fehler: STEAM_API_KEY ist auf dem Server nicht konfiguriert!');
    }
    passport.authenticate('steam')(req, res, next);
});

// 2. Steam Callback Route
app.get('/auth/steam/return', 
    passport.authenticate('steam', { failureRedirect: '/' }),
    (req, res) => {
        res.redirect(`/?steamid=${req.user.id}&name=${encodeURIComponent(req.user.displayName)}`);
    }
);

// 3. API-Route: Eingeloggten Nutzer abrufen
app.get('/api/user', (req, res) => {
    if (!req.isAuthenticated()) {
        return res.json({ loggedIn: false });
    }
    res.json({ loggedIn: true, user: req.user });
});

// 4. API-Route: Originale Steam-Erfolge
app.get('/api/achievements', async (req, res) => {
    const { steamid, appid } = req.query;
    if (!steamid || !appid) {
        return res.status(400).json({ error: 'steamid und appid werden benötigt' });
    }
    if (!STEAM_API_KEY) {
        return res.status(500).json({ error: 'STEAM_API_KEY fehlt auf dem Server' });
    }
    try {
        const response = await axios.get(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?appid=${appid}&key=${STEAM_API_KEY}&steamid=${steamid}`);
        res.json(response.data);
    } catch (error) {
        res.status(500).json({ error: 'Fehler beim Abrufen der Steam-Erfolge' });
    }
});

// 5. API-Route: IGDB & Twitch Proxy
app.post('/api/igdb', async (req, res) => {
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
        return res.status(500).json({ error: 'Twitch API Credentials sind auf dem Server nicht konfiguriert.' });
    }

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

            const gameRes = await axios.get(`https://api.twitch.tv/helix/games?name=${encodeURIComponent(gameName)}`, {
                headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${accessToken}` }
            });
            if (!gameRes.data.data || gameRes.data.data.length === 0) {
                return res.json({ viewers: 0, streams: 0 });
            }
            const twitchGameId = gameRes.data.data[0].id;
            const streamsRes = await axios.get(`https://api.twitch.tv/helix/streams?game_id=${twitchGameId}&first=100`, {
                headers: { 'Client-ID': TWITCH_CLIENT_ID, 'Authorization': `Bearer ${accessToken}` }
            });
            let totalViewers = 0;
            let activeStreams = 0;
            if (streamsRes.data.data) {
                activeStreams = streamsRes.data.data.length;
                totalViewers = streamsRes.data.data.reduce((sum, s) => sum + s.viewer_count, 0);
            }
            return res.json({ viewers: totalViewers, streams: activeStreams });
        }

        let query = 'fields name, summary, cover.url, rating, genres.name, platforms.name, first_release_date; sort rating desc; limit 20;';
        if (bodyData.query) {
            query = bodyData.query;
        } else if (typeof req.body === 'string' && req.body.trim().startsWith('fields')) {
            query = query;
        }

        const igdbRes = await axios.post('https://api.igdb.com/v4/games', query, {
            headers: {
                'Client-ID': TWITCH_CLIENT_ID,
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'text/plain',
            }
        });

        res.json(igdbRes.data);
    } catch (error) {
        console.error('IGDB Error:', error.response?.data || error.message);
        res.status(500).json({ error: error.message });
    }
});

app.listen(PORT, () => {
    console.log(`Server läuft auf Port ${PORT}`);
});
