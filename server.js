const express = require('express');
const session = require('express-session');
const passport = require('passport');
const SteamStrategy = require('passport-steam').Strategy;
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// WICHTIG: Ersetze dies später durch deine echte Server-URL (z.B. von Render/Railway) oder deine Domain
const HOST_URL = process.env.HOST_URL || `http://localhost:${PORT}`;
// Deinen kostenlosen Steam Web API Key trägst du hier ein (bekommst du auf https://steamcommunity.com/dev/apikey)
const STEAM_API_KEY = process.env.STEAM_API_KEY || 'DEIN_STEAM_API_KEY_HIER';

// Passport Steam Setup
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

passport.serializeUser((user, done) => done(null, user));
passport.deserializeUser((obj, done) => done(null, obj));

app.use(session({ secret: 'geheimer_schluessel_hier', resave: false, saveUninitialized: true }));
app.use(passport.initialize());
app.use(passport.session());

// 1. Steam Login Route
app.get('/auth/steam', passport.authenticate('steam', { failureRedirect: '/' }));

// 2. Steam Callback Route (Nach erfolgreichem Login)
app.get('/auth/steam/return', 
  passport.authenticate('steam', { failureRedirect: '/' }),
  (req, res) => {
    // Nach erfolgreichem Login leiten wir den Nutzer zurück zu unserer Web-App mit seiner SteamID
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

// 4. API-Route: Originale Steam-Erfolge für ein Spiel abrufen
app.get('/api/achievements', async (req, res) => {
  const { steamid, appid } = req.query;
  if (!steamid || !appid) {
    return res.status(400).json({ error: 'steamid und appid werden benötigt' });
  }

  try {
    const response = await axios.get(`https://api.steampowered.com/ISteamUserStats/GetPlayerAchievements/v0001/?appid=${appid}&key=${STEAM_API_KEY}&steamid=${steamid}`);
    res.json(response.data);
  } catch (error) {
    res.status(500).json({ error: 'Fehler beim Abrufen der Steam-Erfolge (Profil evtl. privat oder falsche AppID)' });
  }
});

app.listen(PORT, () => {
  console.log(`Server läuft auf Port ${PORT}`);
});