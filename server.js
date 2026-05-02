const express = require('express');
const path = require('path');
const cors = require('cors');
const https = require('https');

const app = express();
const port = process.env.PORT || 3000;

// ─── Firebase Config (same project as game.html) ──────────────────────────────
const FIREBASE_PROJECT = 'zupwin-5151c';
const FIREBASE_API_KEY  = 'AIzaSyCBUBO2wuDcpRRnPir3-BzBFz2SZoqyFQ0';
const FIRESTORE_BASE    = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents`;
const STATE_DOC         = 'gameState/colorPrediction'; // collection/docId

app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, './')));

// ─── Game State ───────────────────────────────────────────────────────────────
let currentPeriod = BigInt('20260000000000001');
let timeLeft      = 60;
let gameHistory   = [];

// ─── Firestore REST Helpers ───────────────────────────────────────────────────

/** Low-level HTTPS request wrapper */
function httpsRequest(url, method = 'GET', bodyObj = null) {
    return new Promise((resolve, reject) => {
        const urlObj   = new URL(url);
        const bodyStr  = bodyObj ? JSON.stringify(bodyObj) : null;
        const options  = {
            hostname : urlObj.hostname,
            path     : urlObj.pathname + urlObj.search,
            method,
            headers  : { 'Content-Type': 'application/json' }
        };
        if (bodyStr) options.headers['Content-Length'] = Buffer.byteLength(bodyStr);

        const req = https.request(options, (res) => {
            let raw = '';
            res.on('data', chunk => raw += chunk);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(raw) }); }
                catch (e) { resolve({ status: res.statusCode, data: raw }); }
            });
        });
        req.on('error', reject);
        if (bodyStr) req.write(bodyStr);
        req.end();
    });
}

/** Convert plain JS value → Firestore typed value */
function toFS(value) {
    if (value === null || value === undefined) return { nullValue: null };
    if (typeof value === 'string')  return { stringValue: value };
    if (typeof value === 'number')  return Number.isInteger(value) ? { integerValue: String(value) } : { doubleValue: value };
    if (typeof value === 'boolean') return { booleanValue: value };
    if (Array.isArray(value))       return { arrayValue: { values: value.map(toFS) } };
    if (typeof value === 'object') {
        const fields = {};
        for (const [k, v] of Object.entries(value)) fields[k] = toFS(v);
        return { mapValue: { fields } };
    }
}

/** Convert Firestore typed value → plain JS value */
function fromFS(v) {
    if (!v) return null;
    if ('stringValue'  in v) return v.stringValue;
    if ('integerValue' in v) return parseInt(v.integerValue);
    if ('doubleValue'  in v) return v.doubleValue;
    if ('booleanValue' in v) return v.booleanValue;
    if ('nullValue'    in v) return null;
    if ('arrayValue'   in v) return (v.arrayValue.values || []).map(fromFS);
    if ('mapValue'     in v) {
        const obj = {};
        for (const [k, fv] of Object.entries(v.mapValue.fields || {})) obj[k] = fromFS(fv);
        return obj;
    }
}

// ─── Load State from Firebase on Startup ─────────────────────────────────────
async function loadStateFromFirebase() {
    try {
        const url = `${FIRESTORE_BASE}/${STATE_DOC}?key=${FIREBASE_API_KEY}`;
        const res = await httpsRequest(url);

        if (res.status === 200 && res.data.fields) {
            const f = res.data.fields;

            if (f.currentPeriod) {
                // Resume exactly from the last saved period (which is the next period to be played)
                currentPeriod = BigInt(fromFS(f.currentPeriod));
            }
            if (f.gameHistory) {
                gameHistory = fromFS(f.gameHistory) || [];
            }

            console.log(`✅ Firebase se resume kiya → Period: ${currentPeriod.toString()}`);
            console.log(`✅ Last ${gameHistory.length} records history load hui`);
        } else if (res.status === 404) {
            console.log('⚠️  Firebase me koi saved state nahi mili, fresh start kar raha hai.');
        } else {
            console.warn('⚠️  Firebase response unexpected:', res.status, JSON.stringify(res.data).slice(0, 200));
        }
    } catch (err) {
        console.error('❌ Firebase se state load karne me error:', err.message);
        console.log('Default state se start kar raha hai...');
    }
}

// ─── Save State to Firebase ───────────────────────────────────────────────────
async function saveStateToFirebase() {
    try {
        // Keep only last 10 in Firebase (auto-delete older ones)
        const historyToSave = gameHistory.slice(0, 10);

        const body = {
            fields: {
                currentPeriod : toFS(currentPeriod.toString()),
                gameHistory   : toFS(historyToSave),
                lastUpdated   : toFS(Date.now())
            }
        };

        // updateMask ensures we only overwrite these 3 fields
        const mask = 'updateMask.fieldPaths=currentPeriod&updateMask.fieldPaths=gameHistory&updateMask.fieldPaths=lastUpdated';
        const url  = `${FIRESTORE_BASE}/${STATE_DOC}?key=${FIREBASE_API_KEY}&${mask}`;

        const res = await httpsRequest(url, 'PATCH', body);
        if (res.status !== 200) {
            console.error('❌ Firebase save failed (status', res.status, '):', JSON.stringify(res.data).slice(0, 300));
            console.log('\n👉 Fix: Firestore rules me "gameState" collection ko allow karo:');
            console.log('   match /gameState/{doc} { allow read, write: if true; }');
        }
    } catch (err) {
        console.error('❌ Firebase save error:', err.message);
    }
}

// ─── Game Loop ────────────────────────────────────────────────────────────────
const getResultColor = (num) => {
    if (num === 0) return 'red-violet';
    if (num === 5) return 'green-violet';
    if (num % 2 === 0) return 'red';
    return 'green';
};

function startGameLoop() {
    setInterval(async () => {
        timeLeft--;

        if (timeLeft <= 0) {
            const resultNumber = Math.floor(Math.random() * 10);
            const resultColor  = getResultColor(resultNumber);
            const resultSize   = resultNumber < 5 ? 'Small' : 'Big';

            const newResult = {
                period    : currentPeriod.toString(),
                result    : resultNumber,
                color     : resultColor,
                size      : resultSize,
                timestamp : Date.now()
            };

            // Prepend latest result, keep only last 10 in memory
            gameHistory.unshift(newResult);
            if (gameHistory.length > 10) gameHistory = gameHistory.slice(0, 10);

            currentPeriod++;
            timeLeft = 60;

            console.log(`📊 Period ${newResult.period} → Result: ${resultNumber} (${resultColor}, ${resultSize})`);

            // Save to Firebase (non-blocking — game loop doesn't wait for it)
            saveStateToFirebase().catch(() => {});
        }
    }, 1000);
}

// ─── API ──────────────────────────────────────────────────────────────────────
app.get('/api/game-state', (req, res) => {
    res.json({
        currentPeriod : currentPeriod.toString(),
        timeLeft      : timeLeft,
        gameHistory   : gameHistory.slice(0, 10),
        serverTime    : Date.now()
    });
});

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

app.get('/game', (req, res) => {
    res.sendFile(path.join(__dirname, 'game.html'));
});

// ─── Bootstrap ────────────────────────────────────────────────────────────────
async function startServer() {
    console.log('🔄 Firebase se last game state load ho raha hai...');
    await loadStateFromFirebase();

    app.listen(port, () => {
        console.log(`\n🚀 Server port ${port} pe chal raha hai`);
        console.log(`🎮 Game shuru hua Period: ${currentPeriod.toString()}`);
        console.log(`📜 History records loaded: ${gameHistory.length}\n`);
    });

    startGameLoop();
}

startServer();
