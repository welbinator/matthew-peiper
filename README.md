# Master Carpenters LLC — plain Astro site (no EmDash)

Static Astro site for mastercarpentersllc.com.

## Stack
- Astro (static pages)
- Cloudflare adapter only for `/api/contact` (D1 + Command Center push)
- Content hardcoded in `src/data/`
- Images in `public/images/`

## Dev
```bash
source ~/.nvm/nvm.sh && nvm use 22
npm install
npm run dev
```

## Build
```bash
npm run build
# static HTML: dist/client/
# worker entry (contact API): dist/server/
```

## Contact form
Still posts to `/api/contact`, stores in D1 `ec_contact_submissions` (same table Command Center Forms reads), and notifies CC phone push. Requires `DB` binding + `PUSH_NOTIFY_SECRET` on the Worker.

## Deploy notes
- Do not push to `main` until James approves cutover
- Branch: `static-conversion`
- On first Worker deploy after cutover, pin any auto-created SESSION KV id in wrangler if CF requires it
