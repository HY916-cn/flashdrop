const express = require('express');
const multer = require('multer');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;

// ==========================================
// 规范化专业日志系统
// ==========================================
const log = (level, action, message) => {
    const time = new Date().toLocaleString('zh-CN', { 
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hour12: false 
    });
    console.log(`[${time}] Flashdrop | [${level}] ${action} - ${message}`);
};

app.use(cors({
    exposedHeaders: ['Content-Length']
}));
app.use(express.json());
app.use(express.text({ type: ['text/plain', 'application/json'] }));
app.use(express.static(path.join(__dirname, 'public')));

// 全局容量与时间设置
const MAX_TOTAL_STORAGE = 20 * 1024 * 1024 * 1024; // 20GB 
const MAX_FILE_SIZE = 5 * 1024 * 1024 * 1024;      // 5GB 

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) {
    fs.mkdirSync(uploadDir, { recursive: true });
}

const storage = multer.diskStorage({
    destination: (req, file, cb) => cb(null, uploadDir),
    filename: (req, file, cb) => {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + '-' + Buffer.from(file.originalname, 'latin1').toString('utf8'));
    }
});
const upload = multer({ 
    storage: storage,
    limits: { fileSize: MAX_FILE_SIZE } 
});

const codesDB = new Map();     
const activeTokens = new Map();

/**
 * 20GB 容量巡检清理机制
 */
const enforceStorageLimit = () => {
    fs.readdir(uploadDir, (err, files) => {
        if (err) return;
        let fileStats = [];
        files.forEach(file => {
            const filePath = path.join(uploadDir, file);
            try {
                const stats = fs.statSync(filePath);
                fileStats.push({ path: filePath, size: stats.size, mtime: stats.mtimeMs });
            } catch (e) {}
        });

        let totalSize = fileStats.reduce((sum, f) => sum + f.size, 0);
        
        if (totalSize > MAX_TOTAL_STORAGE) {
            log('WARN', 'SYSTEM', `总容量已达 ${(totalSize / 1024 / 1024 / 1024).toFixed(2)}GB，触发旧文件清理`);
            fileStats.sort((a, b) => a.mtime - b.mtime);
            for (let f of fileStats) {
                if (totalSize <= MAX_TOTAL_STORAGE) break;
                try {
                    fs.unlinkSync(f.path);
                    totalSize -= f.size;
                    log('INFO', 'CLEANUP', `成功释放超载旧文件: ${path.basename(f.path)}`);
                } catch(e) {}
            }
        }
    });
};

/**
 * 托底清扫：定时抹除 7 天前的僵尸文件
 */
const MAX_SAFE_LIFETIME = 7 * 24 * 60 * 60 * 1000 + 3600 * 1000;
setInterval(() => {
    const now = Date.now();
    fs.readdir(uploadDir, (err, files) => {
        if (err) return;
        files.forEach(file => {
            const filePath = path.join(uploadDir, file);
            fs.stat(filePath, (err, stats) => {
                if (!err && (now - stats.mtimeMs > MAX_SAFE_LIFETIME)) {
                    try { fs.unlinkSync(filePath); } catch(e) {}
                }
            });
        });
    });
}, 60 * 60 * 1000);

/**
 * 接口1：上传并批量生成 00-99 取件码
 */
app.post('/api/upload', (req, res) => {
    const reqIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    upload.array('files')(req, res, (err) => {
        if (err instanceof multer.MulterError && err.code === 'LIMIT_FILE_SIZE') {
            log('WARN', 'UPLOAD', `IP: ${reqIp} 的上传被拒绝 (超出2GB防爆拦截)`);
            return res.status(400).json({ error: '上传失败：文件大小超出 2GB 限制' });
        } else if (err) {
            log('ERROR', 'UPLOAD', `上传异常: ${err.message}`);
            return res.status(500).json({ error: '上传异常' });
        }

        try {
            const files = req.files || [];
            const message = req.body.message || '';
            
            // 解析数量要求 (1 ~ 5)
            let reqQuantity = parseInt(req.body.quantity) || 1;
            if (reqQuantity < 1) reqQuantity = 1;
            if (reqQuantity > 5) reqQuantity = 5;

            // 解析用户定制生命周期
            let reqRetention = req.body.retention || '10h';
            let lifeTime = 10 * 3600000;
            if (reqRetention === '1h') lifeTime = 3600000;
            if (reqRetention === '1d') lifeTime = 24 * 3600000;
            if (reqRetention === '3d') lifeTime = 3 * 24 * 3600000;
            if (reqRetention === '7d') lifeTime = 7 * 24 * 3600000;

            const codes = [];
            for (let i = 0; i < reqQuantity; i++) {
                let code;
                let attempts = 0;
                do {
                    code = String(Math.floor(Math.random() * 100)).padStart(2, '0');
                    attempts++;
                    if (attempts > 200) {
                        log('ERROR', 'SYSTEM', '高并发警告，取件码池已满');
                        return res.status(500).json({ error: '取件码暂满，请稍后再试' });
                    }
                } while (codesDB.has(code) || codes.includes(code));
                codes.push(code);
            }

            const fileData = files.map(f => ({
                name: Buffer.from(f.originalname, 'latin1').toString('utf8'),
                size: f.size,
                path: f.path 
            }));

            // 【内存引用计数算法】所有独立码共享同一份文件的销毁权
            const sharedRef = { count: reqQuantity };
            const expiresAt = Date.now() + lifeTime;

            codes.forEach(c => {
                codesDB.set(c, { files: fileData, message, expiresAt, sharedRef });
            });

            log('INFO', 'UPLOAD', `上传成功 | IP: ${reqIp} | 签发取件码: [${codes.join(', ')}] | 有效期: ${reqRetention}`);

            // 挂载生命周期结束时的物理销毁任务
            setTimeout(() => {
                codes.forEach(c => codesDB.delete(c));
                fileData.forEach(f => {
                    try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch(e){}
                });
                log('INFO', 'TIMEOUT', `生命周期结束 | 批次 [${codes.join(', ')}] 已从系统被强制物理销毁`);
            }, lifeTime);

            enforceStorageLimit();

            res.json({ codes });
        } catch (error) {
            log('ERROR', 'UPLOAD', `服务器内部异常: ${error.message}`);
            res.status(500).json({ error: '服务器错误' });
        }
    });
});

