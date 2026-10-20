# GordeyVille Customs, preliminary proposal

Live at https://gordyville-customs-preliminary-prop.vercel.app/ (Vercel project
`gordyville-customs-preliminary-proposal-8eeb0bb2-…`, team `e-commerce-texas`).

## What is here

| Path | What it is |
|---|---|
| `index.html` | The page as served. A single-file bundle: never edit it by hand. |
| `src/template.html` | The page's markup and logic, decoded from the bundle. Edit this. |
| `src/job-sheet.html` | The job sheet page ("Where the work waits"), a compressed asset inside the bundle. Edit this. |
| `tools/bundle.py` | `unpack` and `pack` between the two. Round trip is byte for byte. |
| `api/submit.js` | The function every submission posts to. Emails Joey through Resend. |
| `assets/…NDA…v1_101726.pdf` | The NDA the page shows. Attached to every signing email and served at the page's fallback link. |

To change the page: edit `src/template.html` or `src/job-sheet.html`, then
`python3 -I tools/bundle.py pack index.html src/template.html src/job-sheet.html`, commit all three.

## What the page sends, and what Joey gets

The page posts `{ type, page, sentAt, data }` to `/api/submit` and treats any 2xx as sent.
Any failure returns non-2xx, so the page shows its "email Joey" fallback instead of a false success.

| type | From | Email subject starts | Attachments |
|---|---|---|---|
| `accept` | Section 09, Sign and start | `GordeyVille signed the NDA: <name> chose <option>` | record JSON, the NDA PDF |
| `note` | "I have a question" panel | `GordeyVille question, <where>:` | record JSON |
| `job-sheet` | "Where the work waits" overlay | `GordeyVille sent the job sheet:` | record JSON, rows as CSV (with each job's "Ready last" pick) |

The signing email leads with the next moves (countersign date, first invoice amount, interview
links and any missing emails), then notes, signature, consents, choice, interviews, dates, an
integrity check (the page fingerprints the NDA PDF it showed; the server confirms it matches the
attached file) and an audit trail. Reply-to is the signer's notice email.

Retries never double-send: the Resend idempotency key is a hash of the submission's content.

## Settings (Vercel, Production)

- `RESEND_API_KEY` (set). Without it the function returns 500 and the page shows its fallback.
- `SUBMIT_TO` (optional): comma-separated recipients. Default `joey.palomo@ecommercetexas.com`.
- `SUBMIT_FROM` (optional): default `GordeyVille Proposal <onboarding@resend.dev>`, which Resend
  delivers only to the Resend account owner. To send from `ecommercetexas.com` or to anyone else,
  verify the domain in Resend first, then set this.

## The price lives in two places

Step one is one price (since gv-v7.0): C$18,500 plus GST. It is `BASE.price` in `src/template.html` and
`STEP_ONE_PRICE` in `api/submit.js`; the funding application alone is `FUNDING_ALONE` and
`FUNDING_ALONE_PRICE` (C$5,250). The handler refuses any signature whose price differs (400, plus
an alert email to Joey). Change both files together, and every literal `C$18,500` in the copy.

## Test locally

The skill's harness runs the real function with Resend mocked:
`node harness.js . api/submit.js out 4317`, then drive the page in Chromium. Use TEST values on
production; those emails really send.
