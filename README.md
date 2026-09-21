# PhoenixAI Studio - Premium Showcase Website

A premium, minimalist showcase website for PhoenixAI Studio's professional design services including Resume, Portfolio, and Cover Letter designs.

## Features

### Public Website
- **Premium Design**: Deep black, metallic gold, and phoenix orange theme
- **Hero Section**: Cinematic headline with call-to-action
- **Featured Templates**: Showcase of 4 featured templates
- **Category Sections**: Dedicated sections for Resume, Portfolio, and Cover Letter templates
- **Template Cards**: Beautiful cards with thumbnails, style tags, and preview functionality
- **Fullscreen Preview Modal**: Zoom controls, navigation, and download options
- **Trust Section**: 6 key trust indicators (ATS Friendly, Custom Made, Professional Impact, Confidential, Fast & Reliable, Dedicated Support)
- **Responsive Design**: Fully responsive across all devices
- **Portfolio URL Support**: External portfolio links with "Open Portfolio" buttons

### Admin Portal
- **Secure Authentication**: Password-protected admin access
- **Dashboard Overview**: Statistics for templates and inquiries
- **Template Management**: Add, edit, delete, and publish templates
- **Logo Management**: Upload and update the PhoenixAI logo
- **Portfolio URL Handling**: Safe storage and display of external portfolio links
- **Sort Order Control**: Control template display order
- **Featured Toggle**: Mark templates as featured
- **Publish Control**: Draft/published status for templates

## Security & Quality Audit (September 2026)

The following issues were found in a full review of the codebase and fixed.
Nothing in the authentication layer was changed — scrypt hashing, signed
stateless cookies, CSRF double-submit and login rate limiting were already
sound.

### Critical

- **Stored XSS on the public site.** `public/script.js` wrote API data into the
  page through `innerHTML` in 29 places without escaping. HTML saved through the
  admin panel executed in every visitor's browser, and a `javascript:` URL in a
  CTA or demo-link field became a live script. An apostrophe in a record name
  also broke the surrounding markup. Added `esc()`, `escArg()`, `safeUrl()` and
  `asList()` helpers and applied them to every renderer.
- **No security headers.** Added Content-Security-Policy, `X-Content-Type-Options`,
  `X-Frame-Options`, `Referrer-Policy`, `Permissions-Policy`,
  `Cross-Origin-Resource-Policy` and (in production) HSTS. `X-Powered-By` is now
  disabled, admin pages and API responses are `no-store`, and `/admin` sends
  `X-Robots-Tag: noindex`.

### Bugs

- The mobile menu passed `/admin` to `querySelector()`, an invalid selector that
  throws a `SyntaxError` — the link never navigated.
- `showDemoDetail` and `showDemoWebsitesList` were duplicated verbatim;
  `setupNavbarScroll` was defined twice and registered two scroll listeners.
- `agent.features.map()` / `agent.useCases.map()` threw on records missing those
  fields.
- Two inline SVG icons had malformed path data and rendered as broken shapes.
- Unknown `/api/*` paths returned Express's HTML error page, breaking clients
  that call `response.json()`. Added JSON and HTML 404 handlers.

### Performance

- `pet-bird.png` was 960 KB for an element rendered at 64×101 px → 22 KB.
- `logo-cutout.png` 82 KB → 17 KB.
- Added `loading="lazy"`, `decoding="async"` and intrinsic dimensions to images;
  `script.js` is now deferred; the scroll handler is rAF-throttled.
- Static assets get cache headers in production.

### UX & accessibility

- The inquiry form used `alert()`, discarded the server's actual error message
  (validation, rate limiting, read-only storage) and allowed double submission.
  It now shows inline errors, disables the button while sending, and announces
  success via `role="status"`.
- Mobile menu button had no accessible name and no `aria-expanded`; it now also
  closes on Escape.
- Preview modal gained `role="dialog"` / `aria-modal`; icon buttons gained
  labels; demo and agent cards are keyboard-operable.

### SEO

- `og:image` and `twitter:image` were relative paths, which breaks link previews
  on Facebook, Twitter and LinkedIn. Made absolute, added `og:url`.
