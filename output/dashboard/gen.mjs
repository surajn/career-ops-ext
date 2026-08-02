#!/usr/bin/env node
/**
 * output/dashboard/gen.mjs — career-ops scan dashboard generator (USER-LAYER).
 *
 * Renders data/scan-history.tsv into a single self-contained, offline HTML page
 * with TWO tabbed views:
 *   • "By scan date"  — the original: dates in a rail (latest first), two tiers
 *     per date (Director & above / Senior Manager & below).
 *   • "By company"    — search/select a company, see all its postings across
 *     scan dates with BOTH dates (Found = first_seen, Listed = postedAt) and a
 *     sort control (date found / date listed / role). Includes expired postings
 *     (skipped_expired), rendered dimmed.
 * Both views share live job links, Bay-Area/Remote/US tags, and a MANUAL per-role
 * Status you set yourself (Interested / Applied / Interviewing / Offer / Role Not
 * Found / Not a fit / Not interested / Rejected). Status is keyed by NORMALIZED
 * posting URL (tracking params stripped, identifying ones like gh_jid kept), so
 * the same posting shows ONE status across both tabs and across re-scans.
 *
 * "Role Not Found" = you clicked the link and the posting is gone ("job not
 * found"). It persists to data/role-status.json on export, so a later liveness
 * pass (check-liveness.mjs) can re-check exactly those URLs and either confirm
 * them dead or resurface any that came back. See retry-notfound.mjs.
 *
 * STATUS PERSISTENCE (no server, no tokens):
 *   - Saved in your browser (localStorage, keyed by job URL) → survives page
 *     reloads AND scan regenerations automatically.
 *   - "Export statuses" downloads role-status.json; drop it at data/role-status.json
 *     and this generator re-seeds from it on every rebuild — a durable, file-level
 *     record that survives even a browser reset. localStorage overrides the seed.
 *
 * DURABILITY: this file + its output live under output/ (gitignored, in the
 * updater's USER_PATHS never-touch list); data/role-status.json is gitignored too.
 * Zero imports from career-ops system code, so updates can't break it.
 *
 * Run:  node output/dashboard/gen.mjs
 */
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));      // output/dashboard/
const ROOT = resolve(HERE, '../../');                       // repo root
const JDS_DIR = join(ROOT, 'jds');                          // archived JD bodies (snapshot-jd.mjs)
const HISTORY = join(ROOT, 'data', 'scan-history.tsv');
const SCANC_HISTORY = join(ROOT, 'data', 'scanc-history.tsv');   // scanc's OWN store (independent)
const SCANC_RUNS = join(ROOT, 'data', 'scanc-runs.tsv');         // scanc run ledger (when each co was scanned)
const STATUS_FILE = join(ROOT, 'data', 'role-status.json');
const OUT = join(HERE, 'index.html');

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;')
  .replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Normalize a posting URL for cross-store dedup + status identity. MUST match
// scanc.mjs and the browser normUrl: lowercase host, drop hash + trailing slash,
// strip tracking params, KEEP identifying ones (e.g. gh_jid).
const DROP_PARAMS = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gh_src', 'source', 'src', 'ref', 'lever-origin', 'lever-source', 'lever-via'];
function normUrl(u) {
  try {
    const x = new URL(u); x.hash = '';
    for (const p of DROP_PARAMS) x.searchParams.delete(p);
    const base = `${x.protocol}//${x.host.toLowerCase()}${x.pathname.replace(/\/+$/, '')}`;
    const qs = x.searchParams.toString();
    return qs ? `${base}?${qs}` : base;
  } catch { return String(u || ''); }
}

// ── Seniority split: Director & above vs Senior Manager & below ──
const isDirectorPlus = (title) =>
  /\bdirector\b|\bvp\b|\bvice president\b|\bhead of\b|\bhead,|\bchief\b/i.test(title || '');

// ── Location tag. Bay-Area cities only get "bay"; \bca\b avoids matching "Canada". ──
const BAY_CITIES = ['bay area', 'san francisco', 'san jose', 'menlo park', 'palo alto',
  'santa clara', 'sunnyvale', 'mountain view', 'san mateo', 'redwood city', 'oakland',
  'fremont', 'foster city', 'milpitas', 'los gatos', 'cupertino', 'pleasanton',
  'emeryville', 'burlingame', 'san ramon', 'south san francisco'];
// Known-foreign hubs — checked BEFORE the US-state heuristic so a 2-letter code
// can't false-positive (e.g. "Bengaluru, IN" must NOT read as US). Kept in sync in
// spirit with portals.yml's block list, but this is a view-only heuristic.
const FOREIGN_HINTS = ['india', 'bengaluru', 'bangalore', 'hyderabad', 'noida', 'pune', 'gurgaon',
  'united kingdom', 'london', 'england', ' uk', ',uk', '(uk', 'ireland', 'dublin',
  'germany', 'berlin', 'munich', 'france', 'paris', 'spain', 'madrid', 'barcelona',
  'netherlands', 'amsterdam', 'poland', 'romania', 'bucharest', 'switzerland', 'zurich',
  'canada', 'toronto', 'vancouver', 'montreal', 'ontario', 'mexico', 'brazil',
  'australia', 'sydney', 'melbourne', 'singapore', 'japan', 'tokyo', 'china', 'shanghai',
  'beijing', 'shenzhen', 'korea', 'seoul', 'taiwan', 'israel', 'tel aviv'];
// US state 2-letter codes (word-boundary matched) + a few full names, so bare
// "City, ST" strings (McLean, VA · Plano, TX · New York, NY) read as US.
const US_STATES = ['al','ak','az','ar','ca','co','ct','de','fl','ga','hi','id','il','in','ia',
  'ks','ky','la','me','md','ma','mi','mn','ms','mo','mt','ne','nv','nh','nj','nm','ny','nc','nd',
  'oh','ok','or','pa','ri','sc','sd','tn','tx','ut','vt','va','wa','wv','wi','wy','dc'];
const US_STATE_RE = new RegExp('(?:,|\\bus[- ]|\\bunited states[, -])\\s*(' + US_STATES.join('|') + ')\\b|\\b(' + US_STATES.join('|') + ')\\b\\s*$', 'i');
function geo(loc) {
  const l = (loc || '').toLowerCase();
  if (BAY_CITIES.some((c) => l.includes(c))) return 'bay';                 // Bay Area cities win
  if (l.includes('remote')) return 'remote';                              // any remote
  if (FOREIGN_HINTS.some((c) => l.includes(c))) return 'elsewhere';       // guard before US heuristics
  if (l.includes('california') || l.includes('united states') || l.includes('usa')
      || /\bus\b/.test(l) || /\bu\.s\.?\b/.test(l) || US_STATE_RE.test(loc || '')) return 'us';
  return 'elsewhere';
}
const GEO_LABEL = { bay: 'Bay Area', remote: 'Remote', us: 'US', elsewhere: 'Other' };
// Which geo tiers each dashboard "Location" selection shows (narrow → wide).
const LOC_TIERS = { bayremote: ['bay', 'remote'], us: ['bay', 'remote', 'us'], all: ['bay', 'remote', 'us', 'elsewhere'] };

// ── Manual status options (value → label). Extend this list any time. ──
const STATUSES = [
  ['', '— set status —'],
  ['interested', 'Interested'],
  ['applied', 'Applied'],
  ['interviewing', 'Interviewing'],
  ['offer', 'Offer'],
  ['notfound', 'Role Not Found'],
  ['notfit', 'Not a fit'],
  ['notinterested', 'Not interested'],
  ['rejected', 'Rejected'],
];
const STATUS_OPTIONS = STATUSES.map(([v, l]) => `<option value="${v}">${esc(l)}</option>`).join('');

// Durable seed from data/role-status.json (localStorage overrides it in-browser).
function loadStatusSeed() {
  try { return JSON.parse(readFileSync(STATUS_FILE, 'utf8')).statuses || {}; }
  catch { return {}; }
}
const STATUS_SEED = loadStatusSeed();

