const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');

// Get default/demo user
router.get('/', async (req, res) => {
    try {
        const { data: rows, error } = await supabase
            .from('users').select('*').limit(1);

        if (error) throw error;

        if (!rows || rows.length === 0) {
            const { data: newUser, error: insertError } = await supabase
                .from('users')
                .insert({ email: 'demo@jobpilot.ai', name: 'Demo User', location: 'Remote',
                    job_type_preference: 'full-time', remote_preference: true })
                .select();
            if (insertError) throw insertError;
            return res.json(newUser[0]);
        }

        res.json(rows[0]);
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// Get user by ID
router.get('/:id', async (req, res) => {
    try {
        const { data: rows, error } = await supabase
            .from('users').select('*').eq('id', req.params.id).limit(1);

        if (error) throw error;
        if (!rows || rows.length === 0)
            return res.status(404).json({ error: 'User not found' });

        res.json(rows[0]);
    } catch (error) {
        console.error('Error fetching user:', error);
        res.status(500).json({ error: 'Failed to fetch user' });
    }
});

// Create user
router.post('/', async (req, res) => {
    try {
        const { email, name, phone, location, job_type_preference, remote_preference } = req.body;

        const { data: newUser, error } = await supabase
            .from('users')
            .insert({ email, name, phone, location, job_type_preference, remote_preference: remote_preference || false })
            .select();

        if (error) throw error;
        res.status(201).json(newUser[0]);
    } catch (error) {
        console.error('Error creating user:', error);
        res.status(500).json({ error: 'Failed to create user' });
    }
});

// Update user
router.put('/:id', async (req, res) => {
    try {
        const { email, name, phone, location, job_type_preference, remote_preference } = req.body;

        const { data: updated, error } = await supabase
            .from('users')
            .update({ email, name, phone, location, job_type_preference, remote_preference, updated_at: new Date().toISOString() })
            .eq('id', req.params.id)
            .select();

        if (error) throw error;
        res.json(updated[0]);
    } catch (error) {
        console.error('Error updating user:', error);
        res.status(500).json({ error: 'Failed to update user' });
    }
});

module.exports = router;