- Added `ProfessionalService` JSON-LD structured data and a `robots` meta tag.
- Copyright year was hardcoded to 2024; now set at runtime.

### Known remaining limitations

- **JSON-file storage does not persist on serverless hosts.** The code detects a
  read-only filesystem and returns a clear 503, but admin changes will not
  survive a redeploy on Vercel. Use a host with a persistent disk (Railway,
  Render, a VPS) or move to a database.
- The markup still uses inline `onclick` handlers, so the CSP needs
  `'unsafe-inline'` for scripts. Migrating to event delegation would let that be
  removed.
- There is no automated test suite.

## Tech Stack

- **Backend**: Node.js with Express
- **Frontend**: Pure HTML, CSS, JavaScript (no frameworks)
- **Storage**: JSON file-based (easily upgradeable to database)
- **File Upload**: Multer for handling image and PDF uploads
- **Session Management**: Stateless, signed HTTP-only cookies (custom, works on serverless hosts — no `express-session`)

## Getting Started

### Installation

1. Install dependencies:
```bash
npm install
```

2. Start the server:
```bash
npm start
```

3. Access the website:
- Public site: `http://localhost:3000`
- Admin portal: `http://localhost:3000/admin`

### Default Admin Credentials

- **Password**: set via the `ADMIN_PASSWORD` environment variable before first run (see `.env.example`); change it from Admin → Settings afterward

## Project Structure

```
final showcase/
├── server.js              # Express server with API routes
├── package.json           # Dependencies and scripts
├── data.json              # Data storage (templates, settings)
├── uploads/               # Uploaded files (logos, images, PDFs)
├── public/
│   ├── index.html         # Public website
│   ├── admin.html         # Admin dashboard
│   ├── admin-login.html   # Admin login page
│   ├── styles.css         # Global styles
│   ├── script.js          # Public site JavaScript
│   └── admin-script.js    # Admin dashboard JavaScript
└── README.md             # This file
```

## Admin Usage

### Adding Templates

1. Login to admin portal
2. Navigate to "Templates" section
3. Click "+ Add Template"
4. Fill in the template details:
   - Template name
   - Category (Resume, Portfolio, Cover Letter)
   - Description
   - Style/Tag
   - Thumbnail image (required)
   - PDF file (optional)
   - Preview images (optional, multiple)
   - Portfolio URL (optional)
   - Sort order
   - Featured toggle
   - Published toggle
5. Click "Save Template"

### Managing Templates

- **Edit**: Click the "Edit" button on any template
- **Delete**: Click the "Delete" button (requires confirmation)
- **Publish/Unpublish**: Click the publish status button to toggle
- **Sort Order**: Set numerical values to control display order

### Logo Management

1. Navigate to "Settings" section
2. Upload a new logo image
3. Click "Update Logo"
4. The logo will be updated across the entire site

## Customization

### Brand Colors

Edit the CSS variables in `public/styles.css`:

```css
:root {
    --deep-black: #0a0a0a;
    --metallic-gold: #d4af37;
    --phoenix-orange: #ff6b35;
    --phoenix-fire: #ff4500;
    /* ... more colors */
}
```

### Admin Password

