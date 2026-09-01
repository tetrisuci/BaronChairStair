# Bundled fonts

A Discord activity runs in a sandboxed iframe that cannot reach
`fonts.googleapis.com`, so the two faces the interface depends on are served
from this directory instead of from a CDN. They are latin-subset `woff2` files
taken from the Google Fonts CDN.

| File | Family | Upstream |
| --- | --- | --- |
| `archivo-var-latin.woff2` | Archivo (variable: weight 400–900, width 75–125%) | <https://github.com/Omnibus-Type/Archivo> |
| `dm-mono-400-latin.woff2`, `dm-mono-500-latin.woff2` | DM Mono (400, 500) | <https://github.com/googlefonts/dm-mono> |

Both are licensed under the **SIL Open Font License, Version 1.1**, whose full
text sits alongside the fonts in `OFL-Archivo.txt` and `OFL-DM-Mono.txt`, as the
licence requires.

To refresh them, ask the Google Fonts CSS API for the same families with a
browser user agent, then download the `latin` `woff2` URLs it returns:

```sh
curl -A "Mozilla/5.0 ... Chrome/126.0 Safari/537.36" \
  "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@75..125,400..900&family=DM+Mono:wght@400;500&display=swap"
```
