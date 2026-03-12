const express = require('express');
const router = express.Router();
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const { body, validationResult } = require('express-validator');
const { supabase } = require('../config/database');
const { authenticateToken } = require('../middleware/auth');

function generateToken(userId) {
    return jwt.sign({ userId }, process.env.JWT_SECRET, { expiresIn: '7d' });
}

// Register
router.post('/register', [
    body('email').isEmail().normalizeEmail(),
    body('password').isLength({ min: 8 }),
    body('name').trim().notEmpty()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        const { email, password, name, phone, location } = req.body;

        // Check existing user
        const { data: existing } = await supabase
            .from('users').select('id').eq('email', email).limit(1);
        if (existing && existing.length > 0)
            return res.status(409).json({ error: 'Email already registered' });

        const passwordHash = await bcrypt.hash(password, 10);

        const { data: newUsers, error } = await supabase
            .from('users')
            .insert({ email, password_hash: passwordHash, name, phone: phone || null,
                location: location || null, subscription_tier: 'free', subscription_status: 'active' })
            .select('id, email, name, phone, location, subscription_tier, subscription_status, created_at');

        if (error) throw error;
        const user = newUsers[0];

        await supabase.from('activity_log').insert({
            user_id: user.id, activity_type: 'user_registered', description: 'New user account created'
        });

        res.status(201).json({ message: 'Registration successful', token: generateToken(user.id), user });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(500).json({ error: 'Registration failed' });
    }
});

// Login
router.post('/login', [
    body('email').isEmail().normalizeEmail(),
    body('password').notEmpty()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        const { email, password } = req.body;

        const { data: users } = await supabase
            .from('users')
            .select('id, email, password_hash, name, phone, location, subscription_tier, subscription_status')
            .eq('email', email).limit(1);

        if (!users || users.length === 0)
            return res.status(401).json({ error: 'Invalid email or password' });

        const user = users[0];
        const validPassword = await bcrypt.compare(password, user.password_hash);
        if (!validPassword)
            return res.status(401).json({ error: 'Invalid email or password' });

        await supabase.from('users').update({ last_login: new Date().toISOString() }).eq('id', user.id);
        await supabase.from('activity_log').insert({
            user_id: user.id, activity_type: 'user_login', description: 'User logged in'
        });

        delete user.password_hash;
        res.json({ message: 'Login successful', token: generateToken(user.id), user });
    } catch (error) {
        console.error('Login error:', error);
        res.status(500).json({ error: 'Login failed' });
    }
});

// Get current user
router.get('/me', authenticateToken, async (req, res) => {
    try {
        const { data: users, error } = await supabase
            .from('users')
            .select('id, email, name, phone, location, subscription_tier, subscription_status, stripe_customer_id, subscription_start_date, subscription_end_date, trial_ends_at, created_at, last_login')
            .eq('id', req.user.id).limit(1);

        if (error || !users || users.length === 0)
            return res.status(404).json({ error: 'User not found' });

        const today = new Date().toISOString().split('T')[0];
        const { data: usage } = await supabase
            .from('usage_tracking').select('action_type, count')
            .eq('user_id', req.user.id).eq('date', today);

        res.json({ user: users[0], todayUsage: usage || [] });
    } catch (error) {
        console.error('Get profile error:', error);
        res.status(500).json({ error: 'Failed to get profile' });
    }
});

// Update profile
router.put('/me', authenticateToken, [
    body('name').optional().trim().notEmpty()
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        const { name, phone, location, job_type_preference, remote_preference } = req.body;

        const { error } = await supabase.from('users').update({
            name: name || req.user.name, phone, location,
            job_type_preference, remote_preference, updated_at: new Date().toISOString()
        }).eq('id', req.user.id);

        if (error) throw error;

        const { data: updated } = await supabase
            .from('users')
            .select('id, email, name, phone, location, job_type_preference, remote_preference, subscription_tier')
            .eq('id', req.user.id).limit(1);

        res.json({ user: updated[0] });
    } catch (error) {
        console.error('Update profile error:', error);
        res.status(500).json({ error: 'Failed to update profile' });
    }
});

// Change password
router.post('/change-password', authenticateToken, [
    body('currentPassword').notEmpty(),
    body('newPassword').isLength({ min: 8 })
], async (req, res) => {
    try {
        const errors = validationResult(req);
        if (!errors.isEmpty()) return res.status(400).json({ errors: errors.array() });

        const { currentPassword, newPassword } = req.body;

        const { data: users } = await supabase
            .from('users').select('password_hash').eq('id', req.user.id).limit(1);

        if (!users || users.length === 0)
            return res.status(404).json({ error: 'User not found' });

        const validPassword = await bcrypt.compare(currentPassword, users[0].password_hash);
        if (!validPassword)
            return res.status(401).json({ error: 'Current password is incorrect' });

        const newPasswordHash = await bcrypt.hash(newPassword, 10);
        await supabase.from('users').update({ password_hash: newPasswordHash }).eq('id', req.user.id);

        res.json({ message: 'Password changed successfully' });
    } catch (error) {
        console.error('Change password error:', error);
        res.status(500).json({ error: 'Failed to change password' });
    }
});

// Get usage stats
router.get('/usage', authenticateToken, async (req, res) => {
    try {
        const { days = 30 } = req.query;
        const fromDate = new Date();
        fromDate.setDate(fromDate.getDate() - parseInt(days));

        const { data: usage, error } = await supabase
            .from('usage_tracking')
            .select('action_type, date, count')
            .eq('user_id', req.user.id)
            .gte('date', fromDate.toISOString().split('T')[0])
            .order('date', { ascending: false });

        if (error) throw error;
        res.json({ usage: usage || [] });
    } catch (error) {
        console.error('Get usage error:', error);
        res.status(500).json({ error: 'Failed to get usage statistics' });
    }
});

module.exports = router;