/**
 * 接口2：验证
 */
app.post('/api/verify', (req, res) => {
    const reqIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
    let code = req.body.code;
    
    if (!code && typeof req.body === 'string') {
        try { code = JSON.parse(req.body).code; } catch(e) {}
    }
    
    if (!code || !codesDB.has(code)) {
        log('WARN', 'VERIFY', `IP: ${reqIp} 校验拒绝 | 无效取件码: [${code || '空'}]`);
        return res.status(404).json({ error: '无效码' });
    }

    const data = codesDB.get(code);
    if (Date.now() > data.expiresAt) {
        codesDB.delete(code);
        log('WARN', 'VERIFY', `IP: ${reqIp} 校验拒绝 | 取件码 [${code}] 已过期`);
        return res.status(404).json({ error: '已过期' });
    }

    codesDB.delete(code); 
    const token = uuidv4();
    activeTokens.set(token, data);

    log('INFO', 'VERIFY', `校验成功 | IP: ${reqIp} | 取件码: [${code}] 被消耗并签发准入 Token`);

    // 僵尸Token清理（防占空间：如果提取了但不下载，30分钟强制减1次引用）
    setTimeout(() => {
        if (activeTokens.has(token)) {
            const tokenData = activeTokens.get(token);
            activeTokens.delete(token);
            
            tokenData.sharedRef.count--;
            if (tokenData.sharedRef.count <= 0) {
                tokenData.files.forEach(f => {
                    try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch(e){}
                });
                log('INFO', 'TIMEOUT', `僵尸Token超时清理完成，所有引用提取完毕，已物理粉碎`);
            }
        }
    }, 30 * 60 * 1000);

    const safeFiles = data.files.map(f => ({ name: f.name, size: f.size, url: `/api/download/${token}/${f.name}` }));
    res.json({ token, files: safeFiles, message: data.message });
});

/**
 * 接口3：前端退出即焚
 */
app.post('/api/destroy', (req, res) => {
    try {
        let token;
        if (req.body && req.body.token) token = req.body.token;
        else if (typeof req.body === 'string') token = JSON.parse(req.body).token;

        if (token && activeTokens.has(token)) {
            const tokenData = activeTokens.get(token);
            activeTokens.delete(token);
            
            tokenData.sharedRef.count--;
            if (tokenData.sharedRef.count <= 0) {
                tokenData.files.forEach(f => {
                    try { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); } catch(e){}
                });
                log('INFO', 'DESTROY', `接收客户端销毁指令 | 全部提取完毕，已彻底物理粉碎本地文件`);
            } else {
                log('INFO', 'DESTROY', `接收客户端销毁指令 | 暂留物理文件 (剩余未使用取件码: ${tokenData.sharedRef.count} 个)`);
            }
        }
    } catch (e) {}
    res.sendStatus(200);
});

/**
 * 接口4：流媒体下载
 * 【重要修复】移除了传输完成后的 fs.unlinkSync()，因为大文件分片可能被此语句拦截。
 */
app.get('/api/download/:token/:fileIndex', (req, res) => {
    const { token, fileIndex } = req.params;
    const reqIp = req.headers['x-forwarded-for'] || req.socket.remoteAddress;

    if (!activeTokens.has(token)) {
        log('WARN', 'DOWNLOAD', `拒绝下载 | IP: ${reqIp} | Token无效或已过期`);
        return res.status(404).send('失效');
    }

    const data = activeTokens.get(token);
    const file = data.files[parseInt(fileIndex)];

    if (!file || !fs.existsSync(file.path)) {
        log('ERROR', 'DOWNLOAD', `下载中断 | IP: ${reqIp} | 文件在服务器底层丢失`);
        return res.status(404).send('不存在');
    }

    log('INFO', 'DOWNLOAD', `开始传输 | IP: ${reqIp} | 文件名: ${file.name}`);

    // 这里仅做纯粹的下载，不再参杂任何强行删除代码，保证百兆大文件能够满速跑完
    res.download(file.path, file.name, (err) => {
        if (err) {
            log('ERROR', 'DOWNLOAD', `传输中断或取消 | IP: ${reqIp} | 文件名: ${file.name}`);
        } else {
            log('INFO', 'DOWNLOAD', `传输成功完成 | IP: ${reqIp} | 文件名: ${file.name}`);
        }
    });
});

app.listen(PORT, () => {
    log('INFO', 'SYSTEM', `服务器已就绪，当前监听端口: ${PORT}`);
});