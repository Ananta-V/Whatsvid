# WhatsVid v2

Production-grade YouTube & Instagram → MP4 downloader with quality selection and optional clipping.

## What's new in v2

| Feature | v1 | v2 |
|---|---|---|
| Job persistence | In-memory (lost on restart) | **SQLite (WAL mode)** |
| Crash recovery | ❌ | ✅ Re-queues stuck jobs on startup |
| Platforms | YouTube only | **YouTube + Instagram** |
| Quality | Fixed 720p | **360p / 480p / 720p / 1080p / Best** |
| Download progress | Rough guess | **Real yt-dlp % parsed from output** |
| Concurrency | Unlimited | **Capped (default: 2 workers)** |
| Clip mode | Always on | **Optional toggle** |
| Cleanup on crash | ❌ | ✅ Recovered on startup |

---

## Requirements

- **Node.js** 18+
- **yt-dlp** — [install guide](https://github.com/yt-dlp/yt-dlp#installation)
- **ffmpeg** — [install guide](https://ffmpeg.org/download.html)

```bash
# Quick check
yt-dlp --version
ffmpeg -version
```

---

## Setup

```bash
npm install
npm start
# → http://localhost:3000
```

### Environment variables (all optional)

| Variable | Default | Description |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `YTDLP_BIN` | `yt-dlp` | Path to yt-dlp binary |
| `FFMPEG_BIN` | `ffmpeg` | Path to ffmpeg binary |
| `FFMPEG_PRESET` | `veryfast` | ffmpeg speed preset (`ultrafast` → `veryslow`) |
| `MAX_WORKERS` | `2` | Max parallel download jobs |
| `MAX_DURATION` | `600` | Max clip duration in seconds |

---

## Architecture

```
whatsvid/
├── server.js          # Express app + SQLite queue + job processor
├── public/
│   └── index.html     # Single-file frontend (no build step)
├── whatsvid.db        # SQLite — auto-created on first run
├── jobs/              # Temp dirs per job — auto-cleaned after 30 min
└── package.json
```

### Job lifecycle

```
POST /api/jobs → queued → processing → complete
                                    ↘ error
```

Jobs are persisted in SQLite. On server restart, any jobs still in
`queued` or `processing` state are automatically re-queued.

---

## Production deployment (PM2)

```bash
npm install -g pm2
NODE_ENV=production pm2 start server.js --name whatsvid
pm2 save
```

### Nginx reverse proxy

```nginx
location / {
    proxy_pass         http://127.0.0.1:3000;
    proxy_http_version 1.1;
    proxy_set_header   Upgrade $http_upgrade;
    proxy_set_header   Connection 'upgrade';
    proxy_set_header   Host $host;
    proxy_cache_bypass $http_upgrade;
    client_max_body_size 1m;
}
```

---

## Notes on Instagram

Instagram requires authentication for many videos. If downloads fail:
1. Log into Instagram in your browser
2. Export cookies: use [yt-dlp's cookie guide](https://github.com/yt-dlp/yt-dlp/wiki/FAQ#how-do-i-pass-cookies-to-yt-dlp)
3. Set `YTDLP_COOKIES=/path/to/cookies.txt` and add `--cookies` to the ytArgs in `server.js`

Public Reels typically work without login.
