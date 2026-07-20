const express = require('express');
const multer  = require('multer');
const cors    = require('cors');
const fs      = require('fs');
const path    = require('path');
const { v4: uuidv4 } = require('uuid');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── Config ────────────────────────────────────────────────────────────────────
const CFG = {
    MAX_STORAGE:   20 * 1024 ** 3,          // 20 GB
    MAX_FILE_SIZE:  5 * 1024 ** 3,          // 5 GB per file
    FILE_LIFETIME:  7 * 24 * 3600_000 + 3_600_000, // 7d + 1h grace
    TOKEN_TTL:     30 * 60_000,             // 30 min
    CLEAN_INTERVAL: 60 * 60_000,            // hourly sweep
    RL_WINDOW:      60_000,
    RL_UPLOAD:  10,                         // per-IP per minute
    RL_VERIFY:  30,
    RETENTION: {
        '1h':  1 * 3_600_000,
        '10h': 10 * 3_600_000,
        '1d':  24 * 3_600_000,
        '3d':  3 * 24 * 3_600_000,
        '7d':  7 * 24 * 3_600_000,
    },
};

const UPLOAD_DIR = path.join(__dirname, 'uploads');
const DATA_DIR   = path.join(__dirname, 'data');
const DB_FILE    = path.join(DATA_DIR, 'codes.json');

