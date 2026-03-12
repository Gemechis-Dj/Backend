const express = require('express');
const cors    = require('cors');
const helmet  = require('helmet');
const morgan  = require('morgan');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const { testConnection } = require('./config/database');

// Import routes
const authRoutes        = require('./routes/auth');
const paymentRoutes     = require('./routes/payments');
const userRoutes        = require('./routes/users');
const resumeRoutes      = require('./routes/resumes');
const jobRoutes         = require('./routes/jobs');
const matchRoutes       = require('./routes/matches');
const applicationRoutes = require('./routes/applications');
const coverLetterRoutes = require('./routes/coverLetters');
const activityRoutes    = require('./routes/activity');
const limitsRoutes      = require('./routes/limits');

const app  = express();
const PORT = process.env.PORT || 3000;

// ── CORS ── Allow all origins (safe: JWT protects all data routes) ────────────
app.use(cors({
    origin: true,          // reflects request origin — allows any origin
    credentials: true,
    methods: ['GET','POST','PUT','PATCH','DELETE','OPTIONS'],
    allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors()); // handle preflight for every route

// ── Security & logging ────────────────────────────────────────────────────────
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan('dev'));

// ── Rate limiting ─────────────────────────────────────────────────────────────
app.use(rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: 'Too many requests, please try again later.'
}));

// ── Body parsers ──────────────────────────────────────────────────────────────
// Stripe webhook needs raw body BEFORE json parser
app.use('/api/payments/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// ── Health check ──────────────────────────────────────────────────────────────
app.get('/health', (req, res) => {
    res.json({
        status:    'healthy',
        timestamp: new Date().toISOString(),
        uptime:    process.uptime(),
        database:  'Supabase (PostgreSQL)'
    });
});

// ── API Routes ────────────────────────────────────────────────────────────────
app.use('/api/auth',          authRoutes);
app.use('/api/payments',      paymentRoutes);
app.use('/api/users',         userRoutes);
app.use('/api/resumes',       resumeRoutes);
app.use('/api/jobs',          jobRoutes);
app.use('/api/matches',       matchRoutes);
app.use('/api/applications',  applicationRoutes);
app.use('/api/cover-letters', coverLetterRoutes);
app.use('/api/activity',      activityRoutes);
app.use('/api',               limitsRoutes);

// ── Root ──────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
    res.json({
        message:   'JobPilot AI Backend API',
        version:   '2.0.0',
        database:  'Supabase (PostgreSQL)',
        endpoints: {
            auth:         '/api/auth',
            payments:     '/api/payments',
            users:        '/api/users',
            resumes:      '/api/resumes',
            jobs:         '/api/jobs',
            matches:      '/api/matches',
            applications: '/api/applications',
            coverLetters: '/api/cover-letters',
            activity:     '/api/activity',
            limits:       '/api/limits',
            health:       '/health'
        }
    });
});

// ── 404 ───────────────────────────────────────────────────────────────────────
app.use((req, res) => {
    res.status(404).json({ error: 'Endpoint not found', path: req.path });
});

// ── Error handler ─────────────────────────────────────────────────────────────
app.use((err, req, res, next) => {
    console.error('Server error:', err.message);
    res.status(err.status || 500).json({ error: err.message || 'Internal server error' });
});

// ── Start ─────────────────────────────────────────────────────────────────────
async function startServer() {
    try {
        const ok = await testConnection();
        if (!ok) { console.error('❌ Supabase connection failed.'); process.exit(1); }

        app.listen(PORT, () => {
            console.log('');
            console.log('🚀 JobPilot AI Backend Server');
            console.log(`📡 Port: ${PORT}`);
            console.log(`🌍 Env:  ${process.env.NODE_ENV}`);
            console.log(`🗄️  DB:   ${process.env.SUPABASE_URL}`);
            console.log('');
        });
    } catch (err) {
        console.error('Startup failed:', err);
        process.exit(1);
    }
}

startServer();
module.exports = app;
