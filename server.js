"use strict";

const express       = require("express");
const helmet        = require("helmet");
const rateLimit     = require("express-rate-limit");
const Database      = require("better-sqlite3");
const path          = require("path");
const fs            = require("fs");
const crypto        = require("crypto");
const { spawn }     = require("child_process");

// ─── Config ──────────────────────────────────────────────────────────────────
const PORT         = Number(process.env.PORT || 3000);
const ROOT         = __dirname;
const PUBLIC       = path.join(ROOT, "public");
const JOBS_DIR     = path.join(ROOT, "jobs");
const DB_PATH      = path.join(ROOT, "whatsvid.db");
const MAX_WORKERS  = Number(process.env.MAX_WORKERS || 2);
const MAX_DURATION = Number(process.env.MAX_DURATION || 600); // 10 min
const YTDLP       = process.env.YTDLP_BIN  || "yt-dlp";
const FFMPEG      = process.env.FFMPEG_BIN || "ffmpeg";
const FFPRESET    = process.env.FFMPEG_PRESET || "veryfast";
const JOB_TTL_MS  = 30 * 60 * 1000; // 30 min

fs.mkdirSync(JOBS_DIR, { recursive: true });

// ─── SQLite setup ────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("synchronous = NORMAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS jobs (
    id        TEXT PRIMARY KEY,
    state     TEXT NOT NULL DEFAULT 'queued',
    progress  REAL NOT NULL DEFAULT 0,
    message   TEXT NOT NULL DEFAULT 'Queued',
    url       TEXT NOT NULL,
    quality   TEXT NOT NULL DEFAULT 'best',
    platform  TEXT NOT NULL DEFAULT 'youtube',
    clip_mode INTEGER NOT NULL DEFAULT 0,
    start_sec REAL,
    dur_sec   REAL,
    created   INTEGER NOT NULL,
    updated   INTEGER NOT NULL,
    dir       TEXT NOT NULL
  );
