#!/usr/bin/env python3
"""Unpack and repack the single-file page bundle (index.html).

The page is a Claude Design export: the real markup lives in <script type="__bundler/template">
as one JSON string, beside a manifest of base64 assets. Edit the template, never the bundle by hand.

  python3 -I tools/bundle.py unpack index.html build/template.html
  python3 -I tools/bundle.py pack   index.html build/template.html   # writes index.html in place

pack re-encodes exactly like the exporter (UTF-8 JSON, "</" written as "<\\u002F"), so an
unpack followed by pack with no edits reproduces the file byte for byte.
"""
import json, re, sys

RX = re.compile(r'(<script type="__bundler/template">)(.*?)(</script>)', re.S)

def main():
    if len(sys.argv) != 4 or sys.argv[1] not in ('unpack', 'pack'):
        sys.exit(__doc__)
    cmd, bundle, tpl = sys.argv[1:]
    html = open(bundle, encoding='utf-8').read()
    m = RX.search(html)
    if not m:
        sys.exit('no __bundler/template block in ' + bundle)
    if cmd == 'unpack':
        open(tpl, 'w', encoding='utf-8').write(json.loads(m.group(2).strip()))
        print('wrote', tpl)
        return
    raw = m.group(2)
    lead, trail = raw[:len(raw) - len(raw.lstrip())], raw[len(raw.rstrip()):]
    enc = json.dumps(open(tpl, encoding='utf-8').read(), ensure_ascii=False).replace('</', '<\\u002F')
    out = html[:m.start(2)] + lead + enc + trail + html[m.end(2):]
    open(bundle, 'w', encoding='utf-8').write(out)
    print('packed', tpl, 'into', bundle, len(out), 'bytes')

if __name__ == '__main__':
    main()
