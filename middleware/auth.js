const jwt = require('jsonwebtoken');
const { supabase } = require('../config/database');

// Middleware to verify JWT token
async function authenticateToken(req, res, next) {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

        if (!token) {
            return res.status(401).json({ error: 'Access token required' });
        }

        jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
            if (err) {
                return res.status(403).json({ error: 'Invalid or expired token' });
            }

            const { data: users, error } = await supabase
                .from('users')
                .select('id, email, name, subscription_tier, subscription_status, stripe_customer_id')
                .eq('id', decoded.userId)
                .limit(1);

            if (error || !users || users.length === 0) {
                return res.status(404).json({ error: 'User not found' });
            }

            req.user = users[0];
            next();
        });
    } catch (error) {
        console.error('Auth middleware error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
}

// Optional authentication
async function optionalAuth(req, res, next) {
    try {
        const authHeader = req.headers['authorization'];
        const token = authHeader && authHeader.split(' ')[1];

        if (!token) return next();

        jwt.verify(token, process.env.JWT_SECRET, async (err, decoded) => {
            if (!err && decoded.userId) {
                const { data: users } = await supabase
                    .from('users')
                    .select('id, email, name, subscription_tier, subscription_status')
                    .eq('id', decoded.userId)
                    .limit(1);

                if (users && users.length > 0) {
                    req.user = users[0];
                }
            }
            next();
        });
    } catch (error) {
        next();
    }
}

// Check subscription tier
function requireSubscription(allowedTiers) {
    return (req, res, next) => {
        if (!req.user) {
            return res.status(401).json({ error: 'Authentication required' });
        }
        if (!allowedTiers.includes(req.user.subscription_tier)) {
            return res.status(403).json({
                error: 'This feature requires a premium subscription',
                currentTier: req.user.subscription_tier,
                requiredTiers: allowedTiers
            });
        }
        if (req.user.subscription_status !== 'active') {
            return res.status(403).json({
                error: 'Your subscription is not active',
                status: req.user.subscription_status
            });
        }
        next();
    };
}

// Check usage limits
async function checkUsageLimit(actionType, tierLimits) {
    return async (req, res, next) => {
        try {
            if (!req.user) {
                return res.status(401).json({ error: 'Authentication required' });
            }

            const tier = req.user.subscription_tier;
            const limit = tierLimits[tier];

            if (limit === -1) return next(); // unlimited

            const today = new Date().toISOString().split('T')[0];

            const { data: usage } = await supabase
                .from('usage_tracking')
                .select('count')
                .eq('user_id', req.user.id)
                .eq('action_type', actionType)
                .eq('date', today)
                .limit(1);

            const currentCount = usage && usage.length > 0 ? usage[0].count : 0;

            if (currentCount >= limit) {
                return res.status(429).json({
                    error: `Daily limit reached for ${actionType}`,
                    limit,
                    used: currentCount,
                    upgrade: tier === 'free' ? 'Upgrade to Pro for unlimited access' : null
                });
            }

            // Upsert usage count
            await supabase.from('usage_tracking').upsert({
                user_id: req.user.id,
                action_type: actionType,
                date: today,
                count: currentCount + 1
            }, { onConflict: 'user_id,action_type,date' });

            req.remainingLimit = limit - currentCount - 1;
            next();
        } catch (error) {
            console.error('Usage limit check error:', error);
            next();
        }
    };
}

module.exports = { authenticateToken, optionalAuth, requireSubscription, checkUsageLimit };
