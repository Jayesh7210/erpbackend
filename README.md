# Sanap ERP - Backend API

Modular Express.js backend for Sanap ERP with Supabase integration and offline fallback.

## Tech Stack
- **Node.js** & **Express 5**
- **Supabase** (PostgreSQL & Storage)
- **Cors** & **Dotenv**

## Project Structure
```
backend/
├── data/
│   └── state.js              # Connection state & health-check
├── database/
│   ├── schema.sql            # Core database schema
│   └── create_missing_tables.sql
├── routes/
│   ├── auth.js               # Authentication & password management
│   ├── workforce.js          # Onboarding requests & approvals
│   ├── users.js              # User management, RBAC, on-duty toggle
│   ├── permissions.js        # Granular permissions
│   ├── warehouses.js         # Warehouse hubs
│   ├── products.js           # Catalog and price configuration
│   ├── stock.js              # Inward, intake, transfers, recalls & alerts
│   ├── customers.js          # Customer directory & onboarding
│   ├── sales.js              # Sales entry & multi-dimensional reports
│   ├── referrals.js          # Multi-tier referral trees & commissions
│   ├── settlements.js        # Daily cash settlements & reconciliations
│   ├── payments.js           # Payment ledger
│   ├── reports.js            # Summary analytics & audit trail
│   └── fsm.js                # Field Sales Manager dashboard & QR returns
├── services/
│   ├── audit.js              # Centralized audit logger
│   ├── authService.js        # Rate-limiting, brute-force protection
│   └── productMeta.js        # Dynamic pricing and commission resolver
├── db.js                     # Supabase client initialization
└── index.js                  # Express bootstrap & route mounting
```

## Setup & Running

1. **Install dependencies:**
   ```bash
   npm install
   ```

2. **Configure environment:**
   Create a `.env` file based on `.env.example`:
   ```env
   PORT=5000
   SUPABASE_URL=https://<your-project>.supabase.co
   SUPABASE_ANON_KEY=<your-anon-key>
   SUPABASE_SERVICE_ROLE_KEY=<your-service-role-key>
   ```

3. **Start the server:**
   ```bash
   npm run dev
   # or
   npm start
   ```

Server runs on `http://localhost:5000`.
