// POST /api/submit  (Vercel Node function, CommonJS, zero dependencies, Node 18+)
//
// Emails every submission from the GordeyVille proposal page to Joey through Resend.
// The page posts { type, page, sentAt, data } and treats any 2xx as sent (it checks r.ok),
// so every failure here returns a non-2xx and the page shows its mailto fallback.
//
// Three types arrive:
//   accept     Section 09: the signed NDA, the layers chosen, the interview list, notes
//   note       "I have a question" panel, from anywhere on the page
//   job-sheet  "Where the work waits" overlay: ten jobs, five dates each
//
// Each email leads with what Joey does next, then the record. Nothing the page sends is
// dropped: unplaced fields render under "Everything else submitted", and the raw record is
// attached as JSON either way.

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// The one price for step one (gv-v7.0). The page must send exactly this; the handler never takes a price from the browser.
const STEP_ONE_PRICE = 18500;
// What the page shows for the funding application on its own, without step one.
const FUNDING_ALONE_PRICE = 5250;

// ============================== CONFIG ==============================
const CONFIG = {
  brand: { name: 'GordeyVille Customs', short: 'GordeyVille', ink: '#040406', body: '#2D2D2D', accent: '#D65E1D', evidence: '#256370', muted: '#57514C', rule: '#C8C8C8', surface: '#F9F9F9', bad: '#B42318' },
  from: process.env.SUBMIT_FROM || 'GordeyVille Proposal <onboarding@resend.dev>',
  to: process.env.SUBMIT_TO || 'joey.palomo@ecommercetexas.com',
  timeZone: 'America/Chicago',
  timeZoneLabel: 'Central',
  maxBodyBytes: 1024 * 1024,
  nda: { file: 'GordeyVilleCustoms_Mutual_NDA_eCommerceInc_v1_101726.pdf', label: 'Mutual NDA, version 1, October 17, 2026' },
  types: ['accept', 'note', 'job-sheet']
};
// ============================ END CONFIG ============================

const B = CONFIG.brand;
const NDA_PATH = path.join(__dirname, '..', 'assets', CONFIG.nda.file);

// ---------- helpers ----------
const str = (v, max = 8000) => { const s = v == null ? '' : typeof v === 'string' ? v : String(v); return s.length > max ? s.slice(0, max) + ' [cut, full text in the attachment]' : s; };
const esc = v => str(v, 50000).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const sha256 = buf => crypto.createHash('sha256').update(buf).digest('hex');
const header = (req, n) => { const v = req.headers[n]; return Array.isArray(v) ? v[0] : v || ''; };
const human = k => { const s = String(k).replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/[_-]+/g, ' ').toLowerCase(); return s.charAt(0).toUpperCase() + s.slice(1); };
const cad = n => 'C$' + Number(n || 0).toLocaleString('en-US', { minimumFractionDigits: Number(n) % 1 ? 2 : 0, maximumFractionDigits: 2 });
const plural = (n, one, many) => n + ' ' + (n === 1 ? one : many || one + 's');
const list = a => a.length <= 1 ? a.join('') : a.slice(0, -1).join(', ') + ' and ' + a[a.length - 1];
const trimAll = v => (v == null ? '' : String(v).trim());
// Stable JSON for the idempotency key: same content, same key, whatever the key order.
const stable = v => Array.isArray(v) ? '[' + v.map(stable).join(',') + ']' : v && typeof v === 'object' ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}' : JSON.stringify(v);

