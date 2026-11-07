# Bridge

The web page that connects the Blindfold extension to the user's wallet. Wallets inject their providers only into web
pages, never into `chrome-extension://` pages, so the extension sends finished, unsigned transactions here and this
page asks the wallet to sign them. It never sees orders, salts, witnesses or the passphrase, and never asks for a
message signature. Protocol: `extension-team/INTERFACES.md`, "Extension <-> bridge page".

```bash
source ../../env.sh
npm ci
npm test          # offline: protocol, wallet adapter (mock EIP-1193 provider), static server
npm start         # dev server on http://localhost:4317 (PORT overrides)
```

- `public/` is the whole page: plain static files, no build and no server logic (D9). `server.mjs` only serves it in dev.
- Wallets: EIP-6963 discovery, falling back to `window.ethereum`. Batches use EIP-5792 `wallet_sendCalls` when the
  wallet reports atomic support, otherwise one transaction at a time.

## Production
- Replace `public/config.mjs` with the Web Store extension ID. That is the only deploy-specific value; the extension
  holds the bridge origin (its `externally_connectable` match and its port origin check).
- Serve `public/` over https with `Content-Security-Policy: frame-ancestors 'none'` (or `X-Frame-Options: DENY`) as a
  header: the page triggers wallet prompts, so it must not be framed, and a `<meta>` CSP can't forbid framing.
