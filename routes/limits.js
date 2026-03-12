const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { optionalAuth } = require('../middleware/auth');

const USAGE_LIMITS = {
    job_search: { free: 5, pro: -1, premium: -1 },
    job_view:   { free: 50, pro: -1, premium: -1 }
};

// Get user's subscription limits and usage
router.get('/limits', optionalAuth, async (req, res) => {
    try {
        const tier = req.user ? req.user.subscription_tier : 'free';
        const today = new Date().toISOString().split('T')[0];

        let usageMap = {};
        if (req.user) {
            const { data: usage } = await supabase
                .from('usage_tracking')
                .select('action_type, count')
                .eq('user_id', req.user.id)
                .eq('date', today);

            (usage || []).forEach(u => { usageMap[u.action_type] = u.count; });
        }

        res.json({
            tier,
            limits: {
                job_search: {
                    limit: USAGE_LIMITS.job_search[tier],
                    used: usageMap['job_search'] || 0,
                    remaining: USAGE_LIMITS.job_search[tier] === -1
                        ? 'unlimited'
                        : Math.max(0, USAGE_LIMITS.job_search[tier] - (usageMap['job_search'] || 0))
                },
                job_view: {
                    limit: USAGE_LIMITS.job_view[tier],
                    used: usageMap['job_view'] || 0,
                    remaining: USAGE_LIMITS.job_view[tier] === -1
                        ? 'unlimited'
                        : Math.max(0, USAGE_LIMITS.job_view[tier] - (usageMap['job_view'] || 0))
                }
            }
        });
    } catch (error) {
        console.error('Get limits error:', error);
        res.status(500).json({ error: 'Failed to get limits' });
    }
});

module.exports = router;
