# 闪传 · Flashdrop

极简点对点文件传输——用 2 位取件码，无需账号，即传即走，自动销毁。

---

## 功能特性

- **2 位取件码**：00–99，输入即取，无需复制长链接
- **多码支持**：一次上传可生成最多 5 个独立取件码（适合分发给不同接收者）
- **纯文字传输**：不上传文件也能分享一段文本
- **自动销毁**：取件码消耗后文件即从服务器删除；未被取走的文件在设定时限内自动清除
- **灵活时效**：1 小时 / 10 小时 / 1 天 / 3 天 / 7 天
- **直达链接**：`https://your-domain.com/42`，扫码或点击直接进入取件页
- **下载追踪**：前端显示每个文件的下载进度与速度，全部下载完成后出现「完成」按钮
- **无构建工具**：前端用 [HTM](https://github.com/developit/htm) 代替 Babel，零编译，CDN 直接加载

---

## 快速开始

### 环境要求

- Node.js ≥ 18

### 安装与启动

```bash
git clone https://github.com/your-name/flashdrop.git
cd flashdrop
npm install
npm start          # 生产模式，端口 3000
# 或
npm run dev        # 开发模式，nodemon 热重载
```

访问 [http://localhost:3000](http://localhost:3000)

### 自定义端口

```bash
PORT=8080 npm start
```

---

## 项目结构

```
flashdrop/
├── server.js          # Express 后端
├── public/
│   └── index.html     # 前端单页应用（React 18 + HTM + Tailwind CSS）
├── uploads/           # 上传文件临时存储（自动创建）
├── data/
│   └── codes.json     # 取件码持久化（自动创建，重启后恢复）
└── package.json
```

---

## 技术栈

### 后端

| 技术 | 用途 |
|------|------|
| Express 4 | HTTP 服务器 |
| Multer | 文件上传（multipart/form-data） |
| uuid | 下载 Token 生成 |
| Node.js `fs` | 文件管理 + JSON 持久化 |

### 前端

| 技术 | 用途 |
|------|------|
| React 18（CDN） | UI 框架 |
| HTM 3（CDN） | JSX-like 模板，无需编译 |
| Tailwind CSS（CDN） | 样式 |
| Font Awesome 6（CDN） | 图标 |

---

## API 文档

### `POST /api/upload`

上传文件或文字，生成取件码。

**Request**：`multipart/form-data`

| 字段 | 类型 | 说明 |
|------|------|------|
| `files` | File[] | 文件（可选，支持多文件） |
| `message` | string | 文字内容（可选，最多 5000 字） |
| `retention` | string | 有效期：`1h` / `10h` / `1d` / `3d` / `7d`，默认 `10h` |
| `quantity` | number | 生成取件码数量 1–5，默认 1 |

**Response 200**

```json
{ "codes": ["07", "42"] }
```

**限流**：每 IP 每分钟最多 10 次

---

### `POST /api/verify`

核销取件码，获取下载 Token。

**Request**：`application/json`

```json
{ "code": "42" }
```

**Response 200**

```json
{
  "token": "uuid-v4",
  "message": "可选文字内容",
  "files": [
    { "name": "report.pdf", "size": 102400, "url": "/api/download/token/0" }
  ]
}
```

**说明**：取件码核销后即从数据库删除（一次性）；Token 有效期 30 分钟。

**限流**：每 IP 每分钟最多 30 次

---

### `GET /api/download/:token/:index`

下载单个文件。

| 参数 | 说明 |
|------|------|
| `token` | `/api/verify` 返回的 Token |
| `index` | 文件列表下标（从 0 开始） |

响应为文件流（带 `Content-Disposition: attachment`）。

---

### `POST /api/destroy`

主动销毁 Token 并释放文件引用（接收方离开页面时自动调用）。

**Request**：`application/json`

```json
{ "token": "uuid-v4" }
```

响应 `200 OK`（无 body）。

---

### `GET /api/health`

健康检查。

```json
{ "ok": true, "codes": 3, "tokens": 1 }
```

---

## 配置说明

所有配置在 `server.js` 顶部的 `CFG` 对象中修改：

```js
const CFG = {
    MAX_STORAGE:    20 * 1024 ** 3,   // 服务器最大存储用量（超限自动清理最旧文件）
    MAX_FILE_SIZE:   5 * 1024 ** 3,   // 单文件最大体积
    FILE_LIFETIME:   7 * 24 * 3600_000 + 3_600_000, // 文件硬过期时间（兜底扫描）
    TOKEN_TTL:      30 * 60_000,      // 下载 Token 有效期
    CLEAN_INTERVAL: 60 * 60_000,      // 过期文件扫描间隔
    RL_WINDOW:       60_000,           // 限流窗口（毫秒）
    RL_UPLOAD:  10,                   // 上传接口每 IP 每窗口最大请求数
    RL_VERIFY:  30,                   // 验证接口每 IP 每窗口最大请求数
};
```

---

## 数据持久化

- 取件码与文件元信息保存到 `data/codes.json`
- 服务器重启后自动恢复有效取件码，并为每个码重新注册过期清理计时器
- 过期的或文件已丢失的记录会在恢复时自动跳过

---

## 部署建议

### Nginx 反向代理（推荐）

```nginx
server {
    listen 80;
    server_name your-domain.com;

    client_max_body_size 5g;       # 与 CFG.MAX_FILE_SIZE 保持一致

    location / {
        proxy_pass         http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header   Upgrade $http_upgrade;
        proxy_set_header   Connection 'upgrade';
        proxy_set_header   Host $host;
        proxy_set_header   X-Forwarded-For $remote_addr;
        proxy_read_timeout 600s;    # 大文件下载需要更长超时
        proxy_send_timeout 600s;
    }
}
```

### PM2 进程守护

```bash
npm install -g pm2
pm2 start server.js --name flashdrop
pm2 save
pm2 startup
```

---

## 安全说明

- 取件码**一次性消耗**，核销后立即从内存与持久化中删除
- 文件名经过特殊字符过滤（路径穿越防护）
- 响应头包含 `X-Content-Type-Options: nosniff`、`X-Frame-Options: SAMEORIGIN`、`Referrer-Policy`
- 内置 IP 级请求限流，防止暴力枚举取件码
- 接收方离开页面时通过 `sendBeacon` 主动销毁 Token 并释放文件

---

## License

MIT
