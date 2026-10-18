require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { initSupabase } = require('./data/state');

// Import modular routes
const authRoutes = require('./routes/auth');
const workforceRoutes = require('./routes/workforce');
const userRoutes = require('./routes/users');
const permissionRoutes = require('./routes/permissions');
const warehouseRoutes = require('./routes/warehouses');
const productRoutes = require('./routes/products');
const stockRoutes = require('./routes/stock');
const customerRoutes = require('./routes/customers');
const salesRoutes = require('./routes/sales');
const referralRoutes = require('./routes/referrals');
const settlementRoutes = require('./routes/settlements');
const paymentRoutes = require('./routes/payments');
const reportRoutes = require('./routes/reports');
const fsmRoutes = require('./routes/fsm');

const app = express();
app.use(cors());
app.use(express.json({ limit: '50mb' }));

const PORT = process.env.PORT || 5000;

// Simple Logger Middleware
app.use((req, res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
  next();
});

// Initialize database connection
initSupabase();

// Health check endpoint
app.get('/', (req, res) => {
  res.json({
    app: 'Sanap ERP Backend API',
    status: 'online',
    version: '1.0.0'
  });
});

// Mount modular route handlers
app.use(authRoutes);
app.use(workforceRoutes);
app.use(userRoutes);
app.use(permissionRoutes);
app.use(warehouseRoutes);
app.use(productRoutes);
app.use(stockRoutes);
app.use(customerRoutes);
app.use(salesRoutes);
app.use(referralRoutes);
app.use(settlementRoutes);
app.use(paymentRoutes);
app.use(reportRoutes);
app.use(fsmRoutes);

// Global Error Handler
app.use((err, req, res, next) => {
  console.error('Unhandled Server Error:', err);
  res.status(500).json({ error: err.message || 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`ERP Backend API is running on http://localhost:${PORT}`);
});

module.exports = app;