Never edit `adminPassword` in `data.json` directly — it's a one-way `scrypt` hash, not a value you set by hand. To change the password:
1. Log into `/admin` with the current password.
2. Go to Settings → Admin Password and set a new one there (it's hashed automatically).

The password is only ever set from plaintext once: on first run, from the `ADMIN_PASSWORD` environment variable (see `.env.example`), when `data.json` doesn't exist yet.

### Login troubleshooting

- **Locked out / changed `ADMIN_PASSWORD` in `.env` and it no longer works?** The env value is only read when `data.json` is first created; after that the stored hash wins. Reset it with:
  `npm run reset-password -- "MyNewStrongPassword"` (min. 8 characters), then log in at `/admin`.
- **`/admin` shows "Server is missing public/…"?** The host didn't bundle the `public/` folder with `server.js`. `vercel.json` now lists it under `includeFiles`; on other hosts make sure `public/` is deployed next to `server.js`.
- **Login page keeps coming back after entering the right password?** The auth cookie is being dropped. On HTTPS hosts make sure the proxy forwards `X-Forwarded-Proto` (Vercel/Railway/Render do). Over plain `http://` the cookie is only marked `Secure` when the request itself is HTTPS.
- **`/admin` opens the dashboard directly, no login page?** You're still signed in (the cookie is valid). Use `/admin?login` — it always shows the login page (the logo shortcut on the public site now opens exactly this). Or click **Logout** in the dashboard. If you sign in without ticking "Keep me signed in", the cookie is dropped when the browser is closed.
- **Too many attempts?** The limiter allows 5 tries per 15 minutes per IP; restart the server to clear it immediately.

## Security Notes

- Admin login uses a signed, HTTP-only cookie (stateless — no server-side session store needed, so it works the same on a normal server or on serverless hosts)
- Admin passwords are hashed with `scrypt` (Node's built-in `crypto`), never stored in plaintext after first login — a legacy plaintext `data.json` password is auto-upgraded the first time you log in with it
- The `/api/admin/login` endpoint is rate-limited (5 attempts per 15 minutes per IP)
- Admin routes are protected server-side
- File uploads are restricted to JPEG/PNG/WEBP/GIF (image fields) or PDF (pdf field), and limited to 10MB
- No sensitive data is exposed in frontend JavaScript
- Change the default admin password immediately
- Admin form submissions are protected by a CSRF token (double-submit cookie pattern), on top of `SameSite=Lax`
- Visitor-submitted fields (contact form inquiries, leads) are HTML-escaped before being rendered in the admin dashboard, to prevent stored XSS

**Never commit or publish `.env`.** It holds your real `SESSION_SECRET` and `ADMIN_PASSWORD`. Only `.env.example` (with placeholder values) should ever leave your machine — `.gitignore` keeps `.env` out of git, but that does *not* protect you if you zip up the project folder and share it directly; remove `.env` from any archive before sharing it.

## Deployment

### Local Development

For local development, the app uses file-based storage:
- `data.json` for all site data
- `uploads/` for uploaded files

Start the server:
```bash
npm start
```

### Vercel deployment (persistent storage)

Vercel's disk is read-only, so on Vercel the site data lives in **Upstash Redis** and uploaded files in **Vercel Blob**. Both switch on automatically when their environment variables exist; without them (local development) the app keeps using `data.json` + `uploads/`.

**One-time setup in the Vercel dashboard**

1. Project -> **Storage** -> create/connect **Upstash Redis**. This adds `KV_REST_API_URL` and `KV_REST_API_TOKEN` (a custom prefix such as `STORAGE_REST_API_URL` / `STORAGE_REST_API_TOKEN` is detected too). Make sure the variables are enabled for **Production**.
2. Project -> **Storage** -> create/connect **Blob**. This adds `BLOB_READ_WRITE_TOKEN`.
3. Project -> **Settings -> Environment Variables**: set `ADMIN_PASSWORD`, `SESSION_SECRET` (a long random string) and `NODE_ENV=production`.
4. **Redeploy** (env variables only apply to new deployments).
5. Open `https://<your-site>/api/health`. It must show `"ok": true`, `storage.data: "redis"` and `storage.files: "blob"`. If not, the `problems` list says exactly what is missing (names only, never secrets).

**How saving works.** Every API request works on its own copy of the data and saves it to Redis before the response is sent (atomic compare-and-set on `_rev`). If someone else saved at the same moment, only this request's changes are re-applied on top of the newest data, so simultaneous edits to different items never overwrite each other. If a save fails, the admin panel gets a clear error instead of pretending it worked.

**Good to know**
- `ADMIN_PASSWORD` only seeds the *initial* password. After you change it in Settings the stored hash is used; if the stored data is ever reset, the password goes back to `ADMIN_PASSWORD`.
- Request bodies are limited to about 4.5 MB on Vercel, so uploads are capped at 4 MB.
- Backup: log in and open `/api/admin/export` (everything except the password hash).
- Copy your local content to production once: `npx vercel link && npx vercel env pull .env.local && npm run seed-remote` (refuses to overwrite existing data unless you add `--force`).
- Tests: `npm test` (real HTTP requests against the real app with mock Upstash/Blob servers, no extra dependencies).
