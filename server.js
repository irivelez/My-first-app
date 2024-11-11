const express = require('express');
const path = require('path');
const dotenv = require('dotenv');
const axios = require('axios');
const session = require('express-session');
const MemoryStore = require('memorystore')(session);

// Load environment variables
dotenv.config();

const app = express();

// Set up session middleware
app.use(session({
    cookie: { maxAge: 86400000 }, // 24 hours
    store: new MemoryStore({
        checkPeriod: 86400000 // prune expired entries every 24h
    }),
    secret: 'spotify-auth-secret',
    resave: false,
    saveUninitialized: false
}));

// Serve static files from public directory
app.use(express.static('public'));

// Spotify OAuth configuration
const spotifyConfig = {
    clientId: process.env.CLIENT_ID,
    clientSecret: process.env.CLIENT_SECRET,
    callbackURL: process.env.CALLBACK_URL
};

let accessToken = null; // Store access token globally

// Function to insert playlist data into HTML
function insertPlaylistsToHTML(playlists) {
    const container = document.querySelector('.container');
    const playlistsHTML = playlists.items.map(playlist => `
        <div class="section">
            <img src="${playlist.images[0].url}" alt="${playlist.name}" style="width: 200px; height: 200px; object-fit: cover;">
            <h2>${playlist.name}</h2>
            <p>${playlist.description}</p>
        </div>
    `).join('');
    container.innerHTML = playlistsHTML;
}

// Add logging middleware at the top of your routes
app.use((req, res, next) => {
    console.log('Incoming request:', req.method, req.path, req.query);
    next();
});

// Spotify OAuth routes
app.get('/auth/spotify', (req, res) => {
    console.log('Auth route hit - generating Spotify auth URL');
    
    // Generate a random state value for security
    const state = Math.random().toString(36).substring(7);
    req.session.state = state;

    const scopes = [
        'user-read-private',
        'user-read-email',
        'playlist-read-private',
        'playlist-read-collaborative',
        'user-top-read'
    ];
    
    const authUrl = `https://accounts.spotify.com/authorize?response_type=code&client_id=${process.env.CLIENT_ID}&redirect_uri=${encodeURIComponent(process.env.CALLBACK_URL)}&scope=${encodeURIComponent(scopes.join(' '))}&state=${state}`;
    
    console.log('Redirecting to:', authUrl);
    res.redirect(authUrl);
});

app.get('/callback', async (req, res) => {
    console.log('=== Callback Route Hit ===');
    console.log('Full URL:', req.protocol + '://' + req.get('host') + req.originalUrl);
    console.log('Query:', req.query);
    console.log('Session:', req.session);

    const { code, state } = req.query;

    if (!code || !state) {
        console.error('Missing parameters:', { code: !!code, state: !!state });
        return res.redirect('/?error=missing_params');
    }

    try {
        console.log('Attempting token exchange...');
        const tokenUrl = 'https://accounts.spotify.com/api/token';
        const tokenData = new URLSearchParams({
            grant_type: 'authorization_code',
            code,
            redirect_uri: process.env.CALLBACK_URL
        }).toString();

        console.log('Token exchange parameters:', {
            redirectUri: process.env.CALLBACK_URL,
            code: code.substring(0, 10) + '...' // Log only part of the code for security
        });

        const tokenResponse = await axios.post(tokenUrl, tokenData, {
            headers: {
                'Authorization': 'Basic ' + Buffer.from(process.env.CLIENT_ID + ':' + process.env.CLIENT_SECRET).toString('base64'),
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });

        console.log('Token exchange successful');
        req.session.accessToken = tokenResponse.data.access_token;
        accessToken = tokenResponse.data.access_token;

        res.redirect('/');
    } catch (error) {
        console.error('Token exchange error:', {
            message: error.message,
            data: error.response?.data,
            status: error.response?.status
        });
        res.redirect('/?error=auth_failed');
    }
});

// Refresh token route
app.get('/refresh_token', async (req, res) => {
    if (!req.session.refreshToken) {
        return res.status(401).json({ error: 'No refresh token' });
    }

    try {
        const response = await axios.post('https://accounts.spotify.com/api/token',
            new URLSearchParams({
                grant_type: 'refresh_token',
                refresh_token: req.session.refreshToken
            }).toString(),
            {
                headers: {
                    'Authorization': 'Basic ' + Buffer.from(spotifyConfig.clientId + ':' + spotifyConfig.clientSecret).toString('base64'),
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );

        // Update both session and global access token
        req.session.accessToken = response.data.access_token;
        accessToken = response.data.access_token;
        res.json({ access_token: accessToken });
    } catch (error) {
        console.error('Token refresh error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to refresh token' });
    }
});

// API endpoint for playlists
app.get('/api/playlists', async (req, res) => {
    console.log('Playlist route hit, token:', !!accessToken);
    
    if (!accessToken) {
        return res.status(401).json({ error: 'Not authenticated' });
    }

    try {
        const playlistsResponse = await axios.get('https://api.spotify.com/v1/browse/featured-playlists', {
            headers: {
                'Authorization': `Bearer ${accessToken}`
            },
            params: {
                country: 'CO',
                limit: 20
            }
        });

        res.json(playlistsResponse.data);
    } catch (error) {
        console.error('Playlist fetch error:', error.response?.data || error.message);
        res.status(500).json({ error: 'Failed to fetch playlists' });
    }
});

// Add logout endpoint
app.get('/auth/logout', (req, res) => {
    req.session.destroy();
    accessToken = null;
    res.redirect('/');
});

// Serve index.html for root route
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Add this catch-all route at the end
app.get('*', (req, res) => {
    console.log('404 route hit:', req.path);
    res.status(404).send('Not Found');
});

// Add a route to check configuration
app.get('/check-config', (req, res) => {
    res.json({
        callbackConfigured: process.env.CALLBACK_URL === 'https://my-first-app.onrender.com/callback',
        clientIdLength: process.env.CLIENT_ID?.length || 0,
        clientSecretLength: process.env.CLIENT_SECRET?.length || 0
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`Server is running on port ${PORT}`);
});
