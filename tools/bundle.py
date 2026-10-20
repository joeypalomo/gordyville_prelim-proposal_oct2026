#!/usr/bin/env python3
"""Unpack and repack the single-file page bundle (index.html).

The page is a Claude Design export: the real markup lives in <script type="__bundler/template">
as one JSON string, beside a manifest of base64 assets. The job sheet page ("Where the work
waits") is one of those assets, stored gzip-compressed. Edit the sources, never the bundle by hand.

  python3 -I tools/bundle.py unpack index.html src/template.html [src/job-sheet.html]
  python3 -I tools/bundle.py pack   index.html src/template.html [src/job-sheet.html]   # writes index.html in place

pack re-encodes exactly like the exporter (UTF-8 JSON, "</" written as "<\\u002F"), so an
unpack followed by pack with no edits reproduces the file byte for byte. The job sheet asset
keeps its original compressed bytes while its source is unchanged; once edited it is
recompressed (gzip level 9, mtime 0), which the page's loader reads the same way.
"""
import base64, gzip, json, re, sys

RX = re.compile(r'(<script type="__bundler/template">)(.*?)(</script>)', re.S)
MX = re.compile(r'(<script type="__bundler/manifest">)(.*?)(</script>)', re.S)
JOB_SHEET = 'a22346a5-009c-4083-b36a-76067420ddb7'

def block(rx, html, bundle):
    m = rx.search(html)
    if not m:
        sys.exit('no %s block in %s' % (rx.pattern.split('"')[1], bundle))
    return m

def splice(html, m, enc):
    raw = m.group(2)
    lead, trail = raw[:len(raw) - len(raw.lstrip())], raw[len(raw.rstrip()):]
    return html[:m.start(2)] + lead + enc + trail + html[m.end(2):]

def asset_text(entry):
    data = base64.b64decode(entry['data'])
    return (gzip.decompress(data) if entry.get('compressed') else data).decode('utf-8')

def main():
    if len(sys.argv) not in (4, 5) or sys.argv[1] not in ('unpack', 'pack'):
        sys.exit(__doc__)
    cmd, bundle, tpl = sys.argv[1:4]
    sheet = sys.argv[4] if len(sys.argv) == 5 else None
    html = open(bundle, encoding='utf-8').read()
    if cmd == 'unpack':
        open(tpl, 'w', encoding='utf-8').write(json.loads(block(RX, html, bundle).group(2).strip()))
        print('wrote', tpl)
        if sheet:
            manifest = json.loads(block(MX, html, bundle).group(2).strip())
            open(sheet, 'w', encoding='utf-8').write(asset_text(manifest[JOB_SHEET]))
            print('wrote', sheet)
        return
    if sheet:
        m = block(MX, html, bundle)
        manifest = json.loads(m.group(2).strip())
        entry, src = manifest[JOB_SHEET], open(sheet, encoding='utf-8').read()
        if asset_text(entry) != src:
            body = src.encode('utf-8')
            entry['data'] = base64.b64encode(gzip.compress(body, 9, mtime=0) if entry.get('compressed') else body).decode('ascii')
            enc = json.dumps(manifest, ensure_ascii=False, separators=(',', ':')).replace('</', '<\\u002F')
            html = splice(html, m, enc)
    enc = json.dumps(open(tpl, encoding='utf-8').read(), ensure_ascii=False).replace('</', '<\\u002F')
    out = splice(html, block(RX, html, bundle), enc)
    open(bundle, 'w', encoding='utf-8').write(out)
    print('packed', tpl, *(['and', sheet] if sheet else []), 'into', bundle, len(out), 'bytes')

if __name__ == '__main__':
    main()
