const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');

// Get activity log for a user
router.get('/user/:userId', async (req, res) => {
    try {
        const { limit = 50, type } = req.query;

        let query = supabase.from('activity_log').select('*')
            .eq('user_id', req.params.userId)
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (type) query = query.eq('activity_type', type);

        const { data: activities, error } = await query;
        if (error) throw error;

        res.json({ activities: activities || [], count: activities ? activities.length : 0 });
    } catch (error) {
        console.error('Error fetching activity log:', error);
        res.status(500).json({ error: 'Failed to fetch activity log' });
    }
});

// Create activity log entry
router.post('/', async (req, res) => {
    try {
        const { userId, activity_type, description, metadata } = req.body;
        if (!userId || !activity_type) return res.status(400).json({ error: 'userId and activity_type are required' });

        const { data: newActivity, error } = await supabase.from('activity_log')
            .insert({ user_id: userId, activity_type, description: description || null,
                metadata: metadata ? JSON.stringify(metadata) : null })
            .select();
        if (error) throw error;

        res.status(201).json(newActivity[0]);
    } catch (error) {
        console.error('Error creating activity log:', error);
        res.status(500).json({ error: 'Failed to create activity log' });
    }
});

// Get activity statistics
router.get('/stats/:userId', async (req, res) => {
    try {
        const { data: activities, error } = await supabase
            .from('activity_log').select('activity_type, created_at')
            .eq('user_id', req.params.userId);
        if (error) throw error;

        const statsMap = {};
        for (const a of (activities || [])) {
            if (!statsMap[a.activity_type]) statsMap[a.activity_type] = { count: 0, last_activity: a.created_at };
            statsMap[a.activity_type].count++;
            if (a.created_at > statsMap[a.activity_type].last_activity)
                statsMap[a.activity_type].last_activity = a.created_at;
        }

        const stats = Object.entries(statsMap).map(([activity_type, v]) => ({ activity_type, ...v }))
            .sort((a, b) => b.count - a.count);

        res.json({ statistics: stats, total: activities ? activities.length : 0 });
    } catch (error) {
        console.error('Error fetching activity stats:', error);
        res.status(500).json({ error: 'Failed to fetch activity stats' });
    }
});

module.exports = router;