function readBody(req) {
  if (req.body && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) return Promise.resolve(req.body);
  if (typeof req.body === 'string' || Buffer.isBuffer(req.body)) return Promise.resolve(JSON.parse(String(req.body)));
  return new Promise((resolve, reject) => {
    let size = 0; const chunks = [];
    req.on('data', c => { size += c.length; if (size > CONFIG.maxBodyBytes) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}

function serverMeta(req) {
  let city = header(req, 'x-vercel-ip-city'); try { city = decodeURIComponent(city); } catch (e) {}
  return {
    receivedAtIso: new Date().toISOString(),
    ip: (header(req, 'x-forwarded-for').split(',')[0] || header(req, 'x-real-ip') || '').trim(),
    location: [city, header(req, 'x-vercel-ip-country-region'), header(req, 'x-vercel-ip-country')].filter(Boolean).join(', '),
    host: header(req, 'host'),
    deployment: process.env.VERCEL_URL || '',
    requestId: header(req, 'x-vercel-id'),
    userAgent: header(req, 'user-agent')
  };
}
function localTime(iso) {
  try { return new Date(iso).toLocaleString('en-US', { timeZone: CONFIG.timeZone, dateStyle: 'long', timeStyle: 'short' }) + ' ' + CONFIG.timeZoneLabel; } catch (e) { return iso; }
}
// The page promises a countersignature, and an answer to a question, within one business day.
function nextBusinessDay(iso) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: CONFIG.timeZone, year: 'numeric', month: 'numeric', day: 'numeric' }).formatToParts(new Date(iso));
  const g = t => +parts.find(p => p.type === t).value;
  const d = new Date(Date.UTC(g('year'), g('month') - 1, g('day') + 1));
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric' });
}

// ---------- email blocks ----------
const td = 'border-bottom:1px solid ' + B.rule + ';';
const SANS = 'Arial,Helvetica,sans-serif', SERIF = "Georgia,'Times New Roman',serif";
function section(title, inner) {
  return `<tr><td style="padding:28px 32px 4px;"><div style="font:700 11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:${B.evidence};padding-bottom:10px;border-bottom:1px solid ${B.ink};">${esc(title)}</div>${inner}</td></tr>`;
}
function rows(pairs) {
  const body = pairs.filter(Boolean).map(([k, v, raw]) =>
    `<tr><td valign="top" style="padding:10px 16px 10px 0;${td}width:36%;font:700 13px/1.5 ${SANS};color:${B.muted};">${esc(k)}</td>` +
    `<td valign="top" style="padding:10px 0;${td}font:15px/1.5 ${SERIF};color:${B.ink};white-space:pre-wrap;">${raw ? v : (esc(v) || '<span style="color:#8A837C;">Not given</span>')}</td></tr>`).join('');
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;">${body}</table>`;
}
function grid(head, body, opts = {}) {
  const th = head.map((h, i) => `<th align="${(opts.right || []).includes(i) ? 'right' : 'left'}" style="padding:8px 10px 8px 0;border-bottom:1px solid ${B.ink};font:700 11px/1.4 ${SANS};letter-spacing:.06em;text-transform:uppercase;color:${B.muted};white-space:nowrap;">${esc(h)}</th>`).join('');
  const tr = body.map(r => '<tr>' + r.map((c, i) => {
    const cell = c && typeof c === 'object' ? c : { t: c };
    return `<td valign="top" align="${(opts.right || []).includes(i) ? 'right' : 'left'}" style="padding:9px 10px 9px 0;${td}font:${i === 0 && opts.boldFirst ? 'bold ' : ''}14px/1.45 ${SERIF};color:${cell.color || B.ink};${(opts.nowrap || []).includes(i) ? 'white-space:nowrap;' : ''}">${cell.raw ? cell.t : esc(cell.t == null || cell.t === '' ? '' : cell.t)}</td>`;
  }).join('') + '</tr>').join('');
  return `<div style="overflow-x:auto;"><table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:6px;">${'<tr>' + th + '</tr>' + tr}</table></div>`;
}
const para = (html, style = '') => `<p style="margin:12px 0 0;font:15px/1.6 ${SERIF};color:${B.ink};${style}">${html}</p>`;
const mono = t => `<span style="font:12px/1.5 Menlo,Consolas,monospace;word-break:break-all;">${esc(t)}</span>`;
const quote = (t, c = B.ink) => `<div style="margin:12px 0 0;padding:14px 16px;border-left:3px solid ${c};background:${B.surface};font:15px/1.6 ${SERIF};color:${B.ink};white-space:pre-wrap;">${esc(t)}</div>`;
const badge = (ok, text) => { const c = ok ? B.evidence : B.bad; return `<span style="display:inline-block;padding:2px 8px;border:1px solid ${c};color:${c};font:700 12px/1.6 ${SANS};">${esc(text)}</span>`; };
const signature = t => `<span style="font:italic 24px/1.3 ${SERIF};">${esc(t)}</span>`;
function steps(items) {
  return `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;margin-top:4px;">` + items.map((t, i) =>
    `<tr><td valign="top" style="padding:12px 12px 12px 0;${td}width:28px;font:700 13px/1.6 ${SANS};letter-spacing:.06em;color:${B.accent};">${String(i + 1).padStart(2, '0')}</td>` +
    `<td valign="top" style="padding:12px 0;${td}font:15px/1.6 ${SERIF};color:${B.ink};">${t}</td></tr>`).join('') + '</table>';
}
function value(v) {
  if (v == null || v === '') return '';
  if (typeof v === 'boolean') return v ? 'Yes' : 'No';
  if (Array.isArray(v)) return v.length ? v.map(x => (x && typeof x === 'object' ? Object.entries(x).map(([k, y]) => human(k) + ': ' + value(y)).join(' · ') : value(x))).join('\n') : 'None';
  if (typeof v === 'object') return Object.entries(v).map(([k, y]) => human(k) + ': ' + value(y)).join('\n');
  const s = String(v);
  return s.length > 3000 ? `[${s.length.toLocaleString('en-US')} characters, in the JSON attachment]` : s;
}
// Every key the renderer did not place, at any depth, so a new field on the page still reaches Joey.
function leftovers(obj, used, prefix = '') {
  const out = [];
  Object.entries(obj || {}).forEach(([k, v]) => {
    const p = prefix ? prefix + '.' + k : k;
    if (used.has(p)) return;
    if ([...used].some(u => u.startsWith(p + '.')) && v && typeof v === 'object' && !Array.isArray(v)) out.push(...leftovers(v, used, p));
    else out.push([p.split('.').map(human).join(' · '), value(v)]);
  });
  return out;
}

function shell(preheader, eyebrow, headline, lede, body, version) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>${esc(headline)}</title></head><body style="margin:0;padding:0;background:${B.surface};">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${esc(preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${B.surface};"><tr><td align="center" style="padding:24px 12px;">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:680px;background:#FFFFFF;border:1px solid ${B.rule};">` +
    `<tr><td style="background:${B.ink};padding:22px 32px;"><span style="font:700 22px/1 ${SERIF};color:#FFFFFF;">${esc(B.name)}</span><span style="display:inline-block;width:7px;height:7px;background:${B.accent};margin-left:3px;"></span>` +
    `<div style="font:11px/1.4 ${SANS};letter-spacing:.08em;text-transform:uppercase;color:#BDB6AE;padding-top:8px;">${esc(eyebrow)}</div></td></tr>` +
    `<tr><td style="padding:30px 32px 0;"><h1 style="margin:0;font:700 26px/1.25 ${SERIF};color:${B.ink};">${esc(headline)}</h1>${para(esc(lede), 'color:' + B.muted + ';')}</td></tr>` +
    body + `<tr><td style="padding:28px 32px 30px;font:12px/1.6 ${SANS};color:#8A837C;">Sent by the GordeyVille proposal page through Resend. Page build: ${esc(version || 'not sent')}. The full record is attached as JSON.</td></tr></table></td></tr></table></body></html>`;
}
function audit(meta, client) {
  return section('Audit trail', rows([
    ['Received by the server', localTime(meta.receivedAtIso) + ' (' + meta.receivedAtIso + ')'],
    ['Sent, their clock', client.sentAt || ''],
    ['IP address', meta.ip], ['Location from IP', meta.location],
    ['Browser', str(client.userAgent || meta.userAgent, 600)], client.timezone ? ['Their time zone', client.timezone] : null,
    ['Served from', meta.host], ['Submission key', mono(client.key || ''), true]
  ]));
}

// ---------- accept: the signed NDA and step one ----------
function buildAccept(d, env, meta, ctx) {
  const nda = d.nda || {}, ch = d.choice || {}, dates = d.dates || {};
  const people = Array.isArray(d.interviews) ? d.interviews : [];
  const notes = (Array.isArray(d.notes) ? d.notes : []).filter(n => n && trimAll(n.text));
  // The handler has already refused any accept whose price is not STEP_ONE_PRICE (see priceProblem).
  const total = STEP_ONE_PRICE;
  const choiceText = `step one at ${cad(total)} plus GST`;
  const due = nextBusinessDay(meta.receivedAtIso);
  const who = trimAll(nda.name) + (trimAll(nda.title) ? ', ' + trimAll(nda.title) : '');
  const noEmail = people.filter(p => !trimAll(p.email)).map(p => trimAll(p.name) || 'one person');
  const sigOk = !!trimAll(nda.signature) && trimAll(nda.signature).replace(/\s+/g, ' ').toLowerCase() === trimAll(nda.name).replace(/\s+/g, ' ').toLowerCase();
  const pdfOk = !!ctx.ndaSha && nda.pdfSha256 === ctx.ndaSha;

  const moves = [
    `Countersign the NDA and email it to ${esc(nda.email)} by <strong>${esc(due)}</strong>. Replying to this email reaches ${esc(nda.name)}. The exact PDF they signed against is attached.`
  ];
  moves.push(`Send the first invoice with the countersigned NDA: half of ${cad(total)}, so <strong>${cad(total / 2)} plus GST</strong>. The other half is billed at the review meeting.`);
  moves.push(`Send each interview link on <strong>${esc(dates.linksOpen || 'the date on the page')}</strong> to ${plural(people.length, 'person', 'people')}: ${esc(list(people.map(p => trimAll(p.name))))}.` +
    (noEmail.length ? ` <span style="color:${B.accent};font-weight:bold;">No email given for ${esc(list(noEmail))}.</span> Ask ${esc(d.coordinator || nda.name)}, who coordinates on their side.` : ' Every email is below.'));
  if (notes.length) moves.push(`Answer the ${plural(notes.length, 'note')} they left on the page before you countersign.` + (notes.some(n => n.sent === false || n.draft) ? ' At least one never sent on its own, so this is the first time you see it.' : ''));
  moves.push(`Hold the review meeting, proposed for ${esc(dates.reviewProposed || 'the date on the page')}, ${esc(String(d.walkthrough || '').toLowerCase() || 'in the format they chose')}.`);

  const used = new Set(['version', 'nda', 'consent', 'restatement', 'choice', 'interviews', 'count', 'coordinator', 'walkthrough', 'notes', 'dates', 'client', 'fundingLink']);
  let body = section('Your next moves', steps(moves));

  if (notes.length) {
    body += section('Read before you countersign', notes.map(n =>
      `<div style="margin-top:14px;font:700 11px/1.4 ${SANS};letter-spacing:.06em;text-transform:uppercase;color:${B.muted};">${esc(n.about || 'This page')}${n.sent === false || n.draft ? ' · <span style="color:' + B.accent + ';">Not sent before signing</span>' : ''}</div>` + quote(n.text, B.accent)).join(''));
  }

  body += section('The signature', rows([
    ['Business, legal name', nda.legal], ['Address', nda.address], ['Signed by', who], ['Notice email', nda.email],
    ['Signature, typed', nda.signature ? signature(nda.signature) : '', !!nda.signature],
    ['Signature matches the name', badge(sigOk, sigOk ? 'Matches' : 'Does not match the name'), true],
    ['Authorized to bind the business', value(nda.authorized)], ['Agreed to sign electronically', value(nda.agreedToElectronicSignature)],
    ['Other party', nda.partyOne]
  ]));
  used.add('nda.pdfSha256'); used.add('nda.pdf');

  body += section('What they agreed to', quote(d.restatement || '') + para('<strong>Consent, NDA and step one</strong>') + quote((d.consent || {}).ndaAndStepOne || '') +
    ((d.consent || {}).approval || (d.consent || {}).layers ? para('<strong>Consent, the price</strong>') + quote(d.consent.approval || d.consent.layers) : ''));

  body += section('The price', rows([
    ['Step one', `${cad(total)} plus GST, billed half on the first invoice and half at the review meeting.`],
    ['Included', 'The interviews and job dates, the written plan, the hire-or-machine answer (drafting capacity and machine payback), the funding application with David at no charge, and the follow-up proposal.'],
    ['Credit', 'Every dollar comes off any build within 90 days of the review meeting.'],
    ['Funding alone', `The page priced the funding application alone at ${cad(FUNDING_ALONE_PRICE)} plus GST.`]
  ]));

  body += section('Interviews', grid(['Name', 'Role', 'Email'], people.map(p => [p.name || '', p.role || '', trimAll(p.email) ? p.email : { t: 'Not given', color: B.accent }]), { boldFirst: true }) +
    rows([['Coordinates on their side', d.coordinator], ['Review walkthrough', d.walkthrough]]));

  body += section('Dates', rows([
    ['Sign by', dates.signBy], ['Signed on', dates.signedOn], ['Interview links open', dates.linksOpen],
    ['Interviews close', dates.interviewsClose], ['Review meeting, proposed', dates.reviewProposed], ['Raw answers deleted by', dates.deleteBy]
  ]));

  body += section('Integrity', rows([
    ['NDA file', `${esc(CONFIG.nda.label)}<br>${mono(nda.pdf || CONFIG.nda.file)}`, true],
    ['Fingerprint, from their page', mono(nda.pdfSha256 || 'Not read on their device'), true],
    ['Fingerprint, checked here', badge(pdfOk, pdfOk ? 'Matches the attached PDF' : nda.pdfSha256 ? 'Does not match the attached PDF' : 'Nothing to check'), true],
    ['Page version', d.version]
  ]));

  const rest = leftovers(d, used);
  if (rest.length) body += section('Everything else submitted', rows(rest));
  body += audit(meta, { sentAt: env.sentAt, userAgent: (d.client || {}).userAgent, timezone: (d.client || {}).timezone, key: ctx.key });

  const lede = `${who} signed the mutual NDA for ${trimAll(nda.legal) || 'the business'} on ${dates.signedOn || 'today'} and chose ${choiceText}. ` +
    `${plural(people.length, 'person takes', 'people take')} the interviews; links open ${dates.linksOpen || 'next week'}. ` +
    (notes.length ? `They left ${plural(notes.length, 'note')}. Read ${notes.length === 1 ? 'it' : 'them'} first.` : 'They left no notes.');
  return {
    subject: `${B.short} signed the NDA: ${trimAll(nda.name) || 'GordeyVille'} chose ${choiceText}` + (notes.length ? ` (${plural(notes.length, 'note')})` : ''),
    eyebrow: 'Signed · step one' + (d.version ? ' · ' + d.version : ''),
    headline: `${trimAll(nda.name) || 'GordeyVille'} signed. Countersign by ${due}.`,
    lede, body, replyTo: /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(trimAll(nda.email)) ? trimAll(nda.email) : null,
    summary: { pdfFingerprintVerified: pdfOk, signatureMatchesName: sigOk, priceFromServer: STEP_ONE_PRICE, countersignBy: due, firstInvoice: total / 2 },
    attachPdf: true
  };
}

// ---------- note: a question from the page ----------
function buildNote(d, env, meta, ctx) {
  const due = nextBusinessDay(meta.receivedAtIso);
  const about = trimAll(d.about) || 'This page';
  let body = section('The question', quote(d.text, B.accent) + rows([['Asked from', about]]));
  const rest = leftovers(d, new Set(['about', 'text']));
  if (rest.length) body += section('Everything else submitted', rows(rest));
  body += audit(meta, { sentAt: env.sentAt, key: ctx.key });
  const first = trimAll(d.text).replace(/\s+/g, ' ');
  return {
    subject: (about === 'Step one in smaller pieces' ? `${B.short} asked for smaller pieces: ` : `${B.short} question, ${about}: `) + (first.length > 70 ? first.slice(0, 67).replace(/\s+\S*$/, '') + '…' : first),
    eyebrow: 'Question · from the proposal page',
    headline: `${B.short} has a question. Answer by ${due}.`,
    lede: `Sent from "${about}" on the proposal page. The page promises an answer by email within one business day. The page does not say who sent it; if the NDA is signed, the signer's email is in that record.`,
    body, summary: { answerBy: due }
  };
}

// ---------- job-sheet: ten jobs, five dates each ----------
// Mirrors analyze() on the page, so the email names the same longest step the page showed.
const STEPS = [['drawing', 'Drawing', 'getting the drawing done', 'yes', 'drawn'], ['cutting', 'Cutting', 'getting cut parts back', 'drawn', 'cut'], ['staging', 'Staging', 'staging for the floor', 'cut', 'weld'], ['floor', 'On the floor', 'the floor, from welding to out the door', 'weld', 'out']];
const days = (a, b) => { if (!a || !b) return null; const x = (Date.parse(b) - Date.parse(a)) / 86400000; return isNaN(x) ? null : Math.round(x); };
const median = v => { if (!v.length) return null; const s = [...v].sort((a, b) => a - b), m = s.length >> 1; return Math.floor((s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2) + 0.5); };
function outOfOrder(r) { const seq = [r.yes, r.drawn, r.cut, r.weld, r.out].filter(Boolean).map(Date.parse); for (let i = 1; i < seq.length; i++) if (seq[i] < seq[i - 1]) return true; return false; }
function analyzeSheet(rowsIn) {
  const calc = rowsIn.map(r => { const c = { warn: outOfOrder(r), total: days(r.yes, r.out) }; STEPS.forEach(([k, , , a, b]) => { c[k] = days(r[a], r[b]); }); return c; });
  const med = {}, cnt = {};
  STEPS.forEach(([k]) => { const v = calc.filter(c => !c.warn && c[k] !== null).map(c => c[k]); med[k] = median(v); cnt[k] = v.length; });
  const ready = STEPS.filter(([k]) => cnt[k] >= 3);
  const ranked = [...ready].sort((a, b) => med[b[0]] - med[a[0]]);
  const allIn = ready.length === STEPS.length;
  const close = allIn && ranked.length > 1 && med[ranked[0][0]] - med[ranked[1][0]] <= 2;
  return { calc, med, cnt, top: allIn ? ranked[0] : null, close: close ? ranked[1] : null, missing: STEPS.filter(([k]) => cnt[k] < 3) };
}
function buildSheet(d, env, meta, ctx) {
  const jobs = (Array.isArray(d.rows) ? d.rows : []).filter(r => r && typeof r === 'object');
  const a = analyzeSheet(jobs);
  const warned = a.calc.filter(c => c.warn).length;
  let headline, lede;
  if (a.top && a.close) {
    headline = `${a.top[1]} and ${a.close[1].toLowerCase()} are too close to call: ${a.med[a.top[0]]} and ${a.med[a.close[0]]} days`;
    lede = `On the middle job, ${a.top[2]} takes ${plural(a.med[a.top[0]], 'day')} and ${a.close[2]} ${a.med[a.close[0]]}. Dates alone cannot separate them; the interviews have to.`;
  } else if (a.top) {
    headline = `${a.top[1]} is the longest step: about ${plural(a.med[a.top[0]], 'day')} on the middle job`;
    lede = `Across ${plural(a.cnt[a.top[0]], 'job')} with both dates, ${a.top[2]} takes the longest. That time includes work and waiting; the interviews tell you which.`;
  } else {
    headline = `The job sheet arrived without enough dates to name the longest step`;
    lede = `${plural(jobs.length, 'job')} came in. Each step needs dates on at least 3 jobs; still short: ${list(a.missing.map(s => s[2]))}.`;
  }
  if (warned) lede += ` ${plural(warned, 'job has', 'jobs have')} dates out of order and ${warned === 1 ? 'is' : 'are'} left out of the medians.`;

  const stepRows = STEPS.map(([k, label]) => [label, a.cnt[k] >= 3 ? `${a.med[k]} ${a.med[k] === 1 ? 'day' : 'days'}` : { t: 'Too few dates', color: B.muted }, String(a.cnt[k])]);
  const fmtD = v => (v ? new Date(v + 'T12:00:00Z').toLocaleDateString('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: '2-digit' }) : '');
  const jobRows = jobs.map((r, i) => {
    const c = a.calc[i], n = v => (v === null ? '' : String(v));
    return [(r.job || 'Job ' + (i + 1)) + (c.warn ? ' (dates out of order)' : ''), r.line || '', fmtD(r.yes), fmtD(r.drawn), fmtD(r.cut), fmtD(r.weld), fmtD(r.out),
      { t: n(c.drawing), color: a.top && a.top[0] === 'drawing' ? B.evidence : B.ink }, { t: n(c.cutting), color: a.top && a.top[0] === 'cutting' ? B.evidence : B.ink },
      { t: n(c.staging), color: a.top && a.top[0] === 'staging' ? B.evidence : B.ink }, { t: n(c.floor), color: a.top && a.top[0] === 'floor' ? B.evidence : B.ink }, n(c.total)];
  });

  let body = section('What the page showed them', quote(d.finding || 'No finding text sent.') + para('The headline above is recomputed here from the same dates, with the same rules.', 'color:' + B.muted + ';font-size:13px;'));
  if (trimAll(d.note)) body += section('Their note', quote(d.note, B.accent));
  body += section('Middle job, by step', grid(['Step', 'Median', 'Jobs counted'], stepRows, { boldFirst: true, right: [1, 2] }));
  body += section('The jobs, dates and days', grid(['Job', 'Line', 'Yes', 'Drawn', 'Cut', 'Weld', 'Out', 'Draw', 'Cut', 'Stage', 'Floor', 'Total'], jobRows, { boldFirst: true, nowrap: [2, 3, 4, 5, 6], right: [7, 8, 9, 10, 11] }) +
    para('Days between dates. The same rows are attached as a CSV.', 'color:' + B.muted + ';font-size:13px;'));
  const rest = leftovers(d, new Set(['rows', 'note', 'finding']));
  if (rest.length) body += section('Everything else submitted', rows(rest));
  body += audit(meta, { sentAt: env.sentAt, key: ctx.key });

  const cols = ['job', 'line', 'yes', 'drawn', 'cut', 'weld', 'out'];
  const csvCell = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const csv = [cols.concat(['drawing_days', 'cutting_days', 'staging_days', 'floor_days', 'total_days', 'out_of_order']).join(',')]
    .concat(jobs.map((r, i) => cols.map(k => csvCell(r[k])).concat(['drawing', 'cutting', 'staging', 'floor', 'total'].map(k => a.calc[i][k] === null ? '' : a.calc[i][k]), [a.calc[i].warn ? 'yes' : '']).join(','))).join('\n');

  return {
    subject: `${B.short} sent the job sheet: ${plural(jobs.length, 'job')}. ${headline}`,
    eyebrow: 'Job sheet · where the work waits',
    headline, lede, body,
    summary: { medians: a.med, counted: a.cnt, longest: a.top ? a.top[0] : null },
    extra: [{ filename: `gordyville-job-sheet-${meta.receivedAtIso.slice(0, 10)}.csv`, content: Buffer.from(csv).toString('base64') }]
  };
}

const BUILD = { accept: buildAccept, note: buildNote, 'job-sheet': buildSheet };
const REQUIRED = {
  accept: d => ['legal', 'name', 'signature', 'email'].filter(k => !trimAll((d.nda || {})[k])).map(k => 'nda.' + k),
  note: d => (trimAll(d.text) ? [] : ['text']),
  'job-sheet': d => (Array.isArray(d.rows) ? [] : ['rows'])
};

// ---------- the price gate (accept only) ----------
// Returns why an accept payload does not carry the one server price, or '' when it does.
function priceProblem(d) {
  const ch = d.choice;
  if (!ch || typeof ch !== 'object' || Array.isArray(ch)) return 'no choice was sent';
  const reasons = [];
  if (!(ch.base && typeof ch.base === 'object' && Number(ch.base.price) === STEP_ONE_PRICE)) reasons.push(`base price ${JSON.stringify(ch.base && ch.base.price)} is not ${STEP_ONE_PRICE}`);
  if (Number(ch.total) !== STEP_ONE_PRICE) reasons.push(`total ${JSON.stringify(ch.total)} is not ${STEP_ONE_PRICE}`);
  ['addonIds', 'addons', 'layerIds'].forEach(k => {
    const v = ch[k] !== undefined ? ch[k] : d[k];
    if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0) && v !== '') reasons.push(`${k} was sent (${JSON.stringify(v).slice(0, 80)})`);
  });
  return reasons.join('; ');
}
function buildRejection(env, meta, reason, key) {
  const d = env.data || {}, nda = d.nda || {};
  const raw = JSON.stringify(env, null, 2);
  const body = section('Why it was refused', rows([['Reason', reason], ['Server price', `${cad(STEP_ONE_PRICE)} plus GST`], ['Page build', env.version || d.version || 'not sent']])) +
    section('Who tried to sign', rows([['Name', nda.name], ['Business, legal name', nda.legal], ['Notice email', nda.email]])) +
    section('The raw payload', `<pre style="margin:12px 0 0;padding:14px 16px;background:${B.surface};font:12px/1.5 Menlo,Consolas,monospace;white-space:pre-wrap;word-break:break-all;color:${B.ink};">${esc(raw.length > 40000 ? raw.slice(0, 40000) + '\n[cut, full payload attached]' : raw)}</pre>`) +
    audit(meta, { sentAt: env.sentAt, key });
  const lede = `The page sent a signature whose price is not ${cad(STEP_ONE_PRICE)}. Nothing was recorded as signed and the signer saw the page's "did not send" message. If this was a real signature, contact them.`;
  return { subject: `${B.short} submission rejected: price mismatch`, html: shell(lede, 'Rejected · price mismatch', 'A signature was refused: the price did not match', lede, body, env.version || d.version), text: lede + '\n\nReason: ' + reason + '\n\n' + raw };
}

// ---------- send ----------
async function resend(payload, key) {
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + process.env.RESEND_API_KEY, 'Content-Type': 'application/json', 'Idempotency-Key': key },
    body: JSON.stringify(payload)
  });
  let j = null; try { j = await r.json(); } catch (e) {}
  return { status: r.status, json: j };
}
// The page treats any 2xx as sent and shows `id` as the record's reference.
function reply(res, id, meta, extra) { return res.status(200).json(Object.assign({ ok: true, id, receivedAt: meta.receivedAtIso }, extra)); }