// ── Logging ───────────────────────────────────────────────────────────────────
const CLR = { INFO: '\x1b[32m', WARN: '\x1b[33m', ERROR: '\x1b[31m', R: '\x1b[0m' };
const log = (level, action, msg) => {
    const ts = new Date().toLocaleString('zh-CN', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    console.log(`${CLR[level] || ''}[${ts}] ${level.padEnd(5)} │ ${action.padEnd(8)} │ ${msg}${CLR.R}`);
};

// ── Init dirs ─────────────────────────────────────────────────────────────────
for (const dir of [UPLOAD_DIR, DATA_DIR]) {
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

// ── Multer ────────────────────────────────────────────────────────────────────
const upload = multer({
    storage: multer.diskStorage({
        destination: (req, file, cb) => cb(null, UPLOAD_DIR),
        filename: (req, file, cb) => {
            const safeName = file.originalname.replace(/[/\\?%*:|"<>]/g, '_');
            cb(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}`);
        },
    }),
    limits: { fileSize: CFG.MAX_FILE_SIZE },
    defParamCharset: 'utf8',
});

// ── In-memory DB + JSON persistence ──────────────────────────────────────────
const codesDB      = new Map();
const activeTokens = new Map();

const serializeDB = () => JSON.stringify(
    [...codesDB.entries()].map(([c, d]) => [c, { ...d, sharedRef: { count: d.sharedRef.count } }]),
);

// Atomic + coalesced persistence: write to a temp file then rename (so a crash
// mid-write can never corrupt codes.json), and collapse bursts of saveDB() calls
// into a single trailing write to avoid concurrent writers racing on the temp file.
let saving = false, saveQueued = false;
const saveDB = () => {
    if (saving) { saveQueued = true; return; }
    saving = true;
    let payload;
    try { payload = serializeDB(); }
    catch (e) { saving = false; return log('ERROR', 'DB', `序列化失败: ${e.message}`); }

    const tmp = `${DB_FILE}.tmp`;
    const done = (err, stage) => {
        saving = false;
        if (err) log('ERROR', 'DB', `${stage}失败: ${err.message}`);
        if (saveQueued) { saveQueued = false; saveDB(); }
    };
    fs.writeFile(tmp, payload, err => {
        if (err) return done(err, '写入');
        fs.rename(tmp, DB_FILE, e => done(e, '落盘'));
    });
};

const loadDB = () => {
    try {
        if (!fs.existsSync(DB_FILE)) return;
        const now  = Date.now();
        const rows = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));

        // Keep only rows that are still valid: not expired and with files intact.
        const valid = rows.filter(([, d]) =>
            d.expiresAt > now && d.files.every(f => fs.existsSync(f.path)));

        // Group surviving codes back into their upload batch. Codes issued together
        // must share ONE reference counter and one expiry timer — a relationship JSON
        // can't encode — so we rebuild it here. The count is reset to the number of
        // codes that actually survived, which also releases references that were held
        // by download tokens lost on restart (tokens are in-memory only).
        const batches = new Map();
        for (const [code, d] of valid) {
            const key = d.bid || `solo:${code}`; // pre-batch-id data: each code is its own batch
            const batch = batches.get(key)
                || batches.set(key, { data: d, codes: [] }).get(key);
            batch.codes.push(code);
        }

        let ok = 0;
        for (const { data, codes } of batches.values()) {
            // One entry object shared by every code in the batch → one sharedRef.
            const entry = { ...data, sharedRef: { count: codes.length } };
            codes.forEach(c => codesDB.set(c, entry));
            setTimeout(() => {
                codes.forEach(c => codesDB.delete(c));
                entry.files.forEach(f => { try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {} });
                saveDB();
                log('INFO', 'EXPIRE', `[${codes.join(', ')}] 恢复批次到期，已清理`);
            }, data.expiresAt - now);
            ok += codes.length;
        }
        const skip = rows.length - ok;
        if (ok || skip) log('INFO', 'SYSTEM', `恢复 ${ok} 个取件码，跳过 ${skip} 条过期记录`);
    } catch (e) { log('WARN', 'SYSTEM', `DB 恢复失败: ${e.message}`); }
};

loadDB();

// ── Rate limiter ──────────────────────────────────────────────────────────────
const rlStore = new Map();

const rateLimit = (max, win) => (req, res, next) => {
    const ip  = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
    const key = `${req.path}|${ip}`;
    const now = Date.now();
    const rec = rlStore.get(key) || { n: 0, reset: now + win };
    if (now > rec.reset) { rec.n = 0; rec.reset = now + win; }
    if (++rec.n > max) {
        rlStore.set(key, rec);
        log('WARN', 'RATELMT', `IP ${ip} 已限流`);
        return res.status(429).json({ error: '请求频率过高，请稍候再试' });
    }
    rlStore.set(key, rec);
    next();
};

// ── Middleware ────────────────────────────────────────────────────────────────
app.use((_, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
});
app.use(cors({ exposedHeaders: ['Content-Length', 'Content-Disposition'] }));
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Helpers ───────────────────────────────────────────────────────────────────
const getIp = (req) =>
    (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();

const releaseFiles = (d) => {
    d.sharedRef.count--;
    if (d.sharedRef.count <= 0) {
        d.files.forEach(f => { try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {} });
        saveDB();
        return true;
    }
    saveDB();
    return false;
};

const enforceStorage = () => {
    fs.readdir(UPLOAD_DIR, (err, files) => {
        if (err) return;
        const stats = files.flatMap(f => {
            try {
                const fp = path.join(UPLOAD_DIR, f);
                const s  = fs.statSync(fp);
                return [{ path: fp, size: s.size, mtime: s.mtimeMs }];
            } catch { return []; }
        });
        let total = stats.reduce((s, f) => s + f.size, 0);
        if (total <= CFG.MAX_STORAGE) return;
        log('WARN', 'STORAGE', `${(total / 1024 ** 3).toFixed(2)} GB 超限，清理旧文件`);
        for (const f of stats.sort((a, b) => a.mtime - b.mtime)) {
            if (total <= CFG.MAX_STORAGE) break;
            try { fs.unlinkSync(f.path); total -= f.size; } catch {}
        }
    });
};

// ── Periodic tasks ────────────────────────────────────────────────────────────
setInterval(() => {
    const now = Date.now();
    fs.readdir(UPLOAD_DIR, (err, files) => {
        if (err) return;
        files.forEach(f => {
            const fp = path.join(UPLOAD_DIR, f);
            fs.stat(fp, (e, s) => {
                if (!e && now - s.mtimeMs > CFG.FILE_LIFETIME) try { fs.unlinkSync(fp); } catch {}
            });
        });
    });
}, CFG.CLEAN_INTERVAL);

setInterval(() => {
    const now = Date.now();
    for (const [k, r] of rlStore) if (now > r.reset) rlStore.delete(k);
}, 5 * 60_000);

// ── Routes ────────────────────────────────────────────────────────────────────

app.post('/api/upload', rateLimit(CFG.RL_UPLOAD, CFG.RL_WINDOW), (req, res) => {
    const ip = getIp(req);
    upload.array('files')(req, res, err => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE')
            return res.status(400).json({ error: '文件大小超出 5GB 限制' });
        if (err) { log('ERROR', 'UPLOAD', err.message); return res.status(500).json({ error: '上传异常' }); }

        try {
            const files    = req.files || [];
            const message  = (req.body.message || '').slice(0, 10000).trim();
            const quantity = Math.max(1, Math.min(5, parseInt(req.body.quantity) || 1));
            const lifeTime = CFG.RETENTION[req.body.retention] ?? CFG.RETENTION['10h'];
            const retKey   = CFG.RETENTION[req.body.retention] != null ? req.body.retention : '10h';

            if (!files.length && !message)
                return res.status(400).json({ error: '请上传文件或输入文字内容' });

            // Generate unique pickup codes
            const codes = [];
            let tries = 0;
            while (codes.length < quantity) {
                if (++tries > 300)
                    return res.status(503).json({ error: '取件码资源紧张，请稍后再试' });
                const c = String(Math.floor(Math.random() * 100)).padStart(2, '0');
                if (!codesDB.has(c) && !codes.includes(c)) codes.push(c);
            }

            const fileData  = files.map(f => ({
                name: f.originalname,
                size: f.size,
                path: f.path,
            }));
            const sharedRef = { count: quantity };
            const expiresAt = Date.now() + lifeTime;
            const bid       = uuidv4(); // batch id: lets loadDB regroup shared codes after a restart
            codes.forEach(c => codesDB.set(c, { files: fileData, message, expiresAt, sharedRef, bid }));
            saveDB();
            log('INFO', 'UPLOAD', `IP ${ip} | [${codes.join(', ')}] | ${retKey} | ${files.length} 文件`);

            setTimeout(() => {
                codes.forEach(c => codesDB.delete(c));
                fileData.forEach(f => { try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch {} });
                saveDB();
                log('INFO', 'EXPIRE', `[${codes.join(', ')}] 到期，文件已销毁`);
            }, lifeTime);

            enforceStorage();
            res.json({ codes });
        } catch (e) {
            log('ERROR', 'UPLOAD', e.message);
            res.status(500).json({ error: '服务器内部错误' });
        }
    });
});

app.post('/api/verify', rateLimit(CFG.RL_VERIFY, CFG.RL_WINDOW), (req, res) => {
    const ip   = getIp(req);
    const { code } = req.body;

    if (!code || !/^\d{2}$/.test(code))
        return res.status(400).json({ error: '取件码格式错误' });

    const data = codesDB.get(code);
    if (!data) {
        log('WARN', 'VERIFY', `IP ${ip} | 无效码 [${code}]`);
        return res.status(404).json({ error: '无效取件码' });
    }
    if (Date.now() > data.expiresAt) {
        codesDB.delete(code); saveDB();
        log('WARN', 'VERIFY', `IP ${ip} | 已过期码 [${code}]`);
        return res.status(404).json({ error: '取件码已过期' });
    }

    codesDB.delete(code); saveDB();
    const token = uuidv4();
    activeTokens.set(token, data);
    log('INFO', 'VERIFY', `IP ${ip} | 码 [${code}] 消耗，Token 已签发`);

    setTimeout(() => {
        if (!activeTokens.has(token)) return;
        const d = activeTokens.get(token);
        activeTokens.delete(token);
        releaseFiles(d);
        log('INFO', 'EXPIRE', 'Token 超时，自动回收');
    }, CFG.TOKEN_TTL);

    res.json({
        token,
        files: data.files.map((f, i) => ({ name: f.name, size: f.size, url: `/api/download/${token}/${i}` })),
        message: data.message,
    });
});

app.get('/api/download/:token/:index', (req, res) => {
    const { token } = req.params;
    const index = parseInt(req.params.index);
    const ip = getIp(req);

    const data = activeTokens.get(token);
    if (!data) return res.status(404).json({ error: 'Token 无效或已过期' });
    if (isNaN(index) || index < 0 || index >= data.files.length)
        return res.status(400).json({ error: '无效文件索引' });

    const file = data.files[index];
    if (!fs.existsSync(file.path)) {
        log('ERROR', 'DOWNLOAD', `IP ${ip} | 文件丢失: ${file.name}`);
        return res.status(404).json({ error: '文件已被销毁' });
    }

    log('INFO', 'DOWNLOAD', `IP ${ip} | ${file.name}`);
    res.download(file.path, file.name, err => {
        if (err && !res.headersSent) log('ERROR', 'DOWNLOAD', `传输中断: ${err.message}`);
    });
});

app.post('/api/destroy', (req, res) => {
    const { token } = req.body || {};
    if (token && activeTokens.has(token)) {
        const d    = activeTokens.get(token);
        activeTokens.delete(token);
        const done = releaseFiles(d);
        log('INFO', 'DESTROY', done ? '文件已彻底销毁' : `引用剩余 ${d.sharedRef.count}`);
    }
    res.sendStatus(200);
});

app.get('/api/health', (_, res) =>
    res.json({ ok: true, codes: codesDB.size, tokens: activeTokens.size }),
);

app.get('/:code([0-9]{2})', (req, res) =>
    res.sendFile(path.join(__dirname, 'public', 'index.html')),
);

app.get('*', (req, res) => res.redirect('/'));

const server = app.listen(PORT, () => log('INFO', 'SYSTEM', `Flashdrop 已就绪 | 端口 ${PORT}`));

// ── Graceful shutdown ─────────────────────────────────────────────────────────
// Flush the DB synchronously so nothing is lost when the process is stopped.
const shutdown = (sig) => {
    log('INFO', 'SYSTEM', `${sig} 收到，正在保存并退出`);
    try { fs.writeFileSync(DB_FILE, serializeDB()); }
    catch (e) { log('ERROR', 'DB', `退出保存失败: ${e.message}`); }
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref(); // don't hang on lingering connections
};
process.on('SIGINT',  () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
