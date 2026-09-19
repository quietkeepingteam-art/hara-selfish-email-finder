# Hara Selfish Email Finder

Google Places doesn't hand you contact emails, so this script gets them the
non-API way: it visits each facility's own website and looks for a contact
email in `mailto:` links and page text (homepage plus `/contact`, `/about`,
etc.), then writes the results straight into `listings.json`.

No npm install needed — it only uses Node's built-in `fetch` (Node 18+).

## Run it

```powershell
node find-emails.js
```

By default it looks for `listings.json` next to this script. To point it
elsewhere:

```powershell
$env:LISTINGS_PATH = "C:\Users\JamesAdmin\Documents\DFW\Website2\listings.json"
node find-emails.js
```

## What it does

1. Auto-detects which field in your records holds the website URL, the
   name, and the email (same detection style as the bulk mailer).
2. Skips any facility that already has an email filled in.
3. Skips any facility with no usable website URL.
4. For the rest, checks the homepage and a few common contact-page paths,
   pulls out any email addresses, and filters out junk (`noreply@`,
   `webmaster@`, image files that look like emails, placeholder domains).
5. **Backs up your current `listings.json`** (timestamped `.backup-*.json`
   next to it) before writing anything.
6. Writes the found emails directly into `listings.json`.
7. Writes a timestamped CSV log (`email-scrape-log-*.csv`) next to your
   listings file, showing exactly what it found and where, so you can
   spot-check before trusting the results.

## Options (environment variables, all optional)

| Variable       | Default | What it does |
|----------------|---------|---------------|
| `LISTINGS_PATH`| `./listings.json` | Where your listings file lives |
| `DRY_RUN`      | unset   | Set to `1` to scrape and log without writing `listings.json` |
| `CONCURRENCY`  | `5`     | How many sites to check at once |
| `DELAY_MS`     | `400`   | Pause between page fetches, per worker |
| `TIMEOUT_MS`   | `8000`  | Give up on a slow site after this many ms |

Example — do a dry run first to see what it would find, without touching
your data:

```powershell
$env:DRY_RUN = "1"
node find-emails.js
```

## Realistic expectations

This typically finds a usable email for something like 40–70% of
facilities — some sites only offer a contact *form* with no visible
address, some don't have a real contact page, some block automated
requests outright. It's not complete, but it beats manually opening 600+
websites by hand. Check the CSV log afterward; anything marked
`no-email-found` or `error` you'll want to fill in manually or skip.

## After running this

Feed the updated `listings.json` straight into the bulk mailer tool —
it'll pick up the new `email` field automatically.