let ndaCache = null;
function ndaFile() {
  if (ndaCache === null) { try { const buf = fs.readFileSync(NDA_PATH); ndaCache = { buf, sha: sha256(buf) }; } catch (e) { console.error('submit: NDA PDF missing at', NDA_PATH); ndaCache = false; } }
  return ndaCache || null;
}

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method !== 'POST') { res.setHeader('Allow', 'POST'); return res.status(405).json({ ok: false, error: 'POST only' }); }

  // Browsers send Origin on cross-site POSTs. Only this site may submit.
  const origin = header(req, 'origin');
  if (origin) { try { if (new URL(origin).host !== header(req, 'host')) return res.status(403).json({ ok: false, error: 'origin' }); } catch (e) { return res.status(403).json({ ok: false, error: 'origin' }); } }

  if (!process.env.RESEND_API_KEY) { console.error('submit: RESEND_API_KEY is not set'); return res.status(500).json({ ok: false, error: 'not configured' }); }

  let env;
  try { env = await readBody(req); } catch (e) { return res.status(400).json({ ok: false, error: 'bad json' }); }
  if (!env || typeof env !== 'object' || Array.isArray(env)) return res.status(400).json({ ok: false, error: 'bad body' });
  const type = env.type;
  if (!CONFIG.types.includes(type)) return res.status(400).json({ ok: false, error: 'unknown type' });
  const d = env.data && typeof env.data === 'object' && !Array.isArray(env.data) ? env.data : null;
  if (!d) return res.status(400).json({ ok: false, error: 'missing data' });
  if (type === 'accept') {
    const problem = priceProblem(d);
    if (problem) {
      const meta = serverMeta(req), key = 'gordyville-reject-' + sha256('reject' + stable(d)).slice(0, 40);
      const alert = buildRejection(env, meta, problem, key);
      const att = [{ filename: `gordyville-rejected-payload-${meta.receivedAtIso.slice(0, 10)}.json`, content: Buffer.from(JSON.stringify(Object.assign({}, env, { server: Object.assign({}, meta, { rejected: problem }) }), null, 2)).toString('base64') }];
      try {
        const out = await resend({ from: CONFIG.from, to: String(CONFIG.to).split(',').map(x => x.trim()).filter(Boolean), subject: alert.subject, html: alert.html, text: alert.text, attachments: att, tags: [{ name: 'source', value: 'gordyville_proposal' }, { name: 'type', value: 'rejected' }] }, key);
        console.error('submit: rejected accept,', problem, '| alert', out.status, out.json && (out.json.id || out.json.name));
      } catch (e) { console.error('submit: rejected accept,', problem, '| alert unreachable', e && e.message); }
      return res.status(400).json({ ok: false, error: 'price mismatch' });
    }
  }
  const missing = REQUIRED[type](d);
  if (missing.length) return res.status(400).json({ ok: false, error: 'missing ' + missing.join(', ') });

  const meta = serverMeta(req);
  // Same content, same key: a double click or a retry after a timeout never sends twice.
  const key = ('gordyville-' + type + '-' + sha256(type + stable(d)).slice(0, 40));
  const nda = type === 'accept' ? ndaFile() : null;
  const mail = BUILD[type](d, env, meta, { key, ndaSha: nda && nda.sha });

  const stamp = meta.receivedAtIso.slice(0, 10);
  const record = Object.assign({}, env, { server: Object.assign({}, meta, mail.summary, { idempotencyKey: key }) });
  const attachments = [{ filename: `gordyville-${type}-record-${stamp}.json`, content: Buffer.from(JSON.stringify(record, null, 2)).toString('base64') }];
  if (mail.attachPdf && nda) attachments.push({ filename: CONFIG.nda.file, content: nda.buf.toString('base64') });
  if (mail.extra) attachments.push(...mail.extra);
  const to = String(CONFIG.to).split(',').map(s => s.trim()).filter(Boolean);
  const text = [mail.headline.toUpperCase(), '', mail.lede, '', 'The full record is in the attached JSON.'].join('\n');

  try {
    const payload = { from: CONFIG.from, to, subject: str(mail.subject, 240), html: shell(mail.lede, mail.eyebrow, mail.headline, mail.lede, mail.body, env.version || d.version), text, attachments, tags: [{ name: 'source', value: 'gordyville_proposal' }, { name: 'type', value: type.replace(/-/g, '_') }] };
    if (mail.replyTo) payload.reply_to = mail.replyTo;
    const out = await resend(payload, key);
    if (out.status >= 200 && out.status < 300 && out.json && out.json.id) { console.log('submit: sent', type, out.json.id); return reply(res, out.json.id, meta); }
    // Same key, different body: the earlier send went through; only the server timestamp changed.
    if (out.status === 409 && out.json && out.json.name === 'invalid_idempotent_request') { console.log('submit: duplicate', type, key); return reply(res, null, meta, { duplicate: true }); }
    console.error('submit: resend error', out.status, JSON.stringify(out.json));
    return res.status(502).json({ ok: false, error: 'send failed' });
  } catch (e) {
    console.error('submit: resend unreachable', e && e.message);
    return res.status(502).json({ ok: false, error: 'send failed' });
  }
};