// ── Parse scan-history.tsv ONCE → two indices ──
// byDate  : the existing "by scan date" view — only status=='added' rows,
//           grouped by first_seen (date FOUND).
// byCompany: the new "by company" view — 'added' + 'skipped_expired' rows,
//           grouped by company, each carrying BOTH dates: firstSeen (date found)
//           and postedAt (date LISTED, col 9 — previously dropped entirely).
//           Expired rows are kept (rendered dimmed) so a company's real history
//           is visible; skipped_dup / skipped_title are noise and excluded.
function loadHistory() {
  const byDate = new Map();
  const byScancDate = new Map();   // scanc "by scan date" view — scanc-history 'added' rows, grouped by first_seen
  // During build, company → Map(normKey → row) so the same posting collapses to
  // one row even across the two stores. Converted to arrays before returning.
  const coMap = new Map();
  let total = 0;

  // Upsert one posting into a company's deduped set. If the same normalized URL
  // is already present (e.g. scan AND scanc both have it), merge: source→'both',
  // keep the earliest firstSeen, fill a missing postedAt, and un-expire if either
  // store still lists it live.
  function coUpsert(company, row) {
    const key = company || '—';
    if (!coMap.has(key)) coMap.set(key, new Map());
    const inner = coMap.get(key);
    const nk = normUrl(row.url);
    const prev = inner.get(nk);
    if (!prev) { inner.set(nk, row); return; }
    if (prev.source !== row.source) prev.source = 'both';
    if (row.firstSeen && (!prev.firstSeen || row.firstSeen < prev.firstSeen)) prev.firstSeen = row.firstSeen;
    if (!prev.postedAt && row.postedAt) prev.postedAt = row.postedAt;
    if (prev.expired && !row.expired) prev.expired = false;
  }

  // ── scan-history.tsv (scan's store) → feeds BOTH byDate and byCompany ──
  let raw = '';
  try { raw = readFileSync(HISTORY, 'utf8'); } catch { /* no scans yet */ }
  for (const line of raw.split('\n').filter(Boolean)) {
    const c = line.split('\t');   // url, first_seen, portal, title, company, status, location, fingerprint, postedAt
    if (c[0] === 'url' && c[1] === 'first_seen') continue;
    const url = c[0], firstSeen = c[1] || '', title = c[3] || '', company = c[4] || '',
      status = c[5] || '', location = c[6] || '', postedAt = c[8] || '';
    if (!url || !title) continue;
    if (status === 'added' && firstSeen) {   // by-date view — unchanged (scan only)
      if (!byDate.has(firstSeen)) byDate.set(firstSeen, []);
      byDate.get(firstSeen).push({ url, title, company, location, postedAt });
      total++;
    }
    if (status === 'added' || status === 'skipped_expired') {
      coUpsert(company, { url, title, company, location, firstSeen, postedAt, expired: status === 'skipped_expired', source: 'scan' });
    }
  }

  // ── scanc-history.tsv (scanc's OWN store) → company view ONLY, never byDate ──
  // (byDate means "scan runs"; scanc rows would misrepresent that.) Missing file
  // is silently skipped. scanc only ever writes status 'added'.
  let sraw = '';
  try { sraw = readFileSync(SCANC_HISTORY, 'utf8'); } catch { /* scanc never run */ }
  for (const line of sraw.split('\n').filter(Boolean)) {
    const c = line.split('\t');
    if (c[0] === 'url' && c[1] === 'first_seen') continue;
    const url = c[0], firstSeen = c[1] || '', title = c[3] || '', company = c[4] || '',
      status = c[5] || '', location = c[6] || '', postedAt = c[8] || '';
    if (!url || !title || status !== 'added') continue;
    coUpsert(company, { url, title, company, location, firstSeen, postedAt, expired: false, source: 'scanc' });
    // "Recent scanc" (by scanc date): mirror byDate but from scanc-history, keyed on first_seen.
    if (firstSeen) {
      if (!byScancDate.has(firstSeen)) byScancDate.set(firstSeen, []);
      byScancDate.get(firstSeen).push({ url, title, company, location, postedAt });
    }
  }

  const byCompany = new Map();
  for (const [co, inner] of coMap) byCompany.set(co, [...inner.values()]);
  return { byDate, byScancDate, byCompany, total };
}

