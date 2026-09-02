# @coreloom/landing

The public Coreloom website. A standalone OctaneJS application: one
server-rendered page, no session, no database, no module composition. It shares
nothing with the platform shell, so marketing copy and visual experiments here
can never reach the product.

```bash
pnpm landing          # http://127.0.0.1:4330
pnpm --filter @coreloom/landing build
pnpm --filter @coreloom/landing preview
```

`CL_LANDING_PORT` overrides the development port.

## What lives here

- `src/LandingPage.tsrx`: the page, its icons, brand mark and animated demos.
- `src/landing.copy.ts`: every string, one object per locale. `pl` is typed
  from `en`, so a missing key fails typecheck.
- `src/locale.ts`: the two-locale store, persisted in `localStorage`.
- `src/landing.css`: the landing's own palette, scale and motion, prefixed
  `l-`. It deliberately does not use the product design tokens.

The sign-in and sign-up buttons point at the deployed platform. Set
`CL_LANDING_APP_URL` at build time to send them somewhere other than the same
origin.
