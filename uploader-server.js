#!/usr/bin/env node
/**
 * uploader-server.js
 *
 * Fetches generated videos from Google Drive, scrapes channels to detect
 * already-uploaded videos, and uploads new videos to YouTube in a fair,
 * round-robin fashion across server configs and channels.
 *
 * Zip filename format (produced by upload_to_gdrive on the generator side):
 *   <score>_<config_id>_UNIV-<univ>.zip
 *   e.g.  87.50_sU8kTYfixdGil2l6_UNIV-d3af9b21c0.zip
 *
 * UNIV in YouTube description:
 *   Appended as  \n\nUNIV::<univ>  at the very end of every description.
 *
 * Zip contents:
 *   <video>.(mp4|mov|mkv|webm)
 *   <thumbnail>.(jpg|jpeg|png|webp)   (optional)
 *   metadata.json
 *
 * Usage:
 *   node uploader-server.js [options]
 *
 * Options:
 *   --configs           <a.json,b.json>   Config filenames under assets/server-configs/. REQUIRED.
 *   --min-gap           <ms>              Min ms between uploads from this IP.
 *                                         Default: config.scheduled_upload_delay or 1 800 000.
 *   --window            <HH:MM-HH:MM>     UTC upload window only. e.g. "13:00-23:00".
 *   --log-file          <path>            Append-only log. Default: ./uploader-server.log
 *   --dry-run                             Parse/score/scrape but do NOT upload or delete.
 *   --refetch-interval  <seconds>         Re-fetch configs/secrets/tokens from GDrive.
 *                                         Default: 600 (10 min).
 */

'use strict';

// ─────────────────────────────────────────────────────────────────────────────
// IMPORTS
// ─────────────────────────────────────────────────────────────────────────────
const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');
const { google }    = require('googleapis');
const { MongoClient } = require('mongodb');
const https         = require('https');
const http          = require('http');

// ─────────────────────────────────────────────────────────────────────────────
// CLI ARGUMENT PARSING
// ─────────────────────────────────────────────────────────────────────────────
function parseArgs() {
    const args = process.argv.slice(2);
    const opts = {
        configs:         null,
        minGap:          null,    // ms override; null → use config value
        window:          null,    // "HH:MM-HH:MM" UTC
        logFile:         path.join(__dirname, 'uploader-server.log'),
        dryRun:          false,
        refetchInterval: 600,     // seconds
    };

    for (let i = 0; i < args.length; i++) {
        switch (args[i]) {
            case '--configs':           opts.configs         = args[++i]; break;
            case '--min-gap':           opts.minGap          = parseInt(args[++i], 10); break;
            case '--window':            opts.window          = args[++i]; break;
            case '--log-file':          opts.logFile         = args[++i]; break;
            case '--dry-run':           opts.dryRun          = true;      break;
            case '--refetch-interval':  opts.refetchInterval = parseInt(args[++i], 10); break;
        }
    }

    // Also read from env vars (GitHub Actions passes config via env)
    if (!opts.configs)  opts.configs  = process.env.UPLOADER_CONFIGS  || null;
    if (!opts.minGap)   opts.minGap   = process.env.UPLOADER_MIN_GAP  ? parseInt(process.env.UPLOADER_MIN_GAP, 10) : null;
    if (!opts.window)   opts.window   = process.env.UPLOADER_WINDOW   || null;
    if (!opts.dryRun)   opts.dryRun   = process.env.UPLOADER_DRY_RUN  === 'true';

    if (!opts.configs) {
        console.error('❌  --configs is required.  e.g. --configs config1.json,config2.json');
        process.exit(1);
    }

    opts.configList = opts.configs.split(',').map(s => s.trim()).filter(Boolean);
    return opts;
}