function fmtDate(iso) {
  const d = new Date(iso + 'T00:00:00');
  return isNaN(d) ? iso : d.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function rowHtml(r, i) {
  const g = geo(r.location);
  const search = (r.company + ' ' + r.title + ' ' + r.location).toLowerCase();
  return `<tr data-s="${esc(search)}" data-status="" data-i="${i}" data-geo="${g}" data-listed="${esc(r.postedAt || '')}"><td class="c-co">${esc(r.company)}</td>`
    + `<td class="c-role"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}`
    + `<span class="ext" aria-hidden="true">↗</span></a></td>`
    + `<td class="c-loc"><span class="geo geo-${g}">${GEO_LABEL[g]}</span>`
    + `<span class="loc-txt">${esc(r.location) || '—'}</span></td>`
    + `<td class="c-date">${r.postedAt ? esc(fmtDate(r.postedAt)) : '—'}</td>`
    + `<td class="c-st"><select class="stsel" data-url="${esc(r.url)}" aria-label="Set status for ${esc(r.title)}">${STATUS_OPTIONS}</select></td></tr>`;
}

function tierTable(title, rows) {
  if (!rows.length) return '';
  const body = rows
    .sort((a, b) => a.company.localeCompare(b.company) || a.title.localeCompare(b.title))
    .map((r, i) => rowHtml(r, i)).join('');
  const cls = title.startsWith('Director') ? 'tier-dir' : 'tier-mgr';
  return `<div class="tier ${cls}"><div class="tier-head"><h3>${title}</h3>`
    + `<span class="tier-count">${rows.length}</span></div>`
    + `<div class="tw"><table><thead><tr><th class="c-co">Company</th>`
    + `<th class="c-role">Role</th><th class="c-loc">Location</th><th class="c-date">Listed</th><th class="c-st">Status</th></tr></thead>`
    + `<tbody>${body}</tbody></table></div></div>`;
}

const { byDate, byScancDate, byCompany, total } = loadHistory();

// Build the "by date" rail + mobile select + tiered day sections for a given
// date→rows map. Used for BOTH the scan view (byDate) and the Recent scanc view
// (byScancDate) so the two tabs are structurally identical.
function buildDateSections(byMap) {
  const dts = [...byMap.keys()].sort().reverse();
  const railHtml = dts.map((d, i) => {
    const rows = byMap.get(d);
    const dir = rows.filter((r) => isDirectorPlus(r.title)).length;
    const bay = rows.filter((r) => geo(r.location) === 'bay').length;
    return `<button class="rail-item${i === 0 ? ' active' : ''}" data-date="${esc(d)}">`
      + `<span class="rail-date">${esc(fmtDate(d))}</span>`
      + `<span class="rail-meta"><span class="rail-n">${rows.length}</span> roles`
      + `${dir ? ` · ${dir} dir` : ''}${bay ? ` · ${bay} bay` : ''}</span></button>`;
  }).join('');
  const selectHtml = dts.map((d, i) =>
    `<option value="${esc(d)}"${i === 0 ? ' selected' : ''}>${esc(fmtDate(d))} — ${byMap.get(d).length} roles</option>`
  ).join('');
  const daysHtml = dts.map((d, i) => {
    const rows = byMap.get(d);
    const dir = rows.filter((r) => isDirectorPlus(r.title));
    const mgr = rows.filter((r) => !isDirectorPlus(r.title));
    const bay = rows.filter((r) => geo(r.location) === 'bay').length;
    return `<section class="day${i === 0 ? '' : ' hidden'}" data-date="${esc(d)}">
    <div class="day-head"><h2>${esc(fmtDate(d))}</h2>
      <div class="chips"><span class="chip">${rows.length} roles</span>
      <span class="chip chip-dir">${dir.length} Director+</span>
      <span class="chip chip-bay">${bay} Bay Area</span>
      <span class="chip chip-st" hidden></span></div></div>
    ${tierTable('Director &amp; above', dir)}
    ${tierTable('Senior Manager &amp; below', mgr)}
    <p class="day-empty" hidden>No roles match on this date.</p>
  </section>`;
  }).join('\n');
  return { dates: dts, railHtml, selectHtml, daysHtml };
}

const scanView = buildDateSections(byDate);
const recentView = buildDateSections(byScancDate);
const dates = scanView.dates;                 // used in the header count
const railHtml = scanView.railHtml, selectHtml = scanView.selectHtml, daysHtml = scanView.daysHtml;

// ── "By company" view ────────────────────────────────────────────────
// One row per posting for the selected company, across ALL scan dates, showing
// BOTH dates: Found (first_seen) and Listed (postedAt, "—" when the provider
// gave none — websearch/Workday). Status <select> is identical to the date view
// and shares the same URL-keyed store, so a posting's status is one value
// everywhere. Expired rows (skipped_expired) render dimmed with a badge.
function coRowHtml(r) {
  const g = geo(r.location);
  const search = (r.company + ' ' + r.title + ' ' + r.location).toLowerCase();
  const found = r.firstSeen ? fmtDate(r.firstSeen) : '—';
  const listed = r.postedAt ? fmtDate(r.postedAt) : '—';
  return `<tr class="${r.expired ? 'row-exp' : ''}" data-s="${esc(search)}" data-status="" data-geo="${g}" `
    + `data-found="${esc(r.firstSeen || '')}" data-listed="${esc(r.postedAt || '')}" data-exp="${r.expired ? 1 : 0}">`
    + `<td class="c-role"><a href="${esc(r.url)}" target="_blank" rel="noopener">${esc(r.title)}`
    + `<span class="ext" aria-hidden="true">↗</span></a>`
    + `${r.source === 'scanc' ? '<span class="src-badge" title="found via scanc, not a scan run">scanc</span>' : ''}`
    + `${r.expired ? '<span class="exp-badge">expired</span>' : ''}</td>`
    + `<td class="c-loc"><span class="geo geo-${g}">${GEO_LABEL[g]}</span>`
    + `<span class="loc-txt">${esc(r.location) || '—'}</span></td>`
    + `<td class="c-date">${esc(found)}</td>`
    + `<td class="c-date">${esc(listed)}</td>`
    + `<td class="c-st"><select class="stsel" data-url="${esc(r.url)}" aria-label="Set status for ${esc(r.title)}">${STATUS_OPTIONS}</select></td></tr>`;
}

// Companies sorted alphabetically (case-insensitive); counts show LIVE (non-expired).
const companies = [...byCompany.keys()].sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

const coListHtml = companies.map((co, i) => {
  const rows = byCompany.get(co);
  const live = rows.filter((r) => !r.expired).length;
  // Row = a selection checkbox (independent of navigation) + the nav button.
  return `<div class="co-row">`
    + `<input type="checkbox" class="co-chk" data-co="${esc(co)}" aria-label="Select ${esc(co)} for scan">`
    + `<button class="co-item${i === 0 ? ' active' : ''}" data-co="${esc(co)}">`
    + `<span class="co-nm">${esc(co)}</span><span class="co-ct">${live}</span></button></div>`;
}).join('');

const coSectionsHtml = companies.map((co, i) => {
  // default order: date FOUND, newest first (JS sort control can re-order live).
  const rows = byCompany.get(co).slice()
    .sort((a, b) => (b.firstSeen || '').localeCompare(a.firstSeen || ''));
  const live = rows.filter((r) => !r.expired).length;
  const exp = rows.length - live;
  const body = rows.map(coRowHtml).join('');
  return `<section class="co${i === 0 ? '' : ' hidden'}" data-co="${esc(co)}">
    <div class="day-head"><h2>${esc(co)}</h2>
      <div class="chips"><span class="chip">${live} live</span>
      ${exp ? `<span class="chip chip-exp">${exp} expired</span>` : ''}</div></div>
    <div class="tw"><table><thead><tr><th class="c-role">Role</th><th class="c-loc">Location</th>
    <th class="c-date">Found</th><th class="c-date">Listed</th><th class="c-st">Status</th></tr></thead>
    <tbody>${body}</tbody></table></div>
    <p class="co-empty" hidden>No roles match.</p>
  </section>`;
}).join('\n');


// ── "Applied JDs" view ───────────────────────────────────────────────
// Read every archived JD (jds/*.md written by snapshot-jd.mjs), parse its header
// + body, and expose them for an inline, searchable read pane. Bodies are embedded
// in the page (window.__JDS) so the tab works fully offline from file:// — no server.
function loadAppliedJDs() {
  let files = [];
  try { files = readdirSync(JDS_DIR).filter((f) => f.endsWith('.md')); } catch { return []; }
  const out = [];
  for (const f of files) {
    let txt = '';
    try { txt = readFileSync(join(JDS_DIR, f), 'utf8'); } catch { continue; }
    const h1 = (txt.match(/^#\s+(.+)$/m) || [])[1] || f.replace(/\.md$/, '');
    let role = h1.trim(), company = '';
    const dash = h1.indexOf(' — ');                          // "# {Role} — {Company}"
    if (dash > -1) { role = h1.slice(0, dash).trim(); company = h1.slice(dash + 3).trim(); }
    const url = (txt.match(/^\*\*URL:\*\*\s*(\S+)/m) || [])[1] || '';
    const applied = (txt.match(/\*\*Applied:\*\*\s*([0-9-]+)/) || [])[1] || '';
    const status = ((txt.match(/\*\*Status:\*\*\s*(\w+)/) || [])[1] || 'unknown').toLowerCase();
    const source = (txt.match(/\*\*Source:\*\*\s*([\w:.-]+)/) || [])[1] || '';
    const wayback = (txt.match(/^\*\*Wayback:\*\*\s*(\S+)/m) || [])[1] || '';
    const divIdx = txt.indexOf('\n---\n');                    // body = everything past the header divider
    const body = (divIdx > -1 ? txt.slice(divIdx + 5) : txt).trim();
    out.push({ file: f, url, role, company, applied, status, source, wayback, body });
  }
  out.sort((a, b) => (a.company || '').toLowerCase().localeCompare((b.company || '').toLowerCase())
    || (a.role || '').localeCompare(b.role || ''));
  return out;
}
const appliedJDs = loadAppliedJDs();
const jdListHtml = appliedJDs.map((j, i) => {
  const live = j.status === 'live';
  return `<button class="jd-item${i === 0 ? ' active' : ''}" data-idx="${i}" `
    + `data-s="${esc(((j.company || '') + ' ' + (j.role || '')).toLowerCase())}">`
    + `<span class="jd-co">${esc(j.company || '—')}</span>`
    + `<span class="jd-role">${esc(j.role || '')}</span>`
    + `<span class="jd-meta">${esc(j.applied || '')}<span class="jd-badge ${live ? 'jd-live' : 'jd-off'}">`
    + `${live ? 'JD' : 'stub'}</span></span></button>`;
}).join('');

const statusFilterOptions = ['<option value="">All statuses</option>',
  '<option value="__set">Any status set</option>', '<option value="__none">No status</option>']
  .concat(STATUSES.filter(([v]) => v).map(([v, l]) => `<option value="${v}">${esc(l)}</option>`)).join('');

const generatedAt = new Date().toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>career-ops · scan dashboard</title>
<style>
:root{
  --ground:#f5f6f8;--surface:#fff;--surface-2:#fafbfc;--ink:#1a1e27;--muted:#5c6473;
  --faint:#8b93a2;--border:#e3e6ec;--accent:#3a49d0;--accent-weak:#edeffc;--gold:#9a6b12;
  --bay:#0f7a4f;--bay-bg:#e4f3ea;--remote:#6b5cc9;--remote-bg:#ecebfa;
  --us:#2b6aa8;--us-bg:#e6f0f9;--else:#9a6a12;--else-bg:#f6eddb;--danger:#b3261e;--danger-bg:#fbe9e7;
  --shadow:0 1px 2px rgba(20,25,40,.05),0 4px 16px rgba(20,25,40,.05);
  --sans:ui-sans-serif,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;
}
@media (prefers-color-scheme:dark){:root{
  --ground:#101217;--surface:#191c22;--surface-2:#1e222a;--ink:#e7e9ef;--muted:#9aa2b1;
  --faint:#6b7382;--border:#2a2e38;--accent:#8f9dff;--accent-weak:#20243a;--gold:#e0ad55;
  --bay:#5cd39a;--bay-bg:#123023;--remote:#a9a0ff;--remote-bg:#221f3a;
  --us:#79b2e6;--us-bg:#152838;--else:#e0ad55;--else-bg:#32270f;--danger:#f2b8b5;--danger-bg:#3a1614;
  --shadow:0 1px 2px rgba(0,0,0,.3),0 4px 18px rgba(0,0,0,.35);
}}
:root[data-theme="light"]{--ground:#f5f6f8;--surface:#fff;--surface-2:#fafbfc;--ink:#1a1e27;--muted:#5c6473;--faint:#8b93a2;--border:#e3e6ec;--accent:#3a49d0;--accent-weak:#edeffc;--gold:#9a6b12;--bay:#0f7a4f;--bay-bg:#e4f3ea;--remote:#6b5cc9;--remote-bg:#ecebfa;--us:#2b6aa8;--us-bg:#e6f0f9;--else:#9a6a12;--else-bg:#f6eddb;--danger:#b3261e;--danger-bg:#fbe9e7;}
:root[data-theme="dark"]{--ground:#101217;--surface:#191c22;--surface-2:#1e222a;--ink:#e7e9ef;--muted:#9aa2b1;--faint:#6b7382;--border:#2a2e38;--accent:#8f9dff;--accent-weak:#20243a;--gold:#e0ad55;--bay:#5cd39a;--bay-bg:#123023;--remote:#a9a0ff;--remote-bg:#221f3a;--us:#79b2e6;--us-bg:#152838;--else:#e0ad55;--else-bg:#32270f;--danger:#f2b8b5;--danger-bg:#3a1614;}
*{box-sizing:border-box}
body{margin:0;background:var(--ground);color:var(--ink);font-family:var(--sans);font-size:15px;line-height:1.5;-webkit-font-smoothing:antialiased;}
.wrap{max-width:1180px;margin:0 auto;padding:32px 22px 72px;}
header{margin-bottom:20px;}
.eyebrow{font-size:11px;letter-spacing:.14em;text-transform:uppercase;color:var(--faint);font-weight:600;margin:0 0 7px;}
h1{font-size:26px;letter-spacing:-.02em;margin:0 0 4px;font-weight:700;}
.sub{color:var(--muted);margin:0;font-size:14px;}
.layout{display:grid;grid-template-columns:236px 1fr;gap:24px;margin-top:22px;align-items:start;}
.rail{position:sticky;top:16px;display:flex;flex-direction:column;gap:6px;}
.rail-lab{font-size:11px;letter-spacing:.08em;text-transform:uppercase;color:var(--faint);font-weight:600;margin:0 0 4px 2px;}
.rail-item{text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:10px 13px;cursor:pointer;color:var(--ink);display:flex;flex-direction:column;gap:2px;font-family:inherit;transition:border-color .12s,background .12s;}
.rail-item:hover{border-color:var(--accent);}
.rail-item.active{border-color:var(--accent);background:var(--accent-weak);box-shadow:var(--shadow);}
.rail-date{font-weight:600;font-size:14px;}
.rail-meta{font-size:12px;color:var(--muted);font-variant-numeric:tabular-nums;}
.rail-n{color:var(--accent);font-weight:600;}
.mobile-nav{display:none;}
.toolbar{display:flex;gap:10px;align-items:center;margin-bottom:16px;flex-wrap:wrap;}
#q{flex:1;min-width:180px;font-family:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:9px 13px;outline:none;}
#q:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak);}
#stfilter,#sortsel{font-family:inherit;font-size:13px;color:var(--ink);background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:8px 11px;cursor:pointer;}
.chip-st{color:var(--accent);background:var(--accent-weak);border-color:transparent;}
.btn{font-family:inherit;font-size:13px;font-weight:600;color:var(--ink);background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:8px 13px;cursor:pointer;white-space:nowrap;}
.btn:hover{border-color:var(--accent);color:var(--accent);}
.savednote{font-size:12px;color:var(--faint);margin:-6px 0 16px;}
.day-head{display:flex;align-items:baseline;gap:14px;flex-wrap:wrap;margin-bottom:14px;}
.day-head h2{font-size:20px;margin:0;letter-spacing:-.01em;}
.chips{display:flex;gap:7px;flex-wrap:wrap;}
.chip{font-size:12px;font-weight:600;color:var(--muted);background:var(--surface);border:1px solid var(--border);border-radius:20px;padding:2px 11px;font-variant-numeric:tabular-nums;}
.chip-dir{color:var(--gold);}.chip-bay{color:var(--bay);}
.tier{margin-bottom:24px;}
.tier-head{display:flex;align-items:center;gap:10px;margin-bottom:9px;}
.tier-head h3{font-size:15px;margin:0;font-weight:700;letter-spacing:-.01em;}
.tier-count{font-size:12px;font-weight:600;color:var(--accent);background:var(--accent-weak);border-radius:20px;padding:1px 9px;}
.tier-dir .tier-head h3{color:var(--gold);} .tier-dir .tier-count{color:var(--gold);background:var(--else-bg);}
.tw{overflow-x:auto;border:1px solid var(--border);border-radius:12px;background:var(--surface);box-shadow:var(--shadow);}
table{width:100%;border-collapse:collapse;font-size:14px;min-width:640px;}
thead th{text-align:left;font-size:11px;letter-spacing:.06em;text-transform:uppercase;color:var(--faint);font-weight:600;padding:10px 15px;border-bottom:1px solid var(--border);background:var(--surface-2);}
tbody tr{border-bottom:1px solid var(--border);}
tbody tr:last-child{border-bottom:none;}
tbody tr:hover{background:var(--surface-2);}
td{padding:10px 15px;vertical-align:top;}
.c-co{font-weight:600;white-space:nowrap;width:1%;}
.c-role a{color:var(--ink);text-decoration:none;font-weight:500;}
.c-role a:hover{color:var(--accent);text-decoration:underline;text-underline-offset:2px;}
.c-role a:focus-visible{outline:2px solid var(--accent);outline-offset:2px;border-radius:3px;}
.ext{color:var(--faint);font-size:12px;margin-left:5px;}
.c-role a:hover .ext{color:var(--accent);}
.c-loc{white-space:nowrap;}
.geo{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;padding:2px 7px;border-radius:5px;margin-right:9px;vertical-align:1px;}
.geo-bay{color:var(--bay);background:var(--bay-bg);}.geo-remote{color:var(--remote);background:var(--remote-bg);}
.geo-us{color:var(--us);background:var(--us-bg);}.geo-elsewhere{color:var(--else);background:var(--else-bg);}
.loc-txt{color:var(--muted);font-size:13px;}
.c-st{white-space:nowrap;width:1%;}
.stsel{font-family:inherit;font-size:12px;font-weight:600;border:1px solid var(--border);border-radius:7px;padding:4px 8px;background:var(--surface);color:var(--faint);cursor:pointer;max-width:160px;}
.stsel:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak);}
.st-interested{color:var(--bay);border-color:var(--bay);background:var(--bay-bg);}
.st-applied{color:var(--accent);border-color:var(--accent);background:var(--accent-weak);}
.st-interviewing{color:var(--remote);border-color:var(--remote);background:var(--remote-bg);}
.st-offer{color:var(--gold);border-color:var(--gold);background:var(--else-bg);}
.st-notfit,.st-notinterested{color:var(--faint);background:var(--surface-2);}
.st-notfound{color:var(--else);border-color:var(--else);background:var(--else-bg);border-style:dashed;}
.st-rejected{color:var(--danger);border-color:var(--danger);background:var(--danger-bg);}
.hidden{display:none;}
.day-empty{color:var(--muted);padding:18px 2px;}
footer{margin-top:38px;color:var(--faint);font-size:12px;border-top:1px solid var(--border);padding-top:14px;}
tr[hidden]{display:none;}
@media (max-width:760px){
  .layout{grid-template-columns:1fr;}
  .rail{display:none;}
  .mobile-nav{display:block;}
  #dsel,#rdsel{width:100%;font-family:inherit;font-size:14px;padding:9px 12px;border-radius:9px;border:1px solid var(--border);background:var(--surface);color:var(--ink);}
  .co-layout{grid-template-columns:1fr;}
  .co-rail{position:static;max-height:none;}
}
/* ── View tabs (By scan date | By company) ── */
.viewtabs{display:flex;gap:4px;margin:18px 0 4px;border-bottom:1px solid var(--border);}
.vtab{font-family:inherit;font-size:14px;font-weight:600;color:var(--muted);background:none;border:none;border-bottom:2px solid transparent;padding:9px 14px;cursor:pointer;margin-bottom:-1px;}
.vtab:hover{color:var(--ink);}
.vtab.active{color:var(--accent);border-bottom-color:var(--accent);}
/* Global Location view control */
.locbar{display:flex;align-items:center;gap:8px;margin:12px 0 2px;font-size:13px;}
.locbar label{font-weight:600;color:var(--muted);}
#locSel{font-family:inherit;font-size:13px;color:var(--ink);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:5px 9px;cursor:pointer;}
#locSel:focus{outline:none;border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak);}
.loc-hint{font-size:12px;color:var(--faint);}
/* Location tiers: hide wider-geo rows when a narrower tier is selected (view-only). */
body[data-loc="bayremote"] tr[data-geo="us"],
body[data-loc="bayremote"] tr[data-geo="elsewhere"]{display:none;}
body[data-loc="us"] tr[data-geo="elsewhere"]{display:none;}
/* ── By-company view ── */
.co-layout{display:grid;grid-template-columns:236px 1fr;gap:24px;margin-top:22px;align-items:start;}
.co-rail{position:sticky;top:16px;display:flex;flex-direction:column;gap:8px;max-height:calc(100vh - 40px);}
#coq{font-family:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:9px 13px;outline:none;}
#coq:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak);}
.co-list{display:flex;flex-direction:column;gap:5px;overflow-y:auto;padding-right:2px;}
/* scan bar (multi-select → copy /scanc command) */
.scanbar{display:flex;flex-direction:column;gap:7px;background:var(--surface);border:1px solid var(--border);border-radius:11px;padding:11px 12px;box-shadow:var(--shadow);}
.scanbar-top{display:flex;justify-content:space-between;align-items:baseline;font-size:13px;}
.scanbar-top strong{font-size:13px;}
#selCount{font-size:12px;font-weight:600;color:var(--accent);font-variant-numeric:tabular-nums;}
.scanbar-row{display:flex;gap:6px;}
.btn-sm{font-family:inherit;font-size:12px;font-weight:600;color:var(--ink);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:5px 9px;cursor:pointer;}
.btn-sm:hover{border-color:var(--accent);color:var(--accent);}
#scanDays{margin-left:auto;}
#scanAdd{font-family:inherit;font-size:13px;color:var(--ink);background:var(--surface);border:1px solid var(--border);border-radius:8px;padding:7px 10px;outline:none;}
#scanAdd:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak);}
#copyScan{width:100%;justify-content:center;}
.scan-cmd{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;color:var(--ink);background:var(--surface-2);border:1px solid var(--accent);border-radius:8px;padding:7px 9px;width:100%;}
.scan-note{font-size:11.5px;color:var(--faint);margin:0;line-height:1.45;}
.linklike{background:none;border:none;color:var(--accent);font:inherit;font-size:11.5px;font-weight:600;padding:0;cursor:pointer;text-decoration:underline;}
.co-row{display:flex;align-items:center;gap:8px;}
.co-chk{flex:none;width:15px;height:15px;cursor:pointer;accent-color:var(--accent);}
.co-row .co-item{flex:1;min-width:0;}
.co-row.chk .co-item{border-color:var(--accent);background:var(--accent-weak);}
.co-item{text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:9px 13px;cursor:pointer;color:var(--ink);display:flex;justify-content:space-between;align-items:center;gap:8px;font-family:inherit;transition:border-color .12s,background .12s;}
.co-item:hover{border-color:var(--accent);}
.co-item.active{border-color:var(--accent);background:var(--accent-weak);box-shadow:var(--shadow);}
.co-nm{font-weight:600;font-size:14px;}
.co-ct{font-size:12px;font-weight:600;color:var(--accent);background:var(--accent-weak);border-radius:20px;padding:1px 9px;font-variant-numeric:tabular-nums;}
.c-date{white-space:nowrap;color:var(--muted);font-size:13px;font-variant-numeric:tabular-nums;}
.chip-exp{color:var(--danger);}
.row-exp{opacity:.55;}
.exp-badge{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:var(--danger);background:var(--danger-bg);padding:1px 6px;border-radius:5px;margin-left:8px;vertical-align:1px;}
.src-badge{display:inline-block;font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:lowercase;color:var(--remote);background:var(--remote-bg);padding:1px 6px;border-radius:5px;margin-left:8px;vertical-align:1px;}
.co-empty{color:var(--muted);padding:18px 2px;}
/* Recent scanc tab */
.chip-scand{color:var(--accent);background:var(--accent-weak);border-color:transparent;}
.rc{margin-bottom:26px;}
.rc-toolbar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:14px;}
#rcCmd{max-width:100%;}
/* ── Global pending-JDs banner (shows on EVERY tab; auto-hides at 0) ── */
.jdbanner{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin:14px 0 2px;padding:10px 14px;
  background:var(--else-bg);border:1px solid var(--gold);border-radius:11px;font-size:13.5px;color:var(--ink);}
.jdb-msg{font-weight:600;flex:1;min-width:200px;}
.jdbanner code{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;background:var(--surface);border:1px solid var(--border);border-radius:6px;padding:1px 6px;}
#jdBannerCmd{max-width:220px;}
/* ── Applied JDs tab ── */
.jd-layout{display:grid;grid-template-columns:290px 1fr;gap:24px;margin-top:22px;align-items:start;}
.jd-rail{position:sticky;top:16px;display:flex;flex-direction:column;gap:9px;max-height:calc(100vh - 40px);}
#jdq{font-family:inherit;font-size:14px;color:var(--ink);background:var(--surface);border:1px solid var(--border);border-radius:9px;padding:9px 13px;outline:none;}
#jdq:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-weak);}
.jd-list{display:flex;flex-direction:column;gap:6px;overflow-y:auto;padding-right:2px;}
.jd-item{text-align:left;background:var(--surface);border:1px solid var(--border);border-radius:10px;padding:9px 12px;cursor:pointer;color:var(--ink);display:flex;flex-direction:column;gap:2px;font-family:inherit;transition:border-color .12s,background .12s;}
.jd-item:hover{border-color:var(--accent);}
.jd-item.active{border-color:var(--accent);background:var(--accent-weak);box-shadow:var(--shadow);}
.jd-co{font-weight:700;font-size:13px;}
.jd-role{font-size:13px;color:var(--muted);line-height:1.35;}
.jd-meta{display:flex;align-items:center;gap:7px;font-size:11.5px;color:var(--faint);font-variant-numeric:tabular-nums;margin-top:1px;}
.jd-badge{font-size:10px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;border-radius:5px;padding:1px 6px;}
.jd-live{color:var(--bay);background:var(--bay-bg);}
.jd-off{color:var(--danger);background:var(--danger-bg);}
.jd-reader{min-width:0;}
.jd-doc{background:var(--surface);border:1px solid var(--border);border-radius:12px;box-shadow:var(--shadow);padding:22px 24px;}
.jd-head{border-bottom:1px solid var(--border);padding-bottom:14px;margin-bottom:16px;}
.jd-head h2{font-size:20px;margin:0 0 4px;letter-spacing:-.01em;}
.jd-sub{color:var(--muted);margin:0 0 6px;font-size:13px;}
.jd-link{display:inline-block;margin-right:14px;font-size:12.5px;color:var(--accent);text-decoration:none;word-break:break-all;}
.jd-link:hover{text-decoration:underline;}
.jd-body{white-space:pre-wrap;word-wrap:break-word;font-size:14px;line-height:1.62;color:var(--ink);}
@media(max-width:760px){.jd-layout{grid-template-columns:1fr;}.jd-rail{position:static;max-height:none;}}
</style>
</head>
<body>
<div class="wrap">
  <header>
    <p class="eyebrow">career-ops · scan dashboard</p>
    <h1>Engineering leadership roles by scan date</h1>
    <p class="sub">${total} roles across ${dates.length} scan date${dates.length === 1 ? '' : 's'} · rebuilt from data/scan-history.tsv · generated ${esc(generatedAt)}</p>
  </header>
  <div id="jdBanner" class="jdbanner" hidden>
    <span id="jdBannerMsg" class="jdb-msg"></span>
    <button id="jdBannerCopy" class="btn-sm" type="button">Copy command</button>
    <input id="jdBannerCmd" class="scan-cmd" readonly hidden aria-label="snapshot-jd command (copy this)">
  </div>
  <div class="viewtabs" role="tablist">
    <button class="vtab active" data-view="date" role="tab">By scan date</button>
    <button class="vtab" data-view="company" role="tab">By company</button>
    <button class="vtab" data-view="recent" role="tab">Recent scanc</button>
    <button class="vtab" data-view="jds" role="tab">Applied JDs</button>
  </div>
  <div class="locbar">
    <label for="locSel">Location:</label>
    <select id="locSel" aria-label="Location filter">
      <option value="bayremote">Bay Area + Remote</option>
      <option value="us">United States</option>
      <option value="all">All locations</option>
    </select>
    <span class="loc-hint">view-only — hides out-of-region rows in every tab (no data changed)</span>
  </div>
  <div id="view-date">
  <div class="mobile-nav"><select id="dsel" aria-label="Select scan date">${selectHtml}</select></div>
  <div class="layout">
    <nav class="rail" aria-label="Scan dates">
      <p class="rail-lab">Scan dates</p>
      ${railHtml || '<p class="sub">No scans recorded yet.</p>'}
    </nav>
    <main>
      <div class="toolbar">
        <input id="q" type="search" placeholder="Filter this date by company, role, or location…" autocomplete="off" aria-label="Filter roles">
        <select id="stfilter" aria-label="Filter by status">${statusFilterOptions}</select>
        <select id="sortsel" aria-label="Sort roles"><option value="status" selected>Sort: Status first</option><option value="company">Sort: Company</option></select>
        <button id="linkBtn" class="btn" type="button" hidden title="Auto-save (Chrome/Edge): bind this dashboard to data/role-status.json so every status change writes straight to disk — no manual Export. That on-disk file is what the retry-notfound / post-scan re-check reads.">Link file — auto-save</button>
        <button id="exportBtn" class="btn" type="button" title="Download role-status.json — save it as data/role-status.json for a durable, backed-up copy">Export statuses</button>
        <label class="btn" for="importFile">Import<input id="importFile" type="file" accept="application/json" hidden></label>
      </div>
      <p class="savednote">Statuses save in this browser automatically and survive scans. <strong>Export</strong> → save as <code>data/role-status.json</code> for a durable copy, or <strong>Link file</strong> (Chrome/Edge) to auto-write that file on every change. <span id="linkState"></span></p>
      ${daysHtml || '<p class="sub">Run a scan to populate this dashboard.</p>'}
    </main>
  </div>
  </div>
  <div id="view-company" class="hidden">
    <div class="co-layout">
      <nav class="co-rail" aria-label="Companies">
        <div class="scanbar">
          <div class="scanbar-top"><strong>Scan companies</strong><span id="selCount">0 selected</span></div>
          <div class="scanbar-row">
            <button id="selAll" class="btn-sm" type="button">All</button>
            <button id="selNone" class="btn-sm" type="button">None</button>
            <select id="scanDays" class="btn-sm" aria-label="Days back to scan">
              <option value="7" selected>7d</option><option value="14">14d</option>
              <option value="30">30d</option><option value="60">60d</option><option value="90">90d</option>
            </select>
          </div>
          <input id="scanAdd" type="text" placeholder="+ add other companies (comma-sep)…" autocomplete="off" aria-label="Add other companies to scan">
          <button id="copyScan" class="btn" type="button">Copy scan command</button>
          <button id="reloadDash" class="btn-sm" type="button">Reload dashboard</button>
          <input id="scanCmd" class="scan-cmd" readonly hidden aria-label="Scan command (copy this)">
          <p id="scanNote" class="scan-note">Tick companies → Copy → paste into Claude Code. Zero-token boards scan &amp; persist; no-API ones get a WebSearch pass; the dashboard rebuilds. Then Reload.</p>
        </div>
        <input id="coq" type="search" placeholder="Search company…" autocomplete="off" aria-label="Search company">
        <div class="co-list">${coListHtml || '<p class="sub">No companies yet.</p>'}</div>
      </nav>
      <main>
        <div class="toolbar">
          <input id="coRoleQ" type="search" placeholder="Filter roles by title or location…" autocomplete="off" aria-label="Filter roles">
          <select id="cosort" aria-label="Sort roles"><option value="found" selected>Sort: Date found (newest)</option><option value="listed">Sort: Date listed (newest)</option><option value="role">Sort: Role A–Z</option></select>
        </div>
        <p class="savednote">Status is shared with the “By scan date” tab — same posting, one status (matched by normalized URL). Expired postings are shown dimmed.</p>
        ${coSectionsHtml || '<p class="sub">Run a scan to populate this dashboard.</p>'}
      </main>
    </div>
  </div>
  <div id="view-recent" class="hidden">
  <div class="mobile-nav"><select id="rdsel" aria-label="Select scanc date">${recentView.selectHtml}</select></div>
  <div class="layout">
    <nav class="rail" aria-label="Scanc dates">
      <p class="rail-lab">Scanc dates</p>
      ${recentView.railHtml || '<p class="sub">No scanc runs yet.</p>'}
    </nav>
    <main>
      <div class="toolbar">
        <input id="rq" type="search" placeholder="Filter this date by company, role, or location…" autocomplete="off" aria-label="Filter roles">
        <select id="rstfilter" aria-label="Filter by status">${statusFilterOptions}</select>
        <select id="rsortsel" aria-label="Sort roles"><option value="status" selected>Sort: Status first</option><option value="company">Sort: Company</option></select>
      </div>
      <p class="savednote">Roles from companies you've scanned with <strong>scanc</strong>, grouped by scanc date (only scanc-scanned companies). Status is shared with the other tabs; use the <strong>Location</strong> control above to filter by region.</p>
      ${recentView.daysHtml || '<p class="sub">No scanc runs yet — run <code>/scanc &lt;companies&gt;</code>, or use the “By company” tab’s scan bar.</p>'}
    </main>
  </div>
  </div>
  <div id="view-jds" class="hidden">
    <div class="jd-layout">
      <nav class="jd-rail" aria-label="Applied job descriptions">
        <input id="jdq" type="search" placeholder="Search company…" autocomplete="off" aria-label="Search applied JDs by company">
        <div class="jd-list">${jdListHtml || '<p class="sub">No JDs archived yet — run <code>snapshot-jd</code> to capture the descriptions of roles you\'ve applied to.</p>'}</div>
      </nav>
      <main class="jd-reader">
        <div id="jdReader" class="jd-doc"><p class="sub">Select a role on the left to read its full job description. Archived by <code>snapshot-jd</code> from roles you marked Applied.</p></div>
      </main>
    </div>
  </div>
  <footer>Local, offline dashboard · statuses are yours (browser + data/role-status.json) · nothing here is an application.</footer>
</div>
<script>window.__SEED=${JSON.stringify({ statuses: STATUS_SEED })};</script>
<script>window.__JDS=${JSON.stringify(appliedJDs.map((j) => ({ url: j.url, role: j.role, company: j.company, applied: j.applied, status: j.status, source: j.source, wayback: j.wayback, body: j.body })))};</script>
<script>
(function(){
  var selects=[].slice.call(document.querySelectorAll('.stsel'));

  // ── Global Location view control (view-only; rows hide via body[data-loc] CSS) ──
  // A row is truly visible iff no ancestor/CSS hides it → offsetParent!==null. Use
  // that to collapse tier tables / wrappers that end up empty under the current
  // Location tier or search, so a section doesn't render an empty shell.
  function recomputeEmpties(){
    [].slice.call(document.querySelectorAll('.tier, .tw')).forEach(function(el){
      if(el.classList.contains('tw') && el.closest('.tier')) return;   // .tier owns its inner .tw
      var rows=el.querySelectorAll('tbody tr');
      if(!rows.length) return;
      // Reset display BEFORE measuring — otherwise a container hidden while its
      // tab was inactive stays hidden forever (its rows read offsetParent=null
      // through the already-collapsed container). Reset lets it recover on open.
      el.style.display='';
      var vis=[].slice.call(rows).some(function(r){ return r.offsetParent!==null; });
      el.style.display=vis?'':'none';
    });
  }
  var locSel=document.getElementById('locSel');
  function applyLoc(){
    var v=(locSel&&locSel.value)||'bayremote';
    document.body.setAttribute('data-loc', v);
    try{ localStorage.setItem('cops-loc', v); }catch(e){}
    recomputeEmpties();
  }
  (function initLoc(){
    var saved='bayremote'; try{ saved=localStorage.getItem('cops-loc')||'bayremote'; }catch(e){}
    if(locSel) locSel.value=saved;
    document.body.setAttribute('data-loc', saved);
  })();
  if(locSel) locSel.addEventListener('change', applyLoc);

  var STORE_KEY='cops-role-status';
  var RANK={offer:0,interviewing:1,applied:2,interested:3,'':4,notfound:5,notfit:6,notinterested:7,rejected:8};
  var STLABEL={interested:'Interested',applied:'Applied',interviewing:'Interviewing',offer:'Offer',notfound:'Role Not Found',notfit:'Not a fit',notinterested:'Not interested',rejected:'Rejected'};
  var STORDER=['offer','interviewing','applied','interested','notfound','notfit','notinterested','rejected'];

  // Normalize a posting URL so the SAME posting maps to ONE status key across every
  // tab and repeat scans — strips utm_*/gh_src/lever-source NOISE params but KEEPS
  // identifying ones (e.g. gh_jid), so two distinct jobs never collapse to one.
  var DROP_PARAMS=['utm_source','utm_medium','utm_campaign','utm_term','utm_content','gh_src','source','src','ref','lever-origin','lever-source','lever-via'];
  function normUrl(u){
    try{
      var x=new URL(u); x.hash='';
      DROP_PARAMS.forEach(function(p){ x.searchParams.delete(p); });
      var base=x.protocol+'//'+x.host.toLowerCase()+x.pathname.replace(/[/]+$/,'');
      var qs=x.searchParams.toString();
      return qs? base+'?'+qs : base;
    }catch(e){ return u; }
  }
  function loadStore(){
    var seed=(window.__SEED&&window.__SEED.statuses)||{}, ls={};
    try{ ls=JSON.parse(localStorage.getItem(STORE_KEY)||'{}'); }catch(e){}
    var out={};
    Object.keys(seed).forEach(function(k){ if(seed[k]) out[normUrl(k)]=seed[k]; });
    Object.keys(ls).forEach(function(k){ if(ls[k]) out[normUrl(k)]=ls[k]; });
    return out;
  }
  function saveStore(){ try{ localStorage.setItem(STORE_KEY, JSON.stringify(store)); }catch(e){} }
  var store=loadStore();

  function paint(s){
    var url=normUrl(s.getAttribute('data-url')), v=store[url]||'';
    s.value=v; s.className='stsel st-'+(v||'none');
    var tr=s.closest('tr'); if(tr) tr.setAttribute('data-status', v);
  }
  selects.forEach(function(s){
    paint(s);
    s.addEventListener('change', function(){
      var url=normUrl(s.getAttribute('data-url'));
      if(s.value) store[url]=s.value; else delete store[url];
      saveStore();
      // Repaint EVERY select for this posting — the same job can appear in multiple
      // tabs / dates; keep them in sync. Use a SOFT refresh (update summary + filter,
      // but do NOT re-sort) so setting a status never reorders rows out from under you.
      selects.forEach(function(x){ if(normUrl(x.getAttribute('data-url'))===url) paint(x); });
      refreshActive(true);
      if(window.__updateBanner) window.__updateBanner();   // Applied→missing-JD count may have changed
      if(window.__autoSave) window.__autoSave();   // mirror to data/role-status.json if "Link file" is on
    });
  });

  // ── Date-view engine: mounted for BOTH "By scan date" and "Recent scanc" ──
  // Identical behavior (rail nav + mobile select + search + status filter + sort +
  // summary), scoped to its container so the two tabs never cross-wire.
  function mountDateView(root, ids){
    if(!root) return { refresh:function(){} };
    var rail=[].slice.call(root.querySelectorAll('.rail-item'));
    var days=[].slice.call(root.querySelectorAll('.day'));
    var sel=document.getElementById(ids.sel), q=document.getElementById(ids.q);
    var stfilter=document.getElementById(ids.stfilter), sortsel=document.getElementById(ids.sortsel);
    function visibleDay(){ return days.filter(function(d){return !d.classList.contains('hidden');})[0]; }
    function sortRows(day){
      if(!day) return;
      var mode=sortsel?sortsel.value:'status';
      [].slice.call(day.querySelectorAll('tbody')).forEach(function(tb){
        var rows=[].slice.call(tb.querySelectorAll('tr'));
        rows.sort(function(a,b){
          var ai=+a.getAttribute('data-i'), bi=+b.getAttribute('data-i');
          if(mode==='status'){
            var ra=RANK[a.getAttribute('data-status')||'']; if(ra==null)ra=4;
            var rb=RANK[b.getAttribute('data-status')||'']; if(rb==null)rb=4;
            if(ra!==rb) return ra-rb;
          }
          return ai-bi;
        });
        rows.forEach(function(r){ tb.appendChild(r); });
      });
    }
    function updateSummary(day){
      if(!day) return;
      var counts={};
      [].slice.call(day.querySelectorAll('tbody tr')).forEach(function(r){
        var st=r.getAttribute('data-status')||''; if(st) counts[st]=(counts[st]||0)+1;
      });
      var parts=STORDER.filter(function(k){return counts[k];}).map(function(k){return counts[k]+' '+STLABEL[k];});
      var chip=day.querySelector('.chip-st');
      if(chip){ if(parts.length){ chip.textContent=parts.join(' · '); chip.hidden=false; } else { chip.hidden=true; } }
    }
    function filter(){
      var t=((q&&q.value)||'').trim().toLowerCase(), sf=stfilter?stfilter.value:'';
      var day=visibleDay(); if(!day) return;
      var shown=0;
      [].slice.call(day.querySelectorAll('tbody tr')).forEach(function(r){
        var st=r.getAttribute('data-status')||'';
        var stOk = !sf || (sf==='__set'? st!=='' : sf==='__none'? st==='' : st===sf);
        var m=(!t||r.getAttribute('data-s').indexOf(t)>-1)&&stOk;
        r.hidden=!m; if(m)shown++;
      });
      var empty=day.querySelector('.day-empty'); if(empty) empty.hidden=shown>0;
    }
    function show(date){
      days.forEach(function(d){ d.classList.toggle('hidden', d.getAttribute('data-date')!==date); });
      rail.forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-date')===date); });
      if(sel) sel.value=date;
      refresh();
    }
    function refresh(){ var d=visibleDay(); sortRows(d); updateSummary(d); filter(); recomputeEmpties(); }
    // Soft refresh: update the status summary + apply filters, but DO NOT re-sort —
    // used on status changes so the row you just edited stays put.
    function refreshSoft(){ var d=visibleDay(); updateSummary(d); filter(); recomputeEmpties(); }
    rail.forEach(function(b){ b.addEventListener('click',function(){ show(b.getAttribute('data-date')); }); });
    if(sel) sel.addEventListener('change',function(){ show(sel.value); });
    if(q) q.addEventListener('input',filter);
    if(stfilter) stfilter.addEventListener('change',filter);
    if(sortsel) sortsel.addEventListener('change',refresh);
    return { refresh: refresh, refreshSoft: refreshSoft };
  }
  var dvScan=mountDateView(document.getElementById('view-date'), {sel:'dsel',q:'q',stfilter:'stfilter',sortsel:'sortsel'});
  var dvRecent=mountDateView(document.getElementById('view-recent'), {sel:'rdsel',q:'rq',stfilter:'rstfilter',sortsel:'rsortsel'});
  var activeTab='date';
  // soft=true → don't re-sort (used on status changes so rows don't jump).
  function refreshActive(soft){
    if(activeTab==='jds') return;   // Applied JDs tab has no date rows to lay out
    if(activeTab==='recent') soft ? dvRecent.refreshSoft() : dvRecent.refresh();
    else if(activeTab==='company'){ if(typeof sortCo==='function'){ if(!soft) sortCo(); coFilter(); } }
    else soft ? dvScan.refreshSoft() : dvScan.refresh();
  }

  // Export = download role-status.json to the browser's Downloads folder. A
  // static file:// page can't pick the save location, so the file lands in
  // Downloads and YOU move it to <repo>/data/role-status.json. We now also show
  // an on-screen confirmation (and the count) because the download itself is
  // silent — the #1 "it does nothing" confusion is that there's no feedback and
  // the file quietly went to Downloads. If you set zero statuses, we say so
  // instead of exporting an empty file.
  var exportBtn=document.getElementById('exportBtn');
  if(exportBtn) exportBtn.addEventListener('click',function(){
    var n=Object.keys(store).filter(function(k){return store[k];}).length;
    if(!n){ if(linkState) linkState.textContent='Nothing to export yet — set a status on at least one role first.'; return; }
    var blob=new Blob([JSON.stringify({version:1, updated:new Date().toISOString(), statuses:store}, null, 2)],{type:'application/json'});
    var a=document.createElement('a'); a.href=URL.createObjectURL(blob); a.download='role-status.json';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(function(){ URL.revokeObjectURL(a.href); }, 2000);
    if(linkState) linkState.textContent='✓ Downloaded role-status.json ('+n+' status'+(n===1?'':'es')+') to your Downloads folder — now move it to <repo>/data/role-status.json.';
  });
  var importFile=document.getElementById('importFile');
  if(importFile) importFile.addEventListener('change',function(){
    var f=importFile.files&&importFile.files[0]; if(!f) return;
    var rd=new FileReader();
    rd.onload=function(){
      try{ var j=JSON.parse(rd.result); var st=j.statuses||j;
        Object.keys(st).forEach(function(k){ if(st[k]) store[k]=st[k]; });
        saveStore(); selects.forEach(paint); refresh();
        if(window.__updateBanner) window.__updateBanner();
        if(window.__autoSave) window.__autoSave();   // also persist an imported set to the linked file

      }catch(e){ alert('Could not read that file as a status export.'); }
      importFile.value='';
    };
    rd.readAsText(f);
  });

  // ───────────────────────────────────────────────────────────────────────────
  // AUTO-SAVE TO DISK — File System Access API  (the "Link file" button)
  //
  // WHAT THIS IS:
  //   An optional way to bind this dashboard to your on-disk
  //   data/role-status.json so that EVERY status change (including "Role Not
  //   Found") is written to that file the instant you make it — no manual
  //   "Export statuses" step.
  //
  // WHY IT EXISTS:
  //   A static file:// page cannot silently write to your disk; the browser
  //   requires a one-time user gesture (the file picker) to grant access.
  //   Without this, marks live only in the browser's localStorage, and the
  //   retry tooling (output/dashboard/retry-notfound.mjs and the post-scan
  //   re-check) reads a FILE — so it would only ever see marks you manually
  //   exported. "Link file" closes that gap: once linked, the on-disk file is
  //   always current, which is what makes "mark a dead role → it gets
  //   re-checked on the next scan" actually hands-off.
  //
  // HOW YOU USE IT (one time):
  //   1. Click "Link file — auto-save".
  //   2. In the picker, navigate to this repo's data/ folder and choose (or
  //      create) role-status.json, then confirm.
  //   3. The button flips to "Linked ✓" and every mark auto-saves from then on.
  //   The link is remembered across page reloads (handle stored in IndexedDB);
  //   Chrome re-verifies permission each session — silently if still granted,
  //   otherwise it re-prompts on your next status change (itself a gesture).
  //   Re-link if you move the repo to a new path.
  //
  // SCOPE / FALLBACK:
  //   Chromium browsers only (Chrome/Edge/Brave). In Firefox/Safari the API is
  //   absent, so the button stays hidden and you keep using Export — nothing
  //   breaks. Marks are ALWAYS still in localStorage regardless, so a failed
  //   disk write never loses data.
  // ───────────────────────────────────────────────────────────────────────────
  var linkBtn=document.getElementById('linkBtn');
  var linkState=document.getElementById('linkState');
  var fileHandle=null;                       // FileSystemFileHandle once linked (else null)
  var fsaSupported=('showSaveFilePicker' in window);
  var IDB_NAME='cops-dashboard', IDB_STORE='handles', IDB_KEY='roleStatusHandle';

  // --- Minimal IndexedDB helpers: persist the file handle across reloads so you
  //     only pick the file once. (localStorage can't hold a file handle; IDB can.)
  function idbOpen(){ return new Promise(function(res,rej){
    var r=indexedDB.open(IDB_NAME,1);
    r.onupgradeneeded=function(){ r.result.createObjectStore(IDB_STORE); };
    r.onsuccess=function(){ res(r.result); }; r.onerror=function(){ rej(r.error); };
  }); }
  function idbPut(val){ return idbOpen().then(function(db){ return new Promise(function(res,rej){
    var tx=db.transaction(IDB_STORE,'readwrite'); tx.objectStore(IDB_STORE).put(val,IDB_KEY);
    tx.oncomplete=function(){res();}; tx.onerror=function(){rej(tx.error);}; }); }); }
  function idbGet(){ return idbOpen().then(function(db){ return new Promise(function(res,rej){
    var tx=db.transaction(IDB_STORE,'readonly'); var g=tx.objectStore(IDB_STORE).get(IDB_KEY);
    g.onsuccess=function(){res(g.result||null);}; g.onerror=function(){rej(g.error);}; }); }); }

  // --- Permission gate: QUERY silently anytime, but only REQUEST (which may show
  //     a prompt) from inside a user gesture, or the browser rejects it. ---
  function hasRW(handle,doRequest){
    if(!handle||!handle.queryPermission) return Promise.resolve(false);
    var opts={mode:'readwrite'};
    return handle.queryPermission(opts).then(function(p){
      if(p==='granted') return true;
      if(doRequest&&handle.requestPermission) return handle.requestPermission(opts).then(function(q){return q==='granted';});
      return false;
    });
  }
  // --- Write the whole status store to the linked file (same shape Export uses,
  //     so the two are interchangeable and retry-notfound.mjs reads either). ---
  function writeToFile(handle){
    return handle.createWritable().then(function(w){
      return w.write(JSON.stringify({version:1,updated:new Date().toISOString(),statuses:store},null,2)+'\\n')
        .then(function(){ return w.close(); });
    });
  }
  function setLinkedUI(on){
    if(linkBtn) linkBtn.textContent=on?'Linked ✓ — auto-saving':'Link file — auto-save';
    if(linkState) linkState.textContent=on?'Auto-save ON → data/role-status.json is written on every change.':'';
  }
  // autoSave() runs after every status change; a silent no-op unless you've linked.
  // Exposed on window so the change/import handlers above can call it without
  // depending on definition order.
  function autoSave(){
    if(!fileHandle) return;
    hasRW(fileHandle,true)
      .then(function(ok){ if(ok) return writeToFile(fileHandle).then(function(){ setLinkedUI(true); }); })
      .catch(function(){ /* transient disk/permission hiccup — marks remain safe in localStorage + Export */ });
  }
  window.__autoSave=autoSave;

  if(!fsaSupported){
    if(linkState) linkState.textContent='(Auto-save needs Chrome/Edge — use Export here.)';
  } else {
    linkBtn.hidden=false;
    // On load: silently restore any previously linked file (never prompt here).
    idbGet().then(function(h){
      if(!h) return false;
      fileHandle=h;                    // keep the handle even if permission needs a re-grant
      return hasRW(h,false);           // query only; a re-grant (if needed) happens on next change
    }).then(function(granted){ setLinkedUI(!!granted); }).catch(function(){});
    // Click: pick/create the file, remember it, and write the current store now.
    linkBtn.addEventListener('click',function(){
      window.showSaveFilePicker({suggestedName:'role-status.json',
        types:[{description:'Role status JSON',accept:{'application/json':['.json']}}]})
      .then(function(h){ fileHandle=h; return idbPut(h).then(function(){ return writeToFile(h); }); })
      .then(function(){ setLinkedUI(true); })
      .catch(function(){ /* picker cancelled — nothing to do */ });
    });
  }

  // ── View tabs (By scan date | By company | Recent scanc) ──
  var vtabs=[].slice.call(document.querySelectorAll('.vtab'));
  var viewDate=document.getElementById('view-date');
  var viewCo=document.getElementById('view-company');
  var viewRecent=document.getElementById('view-recent');
  var viewJds=document.getElementById('view-jds');
  vtabs.forEach(function(t){ t.addEventListener('click',function(){
    var v=t.getAttribute('data-view');
    vtabs.forEach(function(x){ x.classList.toggle('active', x===t); });
    if(viewDate) viewDate.classList.toggle('hidden', v!=='date');
    if(viewCo) viewCo.classList.toggle('hidden', v!=='company');
    if(viewRecent) viewRecent.classList.toggle('hidden', v!=='recent');
    if(viewJds) viewJds.classList.toggle('hidden', v!=='jds');
    activeTab=v;
    if(v==='company'){ sortCo(); coFilter(); }
    else if(v==='jds'){ /* static list, already rendered */ }
    else refreshActive();   // 'date' → dvScan, 'recent' → dvRecent (re-lays out now visible)
    recomputeEmpties();     // recompute now that this tab's rows are laid out
  }); });

  // ── By-company view: picker (search + list), role filter, sort ──
  var coItems=[].slice.call(document.querySelectorAll('.co-item'));
  var coSecs=[].slice.call(document.querySelectorAll('.co'));
  var coq=document.getElementById('coq');
  var coRoleQ=document.getElementById('coRoleQ');
  var cosort=document.getElementById('cosort');
  function visibleCo(){ return coSecs.filter(function(s){return !s.classList.contains('hidden');})[0]; }
  function showCo(co){
    coSecs.forEach(function(s){ s.classList.toggle('hidden', s.getAttribute('data-co')!==co); });
    coItems.forEach(function(b){ b.classList.toggle('active', b.getAttribute('data-co')===co); });
    sortCo(); coFilter();
  }
  coItems.forEach(function(b){ b.addEventListener('click',function(){ showCo(b.getAttribute('data-co')); }); });
  if(coq) coq.addEventListener('input',function(){          // filter the COMPANY list
    var t=(coq.value||'').trim().toLowerCase();
    coItems.forEach(function(b){                            // hide the whole row (checkbox + button)
      var row=b.closest('.co-row')||b;
      row.style.display=b.getAttribute('data-co').toLowerCase().indexOf(t)>-1?'':'none';
    });
  });
  function coFilter(){                                       // filter ROLES within the shown company
    var sec=visibleCo(); if(!sec) return;
    var t=(coRoleQ&&coRoleQ.value||'').trim().toLowerCase(), shown=0;
    [].slice.call(sec.querySelectorAll('tbody tr')).forEach(function(r){
      var m=!t||r.getAttribute('data-s').indexOf(t)>-1; r.hidden=!m; if(m)shown++;
    });
    var e=sec.querySelector('.co-empty'); if(e) e.hidden=shown>0;
    recomputeEmpties();
  }
  if(coRoleQ) coRoleQ.addEventListener('input',coFilter);
  function sortCo(){
    var sec=visibleCo(); if(!sec) return;
    var mode=cosort?cosort.value:'found';
    var tb=sec.querySelector('tbody'); if(!tb) return;
    var rows=[].slice.call(tb.querySelectorAll('tr'));
    rows.sort(function(a,b){
      if(mode==='role'){
        var ta=(a.querySelector('.c-role a')||{}).textContent||'';
        var tbt=(b.querySelector('.c-role a')||{}).textContent||'';
        return ta.localeCompare(tbt);
      }
      var key=mode==='listed'?'data-listed':'data-found';
      var av=a.getAttribute(key)||'', bv=b.getAttribute(key)||'';
      if(av===bv) return 0;
      if(!av) return 1; if(!bv) return -1;     // undated sink to the bottom
      return bv.localeCompare(av);              // newest first
    });
    rows.forEach(function(r){ tb.appendChild(r); });
  }
  if(cosort) cosort.addEventListener('change',sortCo);
  sortCo();

  // ── Scan bar: multi-select companies → copy a "/scanc …" command ──
  // The static page can't run node, so we build the /scanc workflow trigger and
  // copy it; pasting it into Claude Code runs scanc (zero-token + persist),
  // WebSearch for handoff companies, and rebuilds the dashboard.
  var coChks=[].slice.call(document.querySelectorAll('.co-chk'));
  var selCount=document.getElementById('selCount');
  var scanDays=document.getElementById('scanDays');
  var scanAdd=document.getElementById('scanAdd');
  var copyScan=document.getElementById('copyScan');
  var scanCmd=document.getElementById('scanCmd');
  var scanNote=document.getElementById('scanNote');
  var reloadDash=document.getElementById('reloadDash');
  var selAll=document.getElementById('selAll');
  var selNone=document.getElementById('selNone');

  function extraCompanies(){
    return ((scanAdd&&scanAdd.value)||'').split(',').map(function(s){return s.trim();}).filter(Boolean);
  }
  function selectedCompanies(){
    var picked=coChks.filter(function(c){return c.checked;}).map(function(c){return c.getAttribute('data-co');});
    var seen={}, out=[];                                     // de-dupe case-insensitively, keep order
    picked.concat(extraCompanies()).forEach(function(n){ var k=n.toLowerCase(); if(!seen[k]){seen[k]=1;out.push(n);} });
    return out;
  }
  function buildCmd(){
    var cos=selectedCompanies(); if(!cos.length) return '';
    var days=scanDays?scanDays.value:'7';
    return '/scanc '+cos.join(', ')+(days&&days!=='7'?(' --days '+days):'');  // scanc default is 7 → omit
  }
  function updateSel(){
    var total=selectedCompanies().length;
    if(selCount) selCount.textContent=total+' selected';
    coChks.forEach(function(c){ var row=c.closest('.co-row'); if(row) row.classList.toggle('chk', c.checked); });
  }
  coChks.forEach(function(c){ c.addEventListener('change',updateSel); });
  if(scanAdd) scanAdd.addEventListener('input',updateSel);
  if(selAll) selAll.addEventListener('click',function(){
    coChks.forEach(function(c){ var row=c.closest('.co-row'); if(!row||row.style.display!=='none') c.checked=true; }); updateSel();
  });
  if(selNone) selNone.addEventListener('click',function(){ coChks.forEach(function(c){ c.checked=false; }); updateSel(); });

  // Clipboard with a file:// fallback: async API (secure contexts) → textarea+
  // execCommand (works on file://) → always reveal the pre-selected input as a
  // last-resort manual copy, so the user is never left without the command text.
  function fallbackCopy(txt){
    try{
      var ta=document.createElement('textarea'); ta.value=txt;
      ta.style.position='fixed'; ta.style.opacity='0'; document.body.appendChild(ta);
      ta.focus(); ta.select(); var ok=document.execCommand('copy'); document.body.removeChild(ta); return ok;
    }catch(e){ return false; }
  }
  function copyText(txt){
    return new Promise(function(res){
      if(navigator.clipboard&&navigator.clipboard.writeText)
        navigator.clipboard.writeText(txt).then(function(){res(true);},function(){res(fallbackCopy(txt));});
      else res(fallbackCopy(txt));
    });
  }
  if(copyScan) copyScan.addEventListener('click',function(){
    var cmd=buildCmd();
    if(!cmd){ if(scanNote) scanNote.textContent='Tick at least one company (or type one in “+ add other companies”) first.'; return; }
    if(scanCmd){ scanCmd.hidden=false; scanCmd.value=cmd; scanCmd.focus(); scanCmd.select(); }
    copyText(cmd).then(function(ok){
      if(scanNote) scanNote.textContent=(ok?'✓ Copied — ':'Copy the box above — ')+'paste into Claude Code, then Reload dashboard.';
    });
  });
  if(reloadDash) reloadDash.addEventListener('click',function(){ location.reload(); });
  updateSel();

  // ── Applied JDs tab: list → reader, plus company search ──
  // Bodies are embedded in window.__JDS (offline-safe). Rendered via textContent so
  // JD text is never interpreted as HTML — no escaping games, no injection.
  var jdData=window.__JDS||[];
  var jdItems=[].slice.call(document.querySelectorAll('.jd-item'));
  var jdReader=document.getElementById('jdReader');
  var jdq=document.getElementById('jdq');
  function renderJD(j){
    if(!jdReader) return;
    jdReader.innerHTML='';
    var head=document.createElement('div'); head.className='jd-head';
    var h=document.createElement('h2'); h.textContent=j.role||'Role'; head.appendChild(h);
    var sub=document.createElement('p'); sub.className='jd-sub';
    sub.textContent=[j.company, j.applied?('applied '+j.applied):'', j.status?('status: '+j.status):'', j.source||''].filter(Boolean).join(' · ');
    head.appendChild(sub);
    if(j.url){ var a=document.createElement('a'); a.className='jd-link'; a.href=j.url; a.target='_blank'; a.rel='noopener'; a.textContent='Open posting ↗'; head.appendChild(a); }
    if(j.wayback){ var w=document.createElement('a'); w.className='jd-link'; w.href=j.wayback; w.target='_blank'; w.rel='noopener'; w.textContent='Wayback snapshot ↗'; head.appendChild(w); }
    jdReader.appendChild(head);
    var bodyEl=document.createElement('div'); bodyEl.className='jd-body'; bodyEl.textContent=j.body||'(no body captured)'; jdReader.appendChild(bodyEl);
  }
  function showJD(idx){
    jdItems.forEach(function(b){ b.classList.toggle('active', (+b.getAttribute('data-idx'))===idx); });
    var j=jdData[idx]; if(j) renderJD(j);
  }
  jdItems.forEach(function(b){ b.addEventListener('click',function(){ showJD(+b.getAttribute('data-idx')); }); });
  if(jdq) jdq.addEventListener('input',function(){
    var t=(jdq.value||'').trim().toLowerCase();
    jdItems.forEach(function(b){ b.style.display=(!t||b.getAttribute('data-s').indexOf(t)>-1)?'':'none'; });
  });
  if(jdItems.length) showJD(0);

  // ── Global pending-JDs banner (visible on every tab) ──
  // pending = roles you marked "applied" (status store) that have NO archived JD
  // (by normalized URL). Nags until you run snapshot-jd; auto-hides at 0. Recomputes
  // on every status change so marking one Applied bumps the count immediately.
  var jdBanner=document.getElementById('jdBanner');
  var jdBannerMsg=document.getElementById('jdBannerMsg');
  var jdBannerCopy=document.getElementById('jdBannerCopy');
  var jdBannerCmd=document.getElementById('jdBannerCmd');
  var jdUrlSet={}; jdData.forEach(function(j){ if(j.url) jdUrlSet[normUrl(j.url)]=1; });
  function updateBanner(){
    if(!jdBanner) return;
    var n=0;
    Object.keys(store).forEach(function(k){ if(store[k]==='applied' && !jdUrlSet[k]) n++; });
    if(n>0){ jdBannerMsg.innerHTML='⚑ '+n+' applied role'+(n===1?'':'s')+' with no JD yet — run ';
      var code=document.createElement('code'); code.textContent='snapshot-jd'; jdBannerMsg.appendChild(code);
      jdBanner.hidden=false; } else jdBanner.hidden=true;
  }
  if(jdBannerCopy) jdBannerCopy.addEventListener('click',function(){
    var cmd='snapshot-jd';
    if(jdBannerCmd){ jdBannerCmd.hidden=false; jdBannerCmd.value=cmd; jdBannerCmd.focus(); jdBannerCmd.select(); }
    copyText(cmd);
  });
  window.__updateBanner=updateBanner;
  updateBanner();

  // Lay out both date-style views once (recent re-lays out when its tab opens).
  dvScan.refresh();
  dvRecent.refresh();
})();
</script>
</body>
</html>`;

// ── Self-check gate: never ship a dashboard whose browser <script> is broken ──
// WHAT: before overwriting index.html, syntax-validate the embedded browser
//   script (the IIFE) with `new Function(body)` — that compiles the code and
//   throws on a syntax error WITHOUT executing it.
// WHY: this whole page's JS lives inside a Node template literal, so an escape
//   mistake (e.g. writing '\n' where '\\n' was meant) can split a string and
//   throw at load — which silently kills BOTH date-nav and status painting in
//   the browser. This gate catches that here, on rebuild, instead of in your
//   browser after your statuses look "gone". If it fails we KEEP the last good
//   index.html and exit non-zero so nothing regresses.
// HOW: automatic on every `node output/dashboard/gen.mjs`; no action needed.
const scriptBodies = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
for (const body of scriptBodies) {
  try { new Function(body); }        // compile-only; we never call it
  catch (e) {
    console.error(`✗ REFUSING TO WRITE — generated browser script has a ${e.name}: ${e.message}`);
    console.error('  The previous index.html is untouched. Fix the template in gen.mjs and re-run.');
    process.exit(1);
  }
}

writeFileSync(OUT, html);
const dirTotal = dates.reduce((n, d) => n + byDate.get(d).filter((r) => isDirectorPlus(r.title)).length, 0);
console.log(`✅ scan dashboard written: ${OUT}`);
console.log(`   ${total} roles · ${dates.length} scan dates · ${dirTotal} Director+ · latest ${dates[0] || '—'}`);
console.log(`   seed: ${Object.keys(STATUS_SEED).length} saved status(es) from data/role-status.json`);
console.log(`   open: file://${OUT}`);