`);

const stmts = {
  insert:   db.prepare(`INSERT INTO jobs (id,state,progress,message,url,quality,platform,clip_mode,start_sec,dur_sec,created,updated,dir)
                        VALUES (@id,'queued',0,'Queued',@url,@quality,@platform,@clip_mode,@start_sec,@dur_sec,@now,@now,@dir)`),
  update:   db.prepare(`UPDATE jobs SET state=@state,progress=@progress,message=@message,updated=@now WHERE id=@id`),
  get:      db.prepare(`SELECT * FROM jobs WHERE id=?`),
  pending:  db.prepare(`SELECT id FROM jobs WHERE state IN ('queued','processing') ORDER BY created ASC`),
  oldJobs:  db.prepare(`SELECT id,dir FROM jobs WHERE created < ? AND state NOT IN ('processing')`),
  delete:   db.prepare(`DELETE FROM jobs WHERE id=?`),
};

function updateJob(id, patch) {
  stmts.update.run({ ...patch, now: Date.now(), id });
}

// ─── App setup ───────────────────────────────────────────────────────────────
const app = express();
app.disable("x-powered-by");
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: "32kb" }));
app.use(express.static(PUBLIC, {
  extensions: ["html"],
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
}));

const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 15,
  standardHeaders: "draft-8",
  legacyHeaders: false,
});

// ─── Validation ──────────────────────────────────────────────────────────────
const ALLOWED_HOSTS = new Set([
  "youtube.com", "www.youtube.com", "youtu.be", "m.youtube.com",
  "instagram.com", "www.instagram.com",
]);

const QUALITY_MAP = {
  "360p":  { ytdlp: "bv[height<=360]+ba/b[height<=360]/b", scale: "640:360"   },
  "480p":  { ytdlp: "bv[height<=480]+ba/b[height<=480]/b", scale: "854:480"   },
  "720p":  { ytdlp: "bv[height<=720]+ba/b[height<=720]/b", scale: "1280:720"  },
  "1080p": { ytdlp: "bv[height<=1080]+ba/b[height<=1080]/b", scale: "1920:1080" },
  "best":  { ytdlp: "bv*+ba/b",                             scale: null       },
};

function validUrl(raw) {
  try {
    const u = new URL(raw);
    if (!["http:", "https:"].includes(u.protocol)) return false;
    const host = u.hostname.toLowerCase().replace(/^www\./, "");
    return ALLOWED_HOSTS.has(u.hostname.toLowerCase()) || ALLOWED_HOSTS.has(host);
  } catch { return false; }
}

function detectPlatform(raw) {
  try {
    const host = new URL(raw).hostname.toLowerCase();
    if (host.includes("instagram")) return "instagram";
    return "youtube";
  } catch { return "youtube"; }
}

function parseTime(value) {
  if (typeof value !== "string") return NaN;
  const parts = value.trim().split(":").map(Number);
  if (parts.some(n => !Number.isFinite(n) || n < 0)) return NaN;
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return NaN;
}

// ─── Process runner ──────────────────────────────────────────────────────────
function runProcess(command, args, cwd, onLine) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, windowsHide: true });
    let stderr = "";
    child.stdout.on("data", d => onLine?.(d.toString(), "stdout"));
    child.stderr.on("data", d => {
      const s = d.toString();
      stderr += s;
      onLine?.(s, "stderr");
    });
    child.on("error", reject);
    child.on("close", code =>
      code === 0
        ? resolve()
        : reject(new Error(stderr.slice(-4000) || `Process exited ${code}`))
    );
  });
}

// ─── Job queue ───────────────────────────────────────────────────────────────
let activeWorkers = 0;
const queue = [];

function enqueue(id) {
  queue.push(id);
  drain();
}

function drain() {
  while (activeWorkers < MAX_WORKERS && queue.length > 0) {
    const id = queue.shift();
    activeWorkers++;
    processJob(id).finally(() => {
      activeWorkers--;
      drain();
    });
  }
}

// ─── Core job processor ──────────────────────────────────────────────────────
async function processJob(id) {
  const row = stmts.get.get(id);
  if (!row) return;

  const dir      = row.dir;
  const quality  = row.quality;
  const platform = row.platform;
  const isClip   = Boolean(row.clip_mode);
  const qmap     = QUALITY_MAP[quality] || QUALITY_MAP["best"];

  try {
    updateJob(id, { state: "processing", progress: 5, message: "Fetching video info…" });

    // ── yt-dlp download ───────────────────────────────────────────────────
    const ytArgs = [
      "--no-playlist",
      "--restrict-filenames",
      "--no-warnings",
      "-f", qmap.ytdlp,
      "-o", path.join(dir, "source.%(ext)s"),
    ];

    // Instagram: use --no-check-certificate + cookies-from-browser fallback
    if (platform === "instagram") {
      ytArgs.push("--no-check-certificate");
    }

    ytArgs.push(row.url);

    let dlProgress = 0;
    await runProcess(YTDLP, ytArgs, dir, (line) => {
      // Parse yt-dlp download progress: [download]  45.2% of ...
      const m = line.match(/\[download\]\s+([\d.]+)%/);
      if (m) {
        dlProgress = parseFloat(m[1]);
        // Map 0–100% yt-dlp → 5–65% overall
        const mapped = 5 + (dlProgress / 100) * 60;
        updateJob(id, { state: "processing", progress: Math.round(mapped), message: `Downloading… ${Math.round(dlProgress)}%` });
      }
    });

    const files = fs.readdirSync(dir).filter(f => f.startsWith("source."));
    if (!files.length) throw new Error("Source download produced no file.");
    const source = path.join(dir, files[0]);

    updateJob(id, { state: "processing", progress: 68, message: "Encoding MP4…" });

    // ── ffmpeg encode ────────────────────────────────────────────────────
    const ffArgs = ["-y"];

    if (isClip) {
      ffArgs.push("-ss", String(row.start_sec));
    }
    ffArgs.push("-i", source);
    if (isClip) {
      ffArgs.push("-t", String(row.dur_sec));
    }

    ffArgs.push(
      "-map", "0:v:0",
      "-map", "0:a:0?",
      "-c:v", "libx264",
      "-preset", FFPRESET,
      "-crf", "23",
    );

    if (qmap.scale) {
      ffArgs.push("-vf", `scale=${qmap.scale}:force_original_aspect_ratio=decrease,pad=${qmap.scale}:(ow-iw)/2:(oh-ih)/2:black`);
    }

    ffArgs.push(
      "-c:a", "aac",
      "-b:a", "128k",
      "-movflags", "+faststart",
      "-stats_period", "1",
      path.join(dir, "output.mp4"),
    );

    let lastProgress = 68;
    await runProcess(FFMPEG, ffArgs, dir, (line) => {
      // Parse ffmpeg progress from stderr
      if (/time=[\d:.]+/i.test(line)) {
        lastProgress = Math.min(97, lastProgress + 3);
        updateJob(id, { state: "processing", progress: lastProgress, message: "Encoding…" });
      }
    });

    try { fs.unlinkSync(source); } catch {}

    updateJob(id, { state: "complete", progress: 100, message: "Ready to download" });

  } catch (err) {
    const msg = /ENOENT|not found/i.test(err.message)
      ? "Server missing yt-dlp or ffmpeg — contact admin."
      : (err.message?.slice(0, 120) || "Processing failed.");
    updateJob(id, { state: "error", progress: 0, message: msg });
    console.error(`[job:${id}]`, err.message);
  }
}

// ─── API routes ───────────────────────────────────────────────────────────────
app.post("/api/jobs", apiLimiter, (req, res) => {
  const {
    url,
    quality   = "best",
    clip_mode = false,
    start     = "0:00",
    duration  = "0:30",
  } = req.body || {};

  if (!validUrl(url))
    return res.status(400).json({ error: "Enter a valid YouTube or Instagram URL." });

  if (!QUALITY_MAP[quality])
    return res.status(400).json({ error: "Invalid quality selection." });

  const platform = detectPlatform(url);
  let start_sec = null, dur_sec = null;

  if (clip_mode) {
    start_sec = parseTime(start);
    dur_sec   = parseTime(duration);
    if (!Number.isFinite(start_sec) || start_sec < 0)
      return res.status(400).json({ error: "Invalid start time." });
    if (!Number.isFinite(dur_sec) || dur_sec <= 0 || dur_sec > MAX_DURATION)
      return res.status(400).json({ error: `Duration must be 1s–${MAX_DURATION / 60} min.` });
  }

  const id  = crypto.randomBytes(16).toString("hex");
  const dir = path.join(JOBS_DIR, id);
  fs.mkdirSync(dir);

  stmts.insert.run({
    id, url, quality, platform,
    clip_mode: clip_mode ? 1 : 0,
    start_sec, dur_sec,
    now: Date.now(),
    dir,
  });

  enqueue(id);
  res.status(202).json({ id });
});

app.get("/api/jobs/:id", (req, res) => {
  const row = stmts.get.get(req.params.id);
  if (!row) return res.status(404).json({ error: "Job not found." });
  res.json({
    state:    row.state,
    progress: row.progress,
    message:  row.message,
    platform: row.platform,
    quality:  row.quality,
    download: row.state === "complete" ? `/api/jobs/${row.id}/download` : null,
  });
});

app.get("/api/jobs/:id/download", (req, res) => {
  const row = stmts.get.get(req.params.id);
  if (!row || row.state !== "complete")
    return res.status(404).send("File not ready.");
  const file = path.join(row.dir, "output.mp4");
  if (!fs.existsSync(file))
    return res.status(410).send("File expired.");
  const label = `whatsvid-${row.platform}-${row.quality}.mp4`;
  res.download(file, label);
});

// ─── Cleanup ──────────────────────────────────────────────────────────────────
function cleanupJob(id, dir) {
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  stmts.delete.run(id);
}

setInterval(() => {
  const cutoff = Date.now() - JOB_TTL_MS;
  const old = stmts.oldJobs.all(cutoff);
  for (const { id, dir } of old) cleanupJob(id, dir);
}, 5 * 60 * 1000).unref();

// On startup: re-queue any jobs that were left in 'queued'/'processing' (crash recovery)
;(function recoverJobs() {
  const stuck = stmts.pending.all();
  for (const { id } of stuck) {
    updateJob(id, { state: "queued", progress: 0, message: "Recovering…" });
    enqueue(id);
  }
  if (stuck.length) console.log(`[startup] Recovered ${stuck.length} stuck job(s)`);
})();

// ─── Fallback ─────────────────────────────────────────────────────────────────
app.get("*", (_, res) => res.sendFile(path.join(PUBLIC, "index.html")));

app.listen(PORT, () =>
  console.log(`WhatsVid v2 running → http://localhost:${PORT}`)
);