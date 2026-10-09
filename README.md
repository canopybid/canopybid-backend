# CanopyBid backend

A small Express API that does three things the frontend prototype couldn't do on its own:

1. **Proxies the photo analysis call to Claude**, so your Anthropic API key lives on the server, never in the browser.
2. **Stores leads** in a real Postgres database instead of losing them the moment the tab closes.
3. **Tracks territories and companies**, so an accepted, paid-for lead gets matched to whichever company owns that territory.

## Run it locally

```bash
npm install
cp .env.example .env
# then edit .env: paste in your Anthropic key, Stripe test key, and a Postgres connection string
npm start
```

You need a Postgres database to run this, even locally now — see below if you don't have one yet.

## Local Postgres (for testing before you deploy)

The easiest path on a Mac is **Postgres.app** (postgresapp.com):

1. Download it, drag to Applications, open it, click "Initialize."
2. In Terminal, run: `createdb canopybid`
3. In `.env`, set: `DATABASE_URL=postgres://localhost:5432/canopybid`

## Endpoints

| Method | Path | Purpose |
|---|---|---|
| POST | `/api/analyze` | Send `{ images: [{media_type, data}], services }`, get back the tree analysis JSON |
| GET | `/api/territories` | List all territories, monthly price, and which company (if any) owns each |
| POST | `/api/checkout/create` | Start a real Stripe payment for one or more territories |
| GET | `/api/checkout/confirm` | Called by the frontend after a successful Stripe payment; creates the company and claims the territories |
| POST | `/api/leads` | Store an accepted estimate; auto-matches to the owning company |
| GET | `/api/companies/leads` | A company fetches its own leads, using its API key in the `x-api-key` header |

## Setting up email notifications (Resend)

1. Create a free account at resend.com — no credit card required.
2. Go to API Keys, create one, copy it.
3. Paste it into `.env` as `RESEND_API_KEY`.
4. **Important limitation until you verify a domain**: without your own verified sending domain, Resend only lets you send to the email address you signed up with. For testing, put *your own email* in as the homeowner's optional email and as the test company's email — that's the only address it'll actually deliver to. Verifying a real domain (a few DNS records) removes this limit before a real launch.

## Setting up Stripe (test mode)

1. Create a free account at stripe.com if you don't have one.
2. Make sure you're in **test mode** (toggle in the Stripe dashboard) — this uses fake money, no real charges.
3. Go to Developers → API keys, copy the **Secret key** (starts with `sk_test_`).
4. Paste it into `.env` as `STRIPE_SECRET_KEY`.
5. Test payments with Stripe's test card: `4242 4242 4242 4242`, any future expiry date, any 3-digit CVC, any ZIP.

## Running the companies page locally

`canopybid-companies.html` cannot just be double-clicked open. Stripe needs a real web address to redirect back to after payment, and a `file://` link doesn't work for that. Serve it locally instead:

```bash
cd wherever-you-saved-canopybid-companies.html
python3 -m http.server 5500
```

Then open `http://localhost:5500/canopybid-companies.html`. Leave that command running in its own Terminal window. Make sure `FRONTEND_URL` in `.env` is `http://localhost:5500` (the default).

## Deploying for real

### 1. Backend + database on Render

1. Push the `canopybid-backend` folder to a GitHub repository.
2. In Render (render.com), click **New → PostgreSQL**. Name it, pick the free tier, create it. Copy the **Internal Database URL**.
3. Click **New → Web Service**, connect your GitHub repo. Build command: `npm install`. Start command: `npm start`.
4. Under Environment, add: `DATABASE_URL` (the Internal Database URL from step 2), `ANTHROPIC_API_KEY`, `STRIPE_SECRET_KEY`, and `FRONTEND_URL` (fill in after step 2 below).
5. Deploy. Render gives you a live URL like `https://canopybid-backend.onrender.com`.

### 2. Frontend on Netlify

1. Go to netlify.com, drag the folder containing `canopybid-demo.html` and `canopybid-companies.html` onto the deploy area.
2. Netlify gives you a URL like `https://random-name-123.netlify.app`.
3. In both HTML files, change `const API_BASE = "http://localhost:3000";` to your real Render backend URL from step 1.
4. Re-deploy the updated files to Netlify (drag the folder again).
5. Back in Render, update `FRONTEND_URL` to your Netlify URL and redeploy the backend so Stripe redirects work correctly.

### 3. A real domain

1. Buy a domain (Namecheap, Google Domains — roughly $10–15/year).
2. In Netlify, go to Domain settings, add your custom domain, follow their DNS instructions.
3. Once DNS propagates (can take a few hours), your domain points at the live site.

### Live Stripe mode

Everything above uses Stripe **test mode**. Before accepting real payments: complete Stripe's account activation (business details, bank account), switch to a live secret key (`sk_live_...`) in Render's environment variables, and test the whole flow once more with a real, small charge.
