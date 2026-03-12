const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

// Get applications for a user
router.get('/user/:userId', async (req, res) => {
    try {
        const { status, limit = 100 } = req.query;

        let query = supabase.from('applications')
            .select('*, jobs(title, company, location, url, remote), matches(overall_score, matching_skills, missing_skills)')
            .eq('user_id', req.params.userId)
            .order('created_at', { ascending: false })
            .limit(parseInt(limit));

        if (status) query = query.eq('status', status);

        const { data: applications, error } = await query;
        if (error) throw error;

        res.json({ applications: applications || [], count: applications ? applications.length : 0 });
    } catch (error) {
        console.error('Error fetching applications:', error);
        res.status(500).json({ error: 'Failed to fetch applications' });
    }
});

// Get application stats
router.get('/stats/:userId', async (req, res) => {
    try {
        const { data: apps, error } = await supabase
            .from('applications').select('status').eq('user_id', req.params.userId);
        if (error) throw error;

        const stats = { total: 0, ready: 0, applied: 0, under_review: 0, interview: 0, offer: 0, rejected: 0 };
        for (const app of (apps || [])) {
            stats.total++;
            if (stats[app.status] !== undefined) stats[app.status]++;
        }
        res.json(stats);
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// Get application by ID
router.get('/:id', async (req, res) => {
    try {
        const { data: applications, error } = await supabase
            .from('applications')
            .select('*, jobs(*), matches(overall_score, matching_skills, missing_skills)')
            .eq('id', req.params.id).limit(1);
        if (error) throw error;
        if (!applications || applications.length === 0)
            return res.status(404).json({ error: 'Application not found' });

        const { data: coverLetters } = await supabase
            .from('cover_letters').select('*')
            .eq('application_id', req.params.id)
            .order('created_at', { ascending: false }).limit(1);

        res.json({ application: applications[0], cover_letter: coverLetters && coverLetters.length > 0 ? coverLetters[0] : null });
    } catch (error) {
        console.error('Error fetching application:', error);
        res.status(500).json({ error: 'Failed to fetch application' });
    }
});

// Create application
// userId is read from the JWT token — frontend only needs to send jobId
router.post('/', authenticateToken, async (req, res) => {
    try {
        // Get userId from JWT token (req.user set by authenticateToken middleware)
        // Also accept userId from body as fallback for compatibility
        const userId = (req.user && req.user.id) ? req.user.id : req.body.userId;
        const { jobId, matchId, notes } = req.body;

        if (!userId || !jobId) return res.status(400).json({ error: 'userId and jobId are required' });

        const { data: existing } = await supabase.from('applications').select('*')
            .eq('user_id', userId).eq('job_id', jobId).limit(1);
        if (existing && existing.length > 0)
            return res.status(409).json({ error: 'Application already exists for this job', application: existing[0] });

        const { data: newApp, error } = await supabase.from('applications')
            .insert({ user_id: userId, job_id: jobId, match_id: matchId || null, status: 'ready', notes: notes || null })
            .select('*, jobs(title, company, location)');
        if (error) throw error;

        await supabase.from('activity_log').insert({
            user_id: userId, activity_type: 'application_created', description: 'New application created'
        });

        res.status(201).json(newApp[0]);
    } catch (error) {
        console.error('Error creating application:', error);
        res.status(500).json({ error: 'Failed to create application' });
    }
});

// Update application
router.patch('/:id', async (req, res) => {
    try {
        const { status, notes, applied_date } = req.body;
        const updates = {};
        if (status) updates.status = status;
        if (notes !== undefined) updates.notes = notes;
        if (applied_date) updates.applied_date = applied_date;
        updates.updated_at = new Date().toISOString();

        if (Object.keys(updates).length === 1) return res.status(400).json({ error: 'No updates provided' });

        const { error } = await supabase.from('applications').update(updates).eq('id', req.params.id);
        if (error) throw error;

        if (status === 'applied') {
            const { data: app } = await supabase.from('applications').select('user_id').eq('id', req.params.id).limit(1);
            if (app && app.length > 0) {
                await supabase.from('activity_log').insert({
                    user_id: app[0].user_id, activity_type: 'application_submitted', description: 'Application submitted'
                });
            }
        }

        const { data: updated } = await supabase.from('applications')
            .select('*, jobs(title, company, location)').eq('id', req.params.id).limit(1);

        res.json(updated[0]);
    } catch (error) {
        console.error('Error updating application:', error);
        res.status(500).json({ error: 'Failed to update application' });
    }
});

// Delete application
router.delete('/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('applications').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ message: 'Application deleted successfully' });
    } catch (error) {
        console.error('Error deleting application:', error);
        res.status(500).json({ error: 'Failed to delete application' });
    }
});

module.exports = router;
