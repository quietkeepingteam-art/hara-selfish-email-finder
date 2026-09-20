// Hara Selfish Emailer
// Local server: serves bulk-mailer.html and does the actual SMTP sending,
// since browsers can't open raw SMTP connections themselves.
//
// Run:  npm install   then   npm start
// Open: http://localhost:3000/bulk-mailer.html

const express = require('express');
const nodemailer = require('nodemailer');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(__dirname));

// Point this at your real listings.json if it lives somewhere else, e.g.:
//   set LISTINGS_PATH=C:\Users\JamesAdmin\Documents\DFW\Website2\listings.json
const LISTINGS_PATH = process.env.LISTINGS_PATH || path.join(__dirname, 'listings.json');

// All generated files (sent-log.json) go into a single "hara-tools-output"
// folder next to listings.json — the same folder the email finder uses —
// so one .gitignore entry covers everything from both tools.
const PROJECT_DIR = path.dirname(LISTINGS_PATH);
const OUTPUT_DIR = path.join(PROJECT_DIR, 'hara-tools-output', 'emailer');
const SENT_LOG_PATH = path.join(OUTPUT_DIR, 'sent-log.json');

function ensureGitignore(dir, entry) {
  const gitignorePath = path.join(dir, '.gitignore');
  let contents = '';
  try {
    contents = fs.readFileSync(gitignorePath, 'utf8');
  } catch {
    // no .gitignore yet — will be created
  }
  if (contents.split('\n').some((line) => line.trim() === entry)) return;
  const sep = contents && !contents.endsWith('\n') ? '\n' : '';
  fs.writeFileSync(gitignorePath, `${contents}${sep}${entry}\n`);
  console.log(`Added "${entry}" to ${gitignorePath}`);
}

function loadSentLog() {
  try {
    return JSON.parse(fs.readFileSync(SENT_LOG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function saveSentLog(log) {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.writeFileSync(SENT_LOG_PATH, JSON.stringify(log, null, 2));
  ensureGitignore(PROJECT_DIR, 'hara-tools-output/');
}

// ---- Listings -------------------------------------------------------------

app.get('/api/listings', (req, res) => {
  try {
    const raw = fs.readFileSync(LISTINGS_PATH, 'utf8');
    const data = JSON.parse(raw);
    const records = Array.isArray(data) ? data : (data.listings || data.facilities || []);
    res.json({ ok: true, count: records.length, records, path: LISTINGS_PATH });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: `Could not read ${LISTINGS_PATH}: ${err.message}. Set LISTINGS_PATH if your file lives elsewhere, or drop a copy of listings.json next to server.js.`,
    });
  }
});

app.get('/api/sent-log', (req, res) => {
  res.json({ ok: true, log: loadSentLog() });
});

// ---- Mail helpers -----------------------------------------------------------

function buildTransport(smtp) {
  return nodemailer.createTransport({
    host: smtp.host,
    port: Number(smtp.port),
    secure: !!smtp.secure, // true for port 465, false for 587/25 (STARTTLS)
    auth: { user: smtp.user, pass: smtp.pass },
  });
}

// Replaces {{fieldName}} with the matching value from `fields`.
function merge(template, fields) {
  return String(template || '').replace(/\{\{\s*([\w.]+)\s*\}\}/g, (m, key) => {
    const v = fields ? fields[key] : undefined;
    return v === undefined || v === null ? '' : String(v);
  });
}

app.post('/api/verify-smtp', async (req, res) => {
  try {
    const transport = buildTransport(req.body.smtp);
    await transport.verify();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

app.post('/api/send-test', async (req, res) => {
  const { smtp, from, to, subject, body, fields } = req.body;
  try {
    const transport = buildTransport(smtp);
    const info = await transport.sendMail({
      from,
      to,
      subject: merge(subject, fields || {}),
      html: merge(body, fields || {}),
    });
    res.json({ ok: true, messageId: info.messageId });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// ---- Bulk campaign (background job with pollable status) ------------------

const jobs = {};

app.post('/api/campaign/start', (req, res) => {
  const { smtp, from, subject, body, recipients, delaySeconds, skipAlreadySent, emailField } = req.body;

  if (!Array.isArray(recipients) || recipients.length === 0) {
    return res.status(400).json({ ok: false, error: 'No recipients provided.' });
  }
  if (!emailField) {
    return res.status(400).json({ ok: false, error: 'No email field selected.' });
  }

  const sentLog = loadSentLog();

  const queue = recipients.filter((r) => {
    const email = (r.fields[emailField] || '').trim().toLowerCase();
    if (!email) return false;
    if (skipAlreadySent && sentLog[email]) return false;
    return true;
  });

  const jobId = crypto.randomUUID();
  const job = {
    id: jobId,
    total: queue.length,
    sent: 0,
    failed: 0,
    skipped: recipients.length - queue.length,
    done: false,
    cancelled: false,
    log: [],
  };
  jobs[jobId] = job;

  const transport = buildTransport(smtp);
  const delayMs = Math.max(1000, Number(delaySeconds || 4) * 1000);

  (async () => {
    for (const r of queue) {
      if (job.cancelled) break;
      const email = (r.fields[emailField] || '').trim();
      try {
        const info = await transport.sendMail({
          from,
          to: email,
          subject: merge(subject, r.fields),
          html: merge(body, r.fields),
        });
        job.sent += 1;
        job.log.push({ email, status: 'sent', messageId: info.messageId, timestamp: new Date().toISOString() });
        sentLog[email.toLowerCase()] = { sentAt: new Date().toISOString(), subject };
        saveSentLog(sentLog);
      } catch (err) {
        job.failed += 1;
        job.log.push({ email, status: 'failed', error: err.message, timestamp: new Date().toISOString() });
      }
      if (!job.cancelled) {
        await new Promise((r2) => setTimeout(r2, delayMs));
      }
    }
    job.done = true;
  })();

  res.json({ ok: true, jobId, total: job.total, skipped: job.skipped });
});

app.get('/api/campaign/:id/status', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ ok: false, error: 'Unknown job id (server may have restarted).' });
  res.json({ ok: true, ...job });
});

app.post('/api/campaign/:id/cancel', (req, res) => {
  const job = jobs[req.params.id];
  if (!job) return res.status(404).json({ ok: false, error: 'Unknown job id.' });
  job.cancelled = true;
  res.json({ ok: true });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\nHara Selfish Emailer running.`);
  console.log(`Open: http://localhost:${PORT}/bulk-mailer.html`);
  console.log(`Reading listings from: ${LISTINGS_PATH}\n`);
});
