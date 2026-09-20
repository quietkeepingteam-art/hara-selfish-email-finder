// Hara Selfish Email Finder
//
// Google Places doesn't return email addresses, so this script gets them
// the non-API way: it visits each facility's own website and pulls out a
// contact email from mailto: links or plain text on the homepage and a
// handful of common contact-page paths.
//
// Uses only Node's built-in fetch — no npm install needed (Node 18+).
//
// Every file this script generates (backups + CSV logs) goes into a single
// "hara-tools-output" folder next to listings.json — never loose in your
// project root — and a .gitignore entry for that folder is created/kept
// up to date automatically, so nothing generated ever gets committed.
//
// Run:   node find-emails.js
// Options via environment variables (all optional):
//   LISTINGS_PATH   path to listings.json (default: ./listings.json)
//   DRY_RUN         "1" to scrape and log without writing listings.json
//   CONCURRENCY      how many sites to check at once (default: 5)
//   DELAY_MS         pause between requests per worker, ms (default: 400)
//   TIMEOUT_MS       per-request timeout, ms (default: 8000)

const fs = require('fs');
const path = require('path');

const LISTINGS_PATH = process.env.LISTINGS_PATH || path.join(__dirname, 'listings.json');
const DRY_RUN = process.env.DRY_RUN === '1';
const CONCURRENCY = Number(process.env.CONCURRENCY || 5);
const DELAY_MS = Number(process.env.DELAY_MS || 400);
const TIMEOUT_MS = Number(process.env.TIMEOUT_MS || 8000);

const PROJECT_DIR = path.dirname(LISTINGS_PATH);
const OUTPUT_ROOT = path.join(PROJECT_DIR, 'hara-tools-output');
const BACKUPS_DIR = path.join(OUTPUT_ROOT, 'email-finder', 'backups');
const LOGS_DIR = path.join(OUTPUT_ROOT, 'email-finder', 'logs');

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

const CONTACT_PATHS = ['', '/contact', '/contact-us', '/contact-us/', '/about', '/about-us', '/reach-us'];

// Local-part / domain fragments that mean "not a real personal/business inbox"
const JUNK_PATTERNS = [
  'noreply', 'no-reply', 'donotreply', 'webmaster', 'postmaster', 'example.com',
  'sentry.io', 'wixpress.com', 'godaddy.com', 'yourdomain', 'domain.com',
  '.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', 'wordpress.com',
];

const EMAIL_REGEX = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
const MAILTO_REGEX = /href\s*=\s*["']mailto:([^"'?]+)/gi;

function isJunk(email) {
  const lower = email.toLowerCase();
  return JUNK_PATTERNS.some((p) => lower.includes(p));
}

function extractEmails(html) {
  const found = new Set();
  let m;
  while ((m = MAILTO_REGEX.exec(html)) !== null) {
    const e = decodeURIComponent(m[1]).trim();
    if (e && !isJunk(e)) found.add(e.toLowerCase());
  }
  const plain = html.match(EMAIL_REGEX) || [];
  plain.forEach((e) => {
    if (!isJunk(e)) found.add(e.toLowerCase());
  });
  return Array.from(found);
}

function normalizeBaseUrl(raw) {
  if (!raw) return null;
  let url = raw.trim();
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return null;
  }
}

async function fetchWithTimeout(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      redirect: 'follow',
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; FrontPorchDFW-ContactFinder/1.0; +https://frontporchdfw.com)',
      },
    });
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

async function findEmailForSite(baseUrl) {
  for (const p of CONTACT_PATHS) {
    const url = baseUrl + p;
    const html = await fetchWithTimeout(url);
    if (!html) continue;
    const emails = extractEmails(html);
    if (emails.length > 0) {
      return { email: emails[0], allFound: emails, sourceUrl: url };
    }
    await new Promise((r) => setTimeout(r, DELAY_MS));
  }
  return null;
}

function fieldKeysFromRecords(records) {
  const keys = new Set();
  records.slice(0, 50).forEach((r) => Object.keys(r).forEach((k) => keys.add(k)));
  return Array.from(keys);
}

function guessField(keys, patterns) {
  const lower = keys.map((k) => k.toLowerCase());
  for (const p of patterns) {
    const idx = lower.findIndex((k) => k.includes(p));
    if (idx !== -1) return keys[idx];
  }
  return null;
}