// ─────────────────────────────────────────────────────────────────────────────
// LOGGER  (stdout + append-only .log file)
// ─────────────────────────────────────────────────────────────────────────────
function makeLogger(logFilePath) {
    const useFile = logFilePath && logFilePath !== 'stdout';
    let stream = null;
    if (useFile) {
        fs.mkdirSync(path.dirname(logFilePath), { recursive: true });
        stream = fs.createWriteStream(logFilePath, { flags: 'a' });
    }

    function write(level, ...parts) {
        const ts  = new Date().toISOString();
        const msg = parts
            .map(p => (p && typeof p === 'object' ? JSON.stringify(p) : String(p)))
            .join(' ');
        const line = `[${ts}] [${level}] ${msg}`;
        console.log(line);
        if (stream) stream.write(line + '\n');
    }

    return {
        info:    (...a) => write('INFO   ', ...a),
        success: (...a) => write('SUCCESS', ...a),
        warn:    (...a) => write('WARN   ', ...a),
        error:   (...a) => write('ERROR  ', ...a),
        debug:   (...a) => write('DEBUG  ', ...a),
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// GENERAL HELPERS
// ─────────────────────────────────────────────────────────────────────────────

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** True when the current UTC time falls inside a "HH:MM-HH:MM" window. */
function inUploadWindow(windowStr) {
    if (!windowStr) return true;
    const now    = new Date();
    const nowMin = now.getUTCHours() * 60 + now.getUTCMinutes();
    const [s, e] = windowStr.split('-').map(tok => {
        const [h, m] = tok.split(':').map(Number);
        return h * 60 + m;
    });
    // Handles windows that span midnight (e.g. "22:00-06:00")
    return s <= e
        ? (nowMin >= s && nowMin < e)
        : (nowMin >= s || nowMin < e);
}

function readJSON(filePath) {
    try { return JSON.parse(fs.readFileSync(filePath, 'utf8')); }
    catch { return null; }
}

function writeJSON(filePath, data) {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ─────────────────────────────────────────────────────────────────────────────
// FILENAME PARSER
//
// Exact format from upload_to_gdrive():
//   `${score.toFixed(2)}_${config_id}_UNIV-${univ}.zip`
// e.g.
//   87.50_sU8kTYfixdGil2l6_UNIV-d3af9b21c0.zip
//
// Returns { score, configId, univ, filename, base } or null on mismatch.
// ─────────────────────────────────────────────────────────────────────────────
function parseVideoFilename(filename) {
    const base  = path.basename(filename, '.zip');
    //                   score          config_id      univ
    const match = base.match(/^([\d.]+)_([^_]+)_UNIV-(.+)$/);
    if (!match) return null;
    return {
        score:    parseFloat(match[1]),
        configId: match[2],
        univ:     match[3],
        filename,
        base,
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// PERSISTENCE — MongoDB Atlas (primary) + local JSON fallback
// ─────────────────────────────────────────────────────────────────────────────
const STATE_ID   = 'uploader-state';
const STATE_FILE = path.join(__dirname, '.uploader-state.json');

const DEFAULT_STATE = () => ({
    configCursor:      0,
    channelCursors:    {},
    channelLastUpload: {},   // { channelName: epochMs } — per-channel last upload time
    pageCursors:       {},   // { configId: idx } — FB page round-robin
    pageLastUpload:    {},   // { pageName: epochMs } — per-page last upload time
    seenUnivs:         {},
});

let _mongoClient = null;
let _mongoDB     = null;

async function getMongoCollection(log) {
    const uri = process.env.MONGODB_URI;
    if (!uri) return null;
    if (!_mongoClient) {
        log.info('Connecting to MongoDB Atlas...');
        _mongoClient = new MongoClient(uri, { serverSelectionTimeoutMS: 10_000, connectTimeoutMS: 10_000 });
        await _mongoClient.connect();
        _mongoDB = _mongoClient.db(process.env.MONGODB_DB || 'uploader');
        log.info('MongoDB connected.');
    }
    return _mongoDB.collection('state');
}

async function closeMongoClient(log) {
    if (_mongoClient) {
        try { await _mongoClient.close(); log.info('MongoDB connection closed.'); }
        catch (e) { log.warn('MongoDB close error: ' + e.message); }
        _mongoClient = null; _mongoDB = null;
    }
}

async function loadState(log) {
    try {
        const col = await getMongoCollection(log);
        if (col) {
            const doc = await col.findOne({ _id: STATE_ID });
            if (doc) {
                log.info('State loaded from MongoDB.');
                const { _id, ...state } = doc;
                // Migrate legacy global lastUploadTime if present
                if (!state.channelLastUpload) state.channelLastUpload = {};
                if (!state.pageCursors)       state.pageCursors       = {};
                if (!state.pageLastUpload)    state.pageLastUpload    = {};
                return { ...DEFAULT_STATE(), ...state };
            }
            log.info('No existing state in MongoDB — starting fresh.');
            return DEFAULT_STATE();
        }
    } catch (e) {
        log.warn('MongoDB loadState failed, falling back to local: ' + e.message);
    }
    const local = readJSON(STATE_FILE);
    if (local) {
        log.info('State loaded from local file.');
        if (!local.channelLastUpload) local.channelLastUpload = {};
        if (!local.pageCursors)       local.pageCursors       = {};
        if (!local.pageLastUpload)    local.pageLastUpload    = {};
        return { ...DEFAULT_STATE(), ...local };
    }
    return DEFAULT_STATE();
}

async function saveState(state, log) {
    try {
        const col = await getMongoCollection(log);
        if (col) {
            await col.replaceOne({ _id: STATE_ID }, { _id: STATE_ID, ...state }, { upsert: true });
            return;
        }
    } catch (e) {
        log.warn('MongoDB saveState failed, falling back to local: ' + e.message);
    }
    writeJSON(STATE_FILE, state);
}

// ─────────────────────────────────────────────────────────────────────────────
// OAUTH2 CLIENT  (shared by Drive and YouTube helpers)
//
// Token storage format (from upload_to_gdrive):
//   { tokens: { access_token, refresh_token, … } }
// — but also handles bare  { access_token, refresh_token, … }
//
// On token refresh we merge rather than overwrite, so refresh_token is
// never accidentally lost (mirrors the [Fix 1 & 5] in upload_to_gdrive).
// ─────────────────────────────────────────────────────────────────────────────
function buildOAuthClient(clientFile, tokenFile, log, label) {
    const clientPath = path.join(__dirname, 'assets/client-secrets', clientFile);
    const tokenPath  = path.join(__dirname, 'assets/client-tokens',  tokenFile);

    const creds = JSON.parse(fs.readFileSync(clientPath, 'utf8'));
    const keys  = creds.installed || creds.web;
    if (!keys) throw new Error(`Invalid client secret structure in ${clientFile}`);

    const { client_id, client_secret, redirect_uris } = keys;
    const oAuth2 = new google.auth.OAuth2(client_id, client_secret, redirect_uris[0]);

    const stored = JSON.parse(fs.readFileSync(tokenPath, 'utf8'));
    oAuth2.setCredentials(stored.tokens ?? stored);

    oAuth2.on('tokens', newToken => {
        try {
            const current = readJSON(tokenPath) || {};
            // Merge: keep any key that the new event omits (especially refresh_token)
            const merged  = { ...current, ...newToken };
            if (!newToken.refresh_token) {
                const existing = current.refresh_token || current.tokens?.refresh_token;
                if (existing) merged.refresh_token = existing;
            }
            fs.writeFileSync(tokenPath, JSON.stringify(merged));
            log.info(`OAuth token refreshed and saved for ${label}`);
        } catch (e) {
            log.error(`Failed to persist refreshed token for ${label}: ${e.message}`);
        }
    });

    return oAuth2;
}

// ─────────────────────────────────────────────────────────────────────────────
// GOOGLE DRIVE  — list / download / delete
// ─────────────────────────────────────────────────────────────────────────────

/** Returns [{ id, name }] for all .zip files in folderId, all pages. */
async function listDriveZips(auth, folderId, log) {
    const drive = google.drive({ version: 'v3', auth });
    let files   = [];
    let pageToken;

    do {
        const res = await drive.files.list({
            q:         `'${folderId}' in parents and name contains '.zip' and trashed = false`,
            fields:    'nextPageToken, files(id, name)',
            pageSize:  1000,
            pageToken,
        });
        files     = files.concat(res.data.files || []);
        pageToken = res.data.nextPageToken;
    } while (pageToken);

    log.info(`Drive folder ${folderId}: ${files.length} zip(s)`);
    return files;
}

/** Stream-download a Drive file to destPath. */
async function downloadDriveFile(auth, fileId, destPath, log) {
    const drive = google.drive({ version: 'v3', auth });
    const dest  = fs.createWriteStream(destPath);

    const res = await drive.files.get(
        { fileId, alt: 'media' },
        { responseType: 'stream' }
    );

    await new Promise((resolve, reject) => {
        dest.on('finish', resolve);
        dest.on('error', reject);
        res.data.on('error', reject);
        res.data.pipe(dest);
    });

    log.info(`Downloaded ${fileId} → ${destPath}`);
}

/** Permanently delete a Drive file (bypasses trash). */
async function deleteDriveFile(auth, fileId, log) {
    const drive = google.drive({ version: 'v3', auth });
    await drive.files.delete({ fileId });
    log.info(`Deleted Drive file ${fileId}`);
}

// ─────────────────────────────────────────────────────────────────────────────
// CHANNEL SCRAPER  (yt-dlp)
//
// The generator appends  \n\nUNIV::<univ>  to every uploaded video's
// description, so we scan recent descriptions for that exact tag.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Fetches the last `limit` video descriptions from a channel and returns
 * a Set of all UNIV hashes found. Runs once per channel per config cycle.
 * Fails open (returns empty Set) so a scrape error never blocks an upload.
 */
function scrapeChannelUnivs(channelId, limit, log) {
    log.info(`Scraping channel ${channelId} (last ${limit} videos)...`);

    const result = spawnSync('yt-dlp', [
        `https://www.youtube.com/channel/${channelId}/videos`,
        '--flat-playlist',
        '--playlist-end', String(limit),
        '--print', '%(description)s',
        '--no-warnings',
        '--quiet',
    ], { encoding: 'utf8', timeout: 90_000 });

    if (result.error) {
        log.warn(`yt-dlp spawn error for channel ${channelId}: ${result.error.message}`);
        return new Set();
    }

    const found = new Set();
    const text  = result.stdout || '';
    for (const m of text.matchAll(/UNIV::([a-f0-9]+)/g)) {
        found.add(m[1]);
    }
    log.info(`Channel ${channelId}: found ${found.size} UNIV(s) in last ${limit} videos`);
    return found;
}

/**
 * Scrapes all channels for a config in parallel and returns a combined Set
 * of all UNIV hashes already live across any channel in that config.
 */
async function scrapeAllChannels(channels, limit, log) {
    const results = await Promise.all(
        channels.map(ch => Promise.resolve(scrapeChannelUnivs(ch.id, limit, log)))
    );
    const combined = new Set();
    for (const s of results) for (const univ of s) combined.add(univ);
    return combined;
}

// ─────────────────────────────────────────────────────────────────────────────
// ZIP EXTRACTION
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Unzip zipPath into destDir.
 * Returns { videoPath, thumbnailPath (or null), metadata (object) }.
 */
function extractZip(zipPath, destDir, log) {
    fs.mkdirSync(destDir, { recursive: true });

    const res = spawnSync('unzip', ['-q', '-o', zipPath, '-d', destDir], { encoding: 'utf8' });
    if (res.status !== 0) throw new Error(`unzip failed: ${res.stderr}`);

    const files         = fs.readdirSync(destDir);
    const videoFile     = files.find(f => /\.(mp4|mov|mkv|webm)$/i.test(f));
    const thumbFile     = files.find(f => /\.(jpg|jpeg|png|webp)$/i.test(f));
    const metaFile      = files.find(f => f === 'metadata.json');

    if (!videoFile) throw new Error(`No video file found inside ${zipPath}`);

    const videoPath     = path.join(destDir, videoFile);
    const thumbnailPath = thumbFile ? path.join(destDir, thumbFile) : null;
    const metadata      = metaFile  ? (readJSON(path.join(destDir, metaFile)) || {}) : {};

    log.info(`Extracted: video=${videoFile}  thumb=${thumbFile || 'none'}  meta=${metaFile || 'none'}`);
    return { videoPath, thumbnailPath, metadata };
}

// ─────────────────────────────────────────────────────────────────────────────
// UPLOAD LOCATIONS  (US only — used when random_upload_location_feature: true)
// ─────────────────────────────────────────────────────────────────────────────

const US_UPLOAD_LOCATIONS = [
    // West
    { latitude: 34.0522, longitude: -118.2437, locationDescription: 'Los Angeles, USA' },
    { latitude: 37.7749, longitude: -122.4194, locationDescription: 'San Francisco, USA' },
    { latitude: 47.6062, longitude: -122.3321, locationDescription: 'Seattle, USA' },
    { latitude: 32.7157, longitude: -117.1611, locationDescription: 'San Diego, USA' },
    { latitude: 36.1699, longitude: -115.1398, locationDescription: 'Las Vegas, USA' },
    { latitude: 33.4484, longitude: -112.0740, locationDescription: 'Phoenix, USA' },

    // East Coast
    { latitude: 40.7128, longitude:  -74.0060, locationDescription: 'New York, USA' },
    { latitude: 42.3601, longitude:  -71.0589, locationDescription: 'Boston, USA' },
    { latitude: 38.9072, longitude:  -77.0369, locationDescription: 'Washington D.C., USA' },
    { latitude: 39.9526, longitude:  -75.1652, locationDescription: 'Philadelphia, USA' },
    { latitude: 40.4406, longitude:  -79.9959, locationDescription: 'Pittsburgh, USA' },

    // Midwest
    { latitude: 41.8781, longitude:  -87.6298, locationDescription: 'Chicago, USA' },
    { latitude: 39.7684, longitude:  -86.1581, locationDescription: 'Indianapolis, USA' },
    { latitude: 44.9778, longitude:  -93.2650, locationDescription: 'Minneapolis, USA' },
    { latitude: 41.2565, longitude:  -95.9345, locationDescription: 'Omaha, USA' },
    { latitude: 43.0389, longitude:  -87.9065, locationDescription: 'Milwaukee, USA' },
    { latitude: 39.1031, longitude:  -84.5120, locationDescription: 'Cincinnati, USA' },

    // South
    { latitude: 29.7604, longitude:  -95.3698, locationDescription: 'Houston, USA' },
    { latitude: 33.7490, longitude:  -84.3880, locationDescription: 'Atlanta, USA' },
    { latitude: 32.7767, longitude:  -96.7970, locationDescription: 'Dallas, USA' },
    { latitude: 25.7617, longitude:  -80.1918, locationDescription: 'Miami, USA' },
    { latitude: 30.2672, longitude:  -97.7431, locationDescription: 'Austin, USA' },
    { latitude: 35.2271, longitude:  -80.8431, locationDescription: 'Charlotte, USA' },
    { latitude: 36.1627, longitude:  -86.7816, locationDescription: 'Nashville, USA' },
    { latitude: 29.9511, longitude:  -90.0715, locationDescription: 'New Orleans, USA' },
    { latitude: 35.1495, longitude:  -90.0490, locationDescription: 'Memphis, USA' },
    { latitude: 27.9506, longitude:  -82.4572, locationDescription: 'Tampa, USA' },
    { latitude: 28.5383, longitude:  -81.3792, locationDescription: 'Orlando, USA' },
];

/** Returns a random location from US_UPLOAD_LOCATIONS, or null if the feature is disabled. */
function pickRandomLocation(cfg) {
    if (!cfg.random_upload_location_feature) return null;
    return US_UPLOAD_LOCATIONS[Math.floor(Math.random() * US_UPLOAD_LOCATIONS.length)];
}

// ─────────────────────────────────────────────────────────────────────────────
// YOUTUBE UPLOAD
// ─────────────────────────────────────────────────────────────────────────────

async function uploadToYouTube(auth, videoPath, thumbnailPath, metadata, cfg, log) {
    const youtube       = google.youtube({ version: 'v3', auth });
    const isScheduled   = cfg.scheduled_uploads === true;
    const privacyStatus = isScheduled ? 'private' : 'public';

    const publishAt = isScheduled
        ? new Date(Date.now() + (cfg.scheduled_content_buffer || 43_200_000)).toISOString()
        : undefined;

    const videoSize = fs.statSync(videoPath).size;
    let   lastLog   = 0;

    // ── random upload location ────────────────────────────────────────────────
    const location = pickRandomLocation(cfg);
    if (location) {
        log.info(`YT: using upload location — ${location.locationDescription} (${location.latitude}, ${location.longitude})`);
    }

    const requestParams = {
        part: location ? 'snippet,status,recordingDetails' : 'snippet,status',
        requestBody: {
            snippet: {
                title:                metadata.title        || 'Untitled',
                description:          metadata.description  || '',
                tags:                 metadata.tags         || [],
                categoryId:           String(metadata.categoryId || 22),
                defaultLanguage:      'en',
                defaultAudioLanguage: 'en',
            },
            status: {
                privacyStatus,
                selfDeclaredMadeForKids: false,
                embeddable:              true,
                publicStatsViewable:     true,
                ...(publishAt ? { publishAt } : {}),
            },
            ...(location ? {
                recordingDetails: {
                    location: {
                        latitude:            location.latitude,
                        longitude:           location.longitude,
                        altitude:            0,
                    },
                    locationDescription: location.locationDescription,
                },
            } : {}),
        },
        media: { body: fs.createReadStream(videoPath) },
    };

    log.info(`Uploading "${metadata.title || path.basename(videoPath)}" (${(videoSize / 1e6).toFixed(1)} MB) → ${privacyStatus}${publishAt ? ' @ ' + publishAt : ''}...`);
    const t0 = Date.now();

    const response = await youtube.videos.insert(requestParams, {
        onUploadProgress: evt => {
            const now = Date.now();
            if (now - lastLog > 15_000) {
                const pct = videoSize ? ((evt.bytesRead / videoSize) * 100).toFixed(0) : '?';
                log.info(`Upload progress: ${pct}%`);
                lastLog = now;
            }
        },
    });

    const videoId = response.data.id;
    log.success(`Upload done in ${((Date.now() - t0) / 1000).toFixed(1)}s — video ID: ${videoId}`);

    // Set thumbnail (only works if channel is YT-verified; non-fatal if it fails)
    if (thumbnailPath && videoId) {
        try {
            await youtube.thumbnails.set({
                videoId,
                media: {
                    mimeType: /\.png$/i.test(thumbnailPath) ? 'image/png' : 'image/jpeg',
                    body:     fs.createReadStream(thumbnailPath),
                },
            });
            log.success(`Thumbnail set for ${videoId}`);
        } catch (e) {
            log.warn(`Thumbnail upload skipped (channel may not be verified): ${e.message}`);
        }
    }

    return response;
}

// ─────────────────────────────────────────────────────────────────────────────
// FACEBOOK HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Minimal HTTP/HTTPS request helper (no external deps needed).
 * Returns { statusCode, body } — body is a parsed object if JSON, else raw string.
 */
function httpRequest(urlStr, options = {}, bodyData = null) {
    return new Promise((resolve, reject) => {
        const url    = new URL(urlStr);
        const isHttps = url.protocol === 'https:';
        const lib    = isHttps ? https : http;

        const reqOpts = {
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   options.method || 'GET',
            headers:  options.headers || {},
        };

        const req = lib.request(reqOpts, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                let body;
                try { body = JSON.parse(raw); } catch { body = raw; }
                resolve({ statusCode: res.statusCode, body });
            });
        });

        req.on('error', reject);
        if (bodyData) req.write(bodyData);
        req.end();
    });
}

/**
 * Checks the page's recent videos for UNIV::<univ> in the description.
 * Uses the Graph API — no yt-dlp needed.
 * Fails open (returns false) so a failed check never silently blocks an upload.
 */
const FB_API_VERSION = 'v25.0';

async function pageAlreadyHasUniv(pageId, accessToken, univ, log) {
    log.info(`FB: checking page ${pageId} for UNIV::${univ}...`);
    try {
        const url = `https://graph.facebook.com/${FB_API_VERSION}/${pageId}/videos`
            + `?fields=description&limit=50&access_token=${encodeURIComponent(accessToken)}`;

        const { statusCode, body } = await httpRequest(url);
        if (statusCode !== 200) {
            log.warn(`FB dedup check HTTP ${statusCode} for page ${pageId} — proceeding anyway`);
            return false;
        }

        const needle = `UNIV::${univ}`;
        const videos = body.data || [];
        const found  = videos.some(v => (v.description || '').includes(needle));
        if (found) log.info(`FB: UNIV::${univ} already on page ${pageId}`);
        return found;
    } catch (e) {
        log.warn(`FB dedup check failed for page ${pageId}: ${e.message} — proceeding anyway`);
        return false;
    }
}

/**
 * Upload a video as a Facebook Reel to a page.
 *
 * Flow (resumable upload):
 *   1. POST /reels/initialize  → upload_session_id + video_id
 *   2. POST /reels/upload      → binary transfer
 *   3. POST /reels/finish      → publish
 *
 * page.access_token  — permanent page access token (from Graph API Explorer)
 * page.id            — numeric page ID
 */
async function uploadToFacebook(page, videoPath, metadata, univ, cfg, log) {
    const { id: pageId, access_token: accessToken, name: pageName } = page;
    const title       = metadata.title       || 'Untitled';
    const baseDescription = metadata.description || '';

    // Build hashtags from tags: lowercase, strip spaces, prefix with #
    // NOTE: UNIV tag is intentionally NOT included in FB descriptions — YT only.
    const tags     = Array.isArray(metadata.tags) ? metadata.tags : [];
    const hashtags = tags
        .map(t => '#' + t.toLowerCase().replace(/\s+/g, ''))
        .join(' ');
    const hashAndDesc = [baseDescription, hashtags].filter(Boolean).join('  ');
    const maxBody     = 500;
    const description = hashAndDesc.length > maxBody
        ? hashAndDesc.slice(0, maxBody - 1).trimEnd() + '…'
        : hashAndDesc;

    const videoSize   = fs.statSync(videoPath).size;

    log.info(`FB: uploading Reel "${title}" (${(videoSize / 1e6).toFixed(1)} MB) → page "${pageName}" (${pageId})`);

    // ── Step 1: Initialize ────────────────────────────────────────────────────
    const initUrl  = `https://graph.facebook.com/${FB_API_VERSION}/${pageId}/video_reels`;
    const initBody = new URLSearchParams({
        upload_phase:  'start',
        access_token:  accessToken,
    }).toString();

    const initRes = await httpRequest(initUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, initBody);

    if (initRes.statusCode !== 200) {
        throw new Error(`FB init failed (${initRes.statusCode}): ${JSON.stringify(initRes.body)}`);
    }

    const videoId         = initRes.body.video_id;
    const uploadSessionId = initRes.body.upload_session_id;
    if (!videoId) {
        throw new Error(`FB init response missing video_id: ${JSON.stringify(initRes.body)}`);
    }
    log.info(`FB: video_id ${videoId}  session ${uploadSessionId}`);

    // ── Step 2: Transfer ──────────────────────────────────────────────────────
    const transferUrl = `https://rupload.facebook.com/video-upload/${FB_API_VERSION}/${videoId}`;
    const transferRes = await new Promise((resolve, reject) => {
        const url = new URL(transferUrl);
        const req = https.request({
            hostname: url.hostname,
            path:     url.pathname + url.search,
            method:   'POST',
            headers: {
                'Authorization':       `OAuth ${accessToken}`,
                'offset':              '0',
                'file_size':           String(videoSize),
                'Content-Type':        'application/octet-stream',
                'Content-Length':      String(videoSize),
            },
        }, res => {
            const chunks = [];
            res.on('data', c => chunks.push(c));
            res.on('end', () => {
                const raw = Buffer.concat(chunks).toString();
                let body;
                try { body = JSON.parse(raw); } catch { body = raw; }
                resolve({ statusCode: res.statusCode, body });
            });
        });
        req.on('error', reject);

        // Stream with progress logging
        let uploaded = 0;
        let lastLog  = 0;
        const stream = fs.createReadStream(videoPath);
        stream.on('data', chunk => {
            uploaded += chunk.length;
            const now = Date.now();
            if (now - lastLog > 15_000) {
                log.info(`FB upload progress: ${((uploaded / videoSize) * 100).toFixed(0)}%`);
                lastLog = now;
            }
        });
        stream.on('error', reject);
        stream.pipe(req);
    });

    if (transferRes.statusCode !== 200 || !transferRes.body.success) {
        throw new Error(`FB transfer failed (${transferRes.statusCode}): ${JSON.stringify(transferRes.body)}`);
    }
    log.info(`FB: transfer complete`);

    // ── Step 3: Finish / Publish ──────────────────────────────────────────────
    // ── optional: look up a Facebook Place ID near the chosen location ────────
    const fbLocation = pickRandomLocation(cfg);
    let   fbPlaceId  = null;

    if (fbLocation) {
        log.info(`FB: looking up place near ${fbLocation.locationDescription} (${fbLocation.latitude}, ${fbLocation.longitude})...`);
        try {
            const placeUrl = `https://graph.facebook.com/${FB_API_VERSION}/search`
                + `?type=place`
                + `&center=${fbLocation.latitude},${fbLocation.longitude}`
                + `&distance=5000`
                + `&limit=1`
                + `&fields=id,name`
                + `&access_token=${encodeURIComponent(accessToken)}`;

            const placeRes = await httpRequest(placeUrl);
            const places   = placeRes.body && placeRes.body.data;
            if (Array.isArray(places) && places.length > 0) {
                fbPlaceId = places[0].id;
                log.info(`FB: place found — "${places[0].name}" (id: ${fbPlaceId})`);
            } else {
                log.warn(`FB: no place found near ${fbLocation.locationDescription} — uploading without location tag`);
            }
        } catch (e) {
            log.warn(`FB: place lookup failed (non-fatal): ${e.message} — uploading without location tag`);
        }
    }

    const finishParams = {
        upload_phase:  'finish',
        video_id:      videoId,
        access_token:  accessToken,
        title,
        description,
        video_state:   'PUBLISHED',
        ...(fbPlaceId ? { place: fbPlaceId } : {}),
    };

    const finishBody = new URLSearchParams(finishParams).toString();

    const finishRes = await httpRequest(initUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    }, finishBody);

    if (finishRes.statusCode !== 200) {
        throw new Error(`FB finish failed (${finishRes.statusCode}): ${JSON.stringify(finishRes.body)}`);
    }

    log.success(`FB: ✅ Reel published — video_id ${videoId}  page "${pageName}"`);
    return videoId;
}

// ─────────────────────────────────────────────────────────────────────────────
// ASSET RE-FETCH  (mirrors gdown logic from on-start-script.sh)
// Runs at startup and every `refetchInterval` seconds thereafter.
// ─────────────────────────────────────────────────────────────────────────────
function refetchAssets(log) {
    const tasks = [
        { envId: 'GDRIVE_SERVER_CONFIGS_ID', dest: 'assets/server-configs', skipEnv: 'DISABLE_SERVER_CONFIGS_FETCH' },
        { envId: 'GDRIVE_CLIENT_SECRETS_ID', dest: 'assets/client-secrets', skipEnv: 'DISABLE_CLIENT_SECRETS_FETCH' },
        { envId: 'GDRIVE_CLIENT_TOKENS_ID',  dest: 'assets/client-tokens',  skipEnv: 'DISABLE_CLIENT_TOKENS_FETCH'  },
    ];

    for (const t of tasks) {
        if (process.env[t.skipEnv] === 'true') {
            log.info(`Skipping re-fetch of ${t.dest} (${t.skipEnv}=true)`);
            continue;
        }
        const fileId = process.env[t.envId];
        if (!fileId) {
            log.warn(`${t.envId} not set — skipping re-fetch of ${t.dest}`);
            continue;
        }

        const tmpZip = `/tmp/refetch_${Date.now()}_${Math.random().toString(36).slice(2)}.zip`;
        try {
            log.info(`Re-fetching ${t.dest} (GDrive ${fileId})...`);
            const dl = spawnSync('gdown', [
                `https://drive.google.com/uc?id=${fileId}`,
                '-O', tmpZip,
                '--quiet',
            ], { encoding: 'utf8', timeout: 120_000 });

            if (dl.status !== 0 || !fs.existsSync(tmpZip)) {
                log.warn(`gdown failed for ${t.dest}: ${(dl.stderr || '').trim()}`);
                continue;
            }

            fs.rmSync(t.dest, { recursive: true, force: true });
            fs.mkdirSync(t.dest, { recursive: true });
            spawnSync('unzip', ['-q', '-o', tmpZip, '-d', t.dest], { encoding: 'utf8' });
            fs.rmSync(tmpZip, { force: true });
            log.success(`Re-fetched ${t.dest}`);
        } catch (e) {
            log.error(`Re-fetch error for ${t.dest}: ${e.message}`);
            try { fs.rmSync(tmpZip, { force: true }); } catch (_) {}
        }
    }
}

// ─────────────────────────────────────────────────────────────────────────────
// MAIN LOOP
// ─────────────────────────────────────────────────────────────────────────────
async function run(opts, log) {
    const SCRAPE_LIMIT = 6;

    let state = await loadState(log);
    let lastRefetch = 0;

    async function maybeRefetch() {
        if (Date.now() - lastRefetch >= opts.refetchInterval * 1000) {
            refetchAssets(log);
            lastRefetch = Date.now();
        }
    }

    function loadConfigs() {
        return opts.configList
            .map(filename => {
                const p   = path.join(__dirname, 'assets/server-configs', filename);
                const cfg = readJSON(p);
                if (!cfg) log.error(`Cannot read config: ${p}`);
                return cfg;
            })
            .filter(Boolean);
    }

    // ── startup log ───────────────────────────────────────────────────────────
    log.info('══════════════════════════════════════════');
    log.info('uploader-server starting');
    log.info(`Configs:          ${opts.configList.join(', ')}`);
    log.info(`Dry run:          ${opts.dryRun}`);
    log.info(`Upload window:    ${opts.window || 'unrestricted (UTC)'}`);
    log.info(`Min gap (per channel): ${opts.minGap != null ? opts.minGap + 'ms' : 'use config value'}`);
    log.info(`Refetch interval: ${opts.refetchInterval}s`);
    log.info(`State backend:    ${process.env.MONGODB_URI ? 'MongoDB Atlas' : 'local file'}`);
    log.info('══════════════════════════════════════════');

    await maybeRefetch();
    const configs     = loadConfigs();
    const configCount = configs.length;

    if (!configCount) {
        log.error('No valid configs loaded — exiting.');
        process.exit(1);
    }

    let configIdx = state.configCursor % configCount;

    // ── config round-robin ────────────────────────────────────────────────────
    for (let ci = 0; ci < configCount; ci++) {
        await maybeRefetch();

        const cfg      = configs[configIdx];
        const configId = cfg.config_id;

        log.info(`\n── Config ${configIdx + 1}/${configCount}: ${configId} ──`);

        // ── upload window check ───────────────────────────────────────────────
        if (!inUploadWindow(opts.window)) {
            log.info(`Outside upload window (${opts.window}) — skipping ${configId}`);
            configIdx = (configIdx + 1) % configCount;
            continue;
        }

        // ── build candidates list from all drives in this config ──────────────
        const candidates = [];

        for (const driveEntry of (cfg.google_drives || [])) {
            let driveAuth;
            try {
                driveAuth = buildOAuthClient(
                    driveEntry.client, driveEntry.token, log,
                    driveEntry.alias || driveEntry.name
                );
            } catch (e) {
                log.error(`Drive auth failed for "${driveEntry.alias}": ${e.message}`);
                continue;
            }

            let files;
            try {
                files = await listDriveZips(driveAuth, driveEntry.folder_id, log);
            } catch (e) {
                log.error(`Failed to list drive "${driveEntry.alias}": ${e.message}`);
                continue;
            }

            for (const f of files) {
                const parsed = parseVideoFilename(f.name);
                if (!parsed) {
                    log.debug(`Unrecognised filename (skipped): ${f.name}`);
                    continue;
                }
                if (parsed.configId !== configId) continue;
                candidates.push({ driveEntry, driveAuth, fileObj: f, parsed });
            }
        }

        // Sort highest score first
        candidates.sort((a, b) => b.parsed.score - a.parsed.score);
        log.info(`${candidates.length} candidate zip(s) for config ${configId}`);

        if (!candidates.length) {
            log.info(`Nothing to upload for ${configId} — moving on`);
            configIdx = (configIdx + 1) % configCount;
            state.configCursor = configIdx;
            await saveState(state, log);
            continue;
        }

        // ── channels ──────────────────────────────────────────────────────────
        const channels     = cfg.channels || [];
        const channelCount = channels.length;
        if (!channelCount) {
            log.warn(`Config ${configId} has no channels`);
            configIdx = (configIdx + 1) % configCount;
            continue;
        }

        let channelIdx = (state.channelCursors[configId] || 0) % channelCount;

        // ── per-channel min-gap is enforced at upload time (see below) ─────────
        const minGap = opts.minGap ?? cfg.scheduled_upload_delay ?? 0;

        // ── scrape all channels once in parallel before the video loop ────────
        log.info(`Scraping ${channels.length} channel(s) for config ${configId}...`);
        const liveUnivs = await scrapeAllChannels(channels, SCRAPE_LIMIT, log);

        // ── video loop ────────────────────────────────────────────────────────
        let uploadedThisCycle = false;

        for (const { driveEntry, driveAuth, fileObj, parsed } of candidates) {
            const { univ, score, filename } = parsed;

            // ── local UNIV dedup cache ────────────────────────────────────────
            if (state.seenUnivs[univ]) {
                log.info(`UNIV ${univ} already in local cache — skipping`);
                continue;
            }

            // ── check pre-scraped channel results (no extra yt-dlp calls) ─────
            const alreadyLive = liveUnivs.has(univ);

            if (alreadyLive) {
                log.info(`UNIV ${univ} already live — caching locally + removing from Drive`);
                state.seenUnivs[univ] = true;
                await saveState(state, log);
                if (!opts.dryRun) {
                    try { await deleteDriveFile(driveAuth, fileObj.id, log); }
                    catch (e) { log.error(`Drive delete failed: ${e.message}`); }
                } else {
                    log.info(`[DRY RUN] Would delete Drive file ${fileObj.id}`);
                }
                continue;
            }

            // ── pick next eligible channel (respects daily quota) ─────────────
            const dailyLimit = cfg.max_daily_yt_upload_per_channel || 6;
            const todayKey   = new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
            let   target     = null;

            for (let t = 0; t < channelCount; t++) {
                const ch       = channels[(channelIdx + t) % channelCount];
                const countKey = `__daily__${ch.name}__${todayKey}`;
                const count    = state.seenUnivs[countKey] || 0;
                if (count < dailyLimit) {
                    target     = ch;
                    channelIdx = (channelIdx + t) % channelCount;
                    break;
                }
                log.warn(`Channel "${ch.name}" at daily quota (${count}/${dailyLimit})`);
            }

            if (!target) {
                log.warn(`All channels at daily quota for config ${configId} — stopping this cycle`);
                break;
            }

            // Re-check window
            if (!inUploadWindow(opts.window)) {
                log.info('Left upload window mid-loop — stopping');
                break;
            }

            // ── per-channel min-gap check ─────────────────────────────────────
            if (minGap > 0) {
                const lastUpload = state.channelLastUpload[target.name] || 0;
                const elapsed    = Date.now() - lastUpload;
                if (lastUpload > 0 && elapsed < minGap) {
                    const remaining = Math.ceil((minGap - elapsed) / 60000);
                    log.info(`Channel "${target.name}" uploaded ${Math.floor(elapsed / 60000)}min ago — min gap ${Math.ceil(minGap / 60000)}min not reached (${remaining}min left). Skipping.`);
                    continue;
                }
            }

            // ── download zip ──────────────────────────────────────────────────
            const uid    = `${Date.now()}_${Math.random().toString(36).slice(2)}`;
            const tmpZip = `/tmp/up_${uid}.zip`;
            const tmpDir = `/tmp/up_${uid}`;

            try {
                log.info(`Downloading "${filename}" (score ${score.toFixed(2)})...`);

                if (!opts.dryRun) {
                    await downloadDriveFile(driveAuth, fileObj.id, tmpZip, log);
                } else {
                    log.info(`[DRY RUN] Would download Drive file ${fileObj.id}`);
                }

                // ── extract ───────────────────────────────────────────────────
                let videoPath, thumbnailPath, metadata;
                if (!opts.dryRun) {
                    ({ videoPath, thumbnailPath, metadata } = extractZip(tmpZip, tmpDir, log));
                } else {
                    videoPath = thumbnailPath = null;
                    metadata  = {};
                    log.info(`[DRY RUN] Would extract ${filename}`);
                }

                // ── YT auth ───────────────────────────────────────────────────
                let ytAuth;
                try {
                    ytAuth = buildOAuthClient(target.client, target.token, log, target.name);
                } catch (e) {
                    log.error(`YT auth failed for "${target.name}": ${e.message} — skipping channel`);
                    channelIdx = (channelIdx + 1) % channelCount;
                    continue;
                }

                // ── upload ────────────────────────────────────────────────────
                if (!opts.dryRun) {
                    await uploadToYouTube(ytAuth, videoPath, thumbnailPath, metadata, cfg, log);
                } else {
                    log.info(`[DRY RUN] Would upload "${filename}" → channel "${target.name}"`);
                }

                // ── bookkeeping ───────────────────────────────────────────────
                state.channelLastUpload[target.name] = Date.now();
                state.seenUnivs[univ] = true;

                const countKey = `__daily__${target.name}__${todayKey}`;
                state.seenUnivs[countKey] = (state.seenUnivs[countKey] || 0) + 1;

                // Advance channel cursor → next upload goes to the next channel
                channelIdx = (channelIdx + 1) % channelCount;
                state.channelCursors[configId] = channelIdx;
                await saveState(state, log);

                // ── Facebook upload (same video, only after YT success) ───────
                const fbPages     = cfg.facebook_pages || [];
                const fbPageCount = fbPages.length;

                if (fbPageCount > 0) {
                    log.info(`FB: attempting upload for same UNIV ${univ} → ${fbPageCount} page(s)`);

                    let fbPageIdx = (state.pageCursors[configId] || 0) % fbPageCount;

                    // ── pick next eligible FB page (respects daily quota) ─────────
                    const fbDailyLimit = cfg.max_daily_fb_upload_per_page || cfg.max_daily_yt_upload_per_channel || 6;
                    const fbTodayKey   = new Date().toISOString().slice(0, 10);
                    let   fbTarget     = null;

                    for (let t = 0; t < fbPageCount; t++) {
                        const pg       = fbPages[(fbPageIdx + t) % fbPageCount];
                        const countKey = `__fb_daily__${pg.name}__${fbTodayKey}`;
                        const count    = state.seenUnivs[countKey] || 0;
                        if (count < fbDailyLimit) {
                            fbTarget  = pg;
                            fbPageIdx = (fbPageIdx + t) % fbPageCount;
                            break;
                        }
                        log.warn(`FB page "${pg.name}" at daily quota (${count}/${fbDailyLimit})`);
                    }

                    if (!fbTarget) {
                        log.warn(`All FB pages at daily quota for config ${configId} — skipping FB`);
                    } else if (!inUploadWindow(opts.window)) {
                        log.info('Left upload window after YT upload — skipping FB');
                    } else {
                        // ── per-page min-gap check ────────────────────────────
                        const fbMinGap = opts.minGap ?? cfg.scheduled_upload_delay ?? 0;
                        let   gapOk    = true;
                        if (fbMinGap > 0) {
                            const lastUpload = state.pageLastUpload[fbTarget.name] || 0;
                            const elapsed    = Date.now() - lastUpload;
                            if (lastUpload > 0 && elapsed < fbMinGap) {
                                const remaining = Math.ceil((fbMinGap - elapsed) / 60000);
                                log.info(`FB page "${fbTarget.name}" uploaded ${Math.floor(elapsed / 60000)}min ago — min gap not reached (${remaining}min left). Skipping FB.`);
                                gapOk = false;
                            }
                        }

                        if (gapOk) {
                            // ── FB dedup: check if page already has this UNIV ─────
                            let fbAlreadyLive = false;
                            try {
                                fbAlreadyLive = await pageAlreadyHasUniv(fbTarget.id, fbTarget.access_token, univ, log);
                            } catch (e) {
                                log.warn(`FB dedup check threw for page "${fbTarget.name}": ${e.message} — proceeding`);
                            }

                            if (fbAlreadyLive) {
                                log.info(`FB: UNIV ${univ} already on page "${fbTarget.name}" — caching locally`);
                                state.seenUnivs[`fb::${univ}`] = true;
                                await saveState(state, log);
                            } else {
                                try {
                                    if (!opts.dryRun) {
                                        await uploadToFacebook(fbTarget, videoPath, metadata, univ, cfg, log);
                                    } else {
                                        log.info(`[DRY RUN] Would upload "${filename}" → FB page "${fbTarget.name}"`);
                                    }

                                    // ── FB bookkeeping ──────────────────────────
                                    state.seenUnivs[`fb::${univ}`]      = true;
                                    state.pageLastUpload[fbTarget.name] = Date.now();

                                    const fbCountKey = `__fb_daily__${fbTarget.name}__${fbTodayKey}`;
                                    state.seenUnivs[fbCountKey] = (state.seenUnivs[fbCountKey] || 0) + 1;

                                    fbPageIdx = (fbPageIdx + 1) % fbPageCount;
                                    state.pageCursors[configId] = fbPageIdx;
                                    await saveState(state, log);

                                    log.success(`✅  FB done — config: ${configId}  page: ${fbTarget.name}  UNIV: ${univ}`);
                                } catch (e) {
                                    log.error(`FB upload failed for "${filename}": ${e.message}`);
                                    if (e.stack) log.debug(e.stack);
                                    // Non-fatal: YT is the priority; proceed to clean up Drive
                                }
                            }
                        }
                    }
                }


                // ── delete from Drive ─────────────────────────────────────────
                if (cfg.delete_videos_after_uploads !== false) {
                    if (!opts.dryRun) {
                        try { await deleteDriveFile(driveAuth, fileObj.id, log); }
                        catch (e) { log.error(`Drive delete failed (non-fatal): ${e.message}`); }
                    } else {
                        log.info(`[DRY RUN] Would delete Drive file ${fileObj.id}`);
                    }
                }

                uploadedThisCycle = true;
                log.success(`✅  Done — config: ${configId}  channel: ${target.name}  UNIV: ${univ}  score: ${score.toFixed(2)}`);
                break; // one upload per config per outer-loop turn

            } catch (e) {
                log.error(`Pipeline failed for "${filename}": ${e.message}`);
                if (e.stack) log.debug(e.stack);
            } finally {
                try { fs.rmSync(tmpZip, { force: true }); }                    catch (_) {}
                try { fs.rmSync(tmpDir, { recursive: true, force: true }); }  catch (_) {}
            }
        } // end video loop

        if (uploadedThisCycle) {
            // One successful upload = one YouTube account per IP.
            // Advance cursor so the NEXT run starts on the next config, then stop.
            configIdx = (configIdx + 1) % configCount;
            state.configCursor = configIdx;
            await saveState(state, log);
            log.info(`Upload successful for config ${configId} — exiting to preserve IP rotation.`);
            break;
        }

        // Nothing uploaded for this config (quota, gap, no videos, error, etc.)
        // Advance cursor and try the next config in this same run.
        log.info(`No upload this cycle for config ${configId} — trying next config...`);
        configIdx = (configIdx + 1) % configCount;
        state.configCursor = configIdx;
        await saveState(state, log);

    } // end config loop

    log.info('Run complete.');
}

// ─────────────────────────────────────────────────────────────────────────────
// ENTRY POINT
// ─────────────────────────────────────────────────────────────────────────────
(async () => {
    const opts = parseArgs();
    const log  = makeLogger(opts.logFile);
    try {
        await run(opts, log);
    } catch (e) {
        log.error(`Fatal: ${e.message}`);
        if (e.stack) log.error(e.stack);
        process.exit(1);
    } finally {
        await closeMongoClient(log);
    }
})();