function csvEscape(v) {
  return `"${String(v == null ? '' : v).replace(/"/g, '""')}"`;
}

async function main() {
  console.log(`Reading listings from: ${LISTINGS_PATH}`);
  const raw = fs.readFileSync(LISTINGS_PATH, 'utf8');
  const data = JSON.parse(raw);
  const records = Array.isArray(data) ? data : (data.listings || data.facilities || []);
  console.log(`Loaded ${records.length} records.`);

  const keys = fieldKeysFromRecords(records);
  const websiteKey = guessField(keys, ['website', 'url', 'site', 'homepage']);
  const nameKey = guessField(keys, ['name', 'facility', 'title']) || 'name';
  const emailKey = guessField(keys, ['email']) || 'email';

  if (!websiteKey) {
    console.error(`Could not find a website field. Fields detected: ${keys.join(', ')}`);
    console.error('Set the field name manually by editing WEBSITE_KEY at the top of this run if needed.');
    process.exit(1);
  }
  console.log(`Using website field: "${websiteKey}", name field: "${nameKey}", email field: "${emailKey}"`);

  const logRows = [['name', 'website', 'status', 'email_found', 'source_url', 'all_candidates']];
  let checked = 0;
  let found = 0;
  let skippedNoWebsite = 0;
  let skippedHasEmail = 0;

  // Simple concurrency pool
  let cursor = 0;
  async function worker() {
    while (cursor < records.length) {
      const idx = cursor++;
      const r = records[idx];
      const name = r[nameKey] || `(record ${idx})`;

      if (r[emailKey] && String(r[emailKey]).trim()) {
        skippedHasEmail++;
        continue;
      }

      const baseUrl = normalizeBaseUrl(r[websiteKey]);
      if (!baseUrl) {
        skippedNoWebsite++;
        logRows.push([name, r[websiteKey] || '', 'no-website', '', '', '']);
        continue;
      }

      checked++;
      try {
        const result = await findEmailForSite(baseUrl);
        if (result) {
          r[emailKey] = result.email;
          found++;
          logRows.push([name, baseUrl, 'found', result.email, result.sourceUrl, result.allFound.join('; ')]);
          console.log(`[${checked}] ✓ ${name} → ${result.email}`);
        } else {
          logRows.push([name, baseUrl, 'no-email-found', '', '', '']);
          console.log(`[${checked}] – ${name} → no email found`);
        }
      } catch (err) {
        logRows.push([name, baseUrl, 'error', '', '', String(err.message || err)]);
        console.log(`[${checked}] ! ${name} → error: ${err.message || err}`);
      }
    }
  }

  const workers = Array.from({ length: CONCURRENCY }, () => worker());
  await Promise.all(workers);

  fs.mkdirSync(LOGS_DIR, { recursive: true });
  const csv = logRows.map((row) => row.map(csvEscape).join(',')).join('\n');
  const logPath = path.join(LOGS_DIR, `email-scrape-log-${Date.now()}.csv`);
  fs.writeFileSync(logPath, csv);
  ensureGitignore(PROJECT_DIR, 'hara-tools-output/');

  console.log(`\nDone. Checked ${checked} sites, found ${found} emails.`);
  console.log(`Skipped: ${skippedHasEmail} already had an email, ${skippedNoWebsite} had no usable website.`);
  console.log(`Log written to: ${logPath}`);

  if (DRY_RUN) {
    console.log('DRY_RUN=1 set — listings.json was NOT modified.');
    return;
  }

  fs.mkdirSync(BACKUPS_DIR, { recursive: true });
  const backupPath = path.join(BACKUPS_DIR, `listings.backup-${Date.now()}.json`);
  fs.copyFileSync(LISTINGS_PATH, backupPath);
  console.log(`Backed up original to: ${backupPath}`);

  const output = Array.isArray(data) ? records : { ...data, [Array.isArray(data.listings) ? 'listings' : 'facilities']: records };
  fs.writeFileSync(LISTINGS_PATH, JSON.stringify(output, null, 2));
  console.log(`Updated ${LISTINGS_PATH} with ${found} new email addresses.`);
}

main().catch((err) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
