const express = require('express');
const router = express.Router();
const axios = require('axios');
const { supabase } = require('../config/database');

// Job API integrations (same fetch logic, only DB calls changed)
const jobAPIs = {
    async fetchRemoteOK(keyword = '', location = '') {
        try {
            const response = await axios.get('https://remoteok.com/api', {
                headers: { 'User-Agent': 'JobPilot-AI/1.0' }
            });
            let jobs = response.data.slice(1);
            if (keyword) {
                const kw = keyword.toLowerCase();
                jobs = jobs.filter(j =>
                    (j.position && j.position.toLowerCase().includes(kw)) ||
                    (j.company && j.company.toLowerCase().includes(kw)) ||
                    (j.description && j.description.toLowerCase().includes(kw))
                );
            }
            return jobs.slice(0, 20).map(job => ({
                external_id: `remoteok_${job.id}`, source: 'remoteok',
                title: job.position, company: job.company,
                location: job.location || 'Remote', job_type: 'full-time',
                remote: true, salary_min: null, salary_max: null,
                description: job.description,
                url: job.url || `https://remoteok.com/remote-jobs/${job.id}`,
                posted_date: job.date ? new Date(job.date * 1000).toISOString() : new Date().toISOString(),
                tags: job.tags || []
            }));
        } catch (e) { console.error('RemoteOK API error:', e.message); return []; }
    },

    async fetchAdzuna(keyword = 'developer', location = 'remote', country = 'us') {
        if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) return [];
        try {
            const response = await axios.get(`https://api.adzuna.com/v1/api/jobs/${country}/search/1`, {
                params: { app_id: process.env.ADZUNA_APP_ID, app_key: process.env.ADZUNA_APP_KEY,
                    what: keyword, where: location, results_per_page: 20, sort_by: 'date' }
            });
            return response.data.results.map(job => ({
                external_id: `adzuna_${job.id}`, source: 'adzuna',
                title: job.title, company: job.company.display_name,
                location: job.location.display_name,
                job_type: job.contract_time || 'full-time',
                remote: job.location.display_name.toLowerCase().includes('remote'),
                salary_min: job.salary_min, salary_max: job.salary_max,
                description: job.description, url: job.redirect_url,
                posted_date: new Date(job.created).toISOString(),
                tags: job.category ? [job.category.label] : []
            }));
        } catch (e) { console.error('Adzuna API error:', e.message); return []; }
    },

    async fetchJSearch(keyword = 'developer', location = 'remote') {
        if (!process.env.RAPIDAPI_KEY) return [];
        try {
            const response = await axios.get('https://jsearch.p.rapidapi.com/search', {
                params: { query: `${keyword} ${location}`, page: '1', num_pages: '1' },
                headers: { 'X-RapidAPI-Key': process.env.RAPIDAPI_KEY, 'X-RapidAPI-Host': 'jsearch.p.rapidapi.com' }
            });
            return response.data.data.map(job => ({
                external_id: `jsearch_${job.job_id}`, source: 'jsearch',
                title: job.job_title, company: job.employer_name,
                location: job.job_city ? `${job.job_city}, ${job.job_state || job.job_country}` : 'Remote',
                job_type: job.job_employment_type || 'full-time',
                remote: job.job_is_remote,
                salary_min: job.job_min_salary, salary_max: job.job_max_salary,
                description: job.job_description, url: job.job_apply_link,
                posted_date: new Date(job.job_posted_at_datetime_utc).toISOString(),
                tags: job.job_required_skills || []
            }));
        } catch (e) { console.error('JSearch API error:', e.message); return []; }
    },

    async fetchTheMuse(keyword = 'developer', location = 'Flexible / Remote') {
        try {
            const response = await axios.get('https://www.themuse.com/api/public/jobs', {
                params: { category: 'Software Engineering', location, page: 0, descending: true }
            });
            return response.data.results.map(job => ({
                external_id: `themuse_${job.id}`, source: 'themuse',
                title: job.name, company: job.company.name,
                location: job.locations.map(l => l.name).join(', ') || 'Remote',
                job_type: job.type || 'full-time',
                remote: job.locations.some(l => l.name.toLowerCase().includes('remote')),
                salary_min: null, salary_max: null,
                description: job.contents, url: job.refs.landing_page,
                posted_date: new Date(job.publication_date).toISOString(),
                tags: job.levels.map(l => l.name)
            }));
        } catch (e) { console.error('The Muse API error:', e.message); return []; }
    }
};

// Search jobs
router.get('/search', async (req, res) => {
    try {
        const { keyword = '', location = '', source = 'all', remote, job_type } = req.query;
        const userId = req.query.userId || 1;

        let allJobs = [];
        if (source === 'all' || source === 'remoteok') allJobs = allJobs.concat(await jobAPIs.fetchRemoteOK(keyword, location));
        if (source === 'all' || source === 'adzuna') allJobs = allJobs.concat(await jobAPIs.fetchAdzuna(keyword, location));
        if (source === 'all' || source === 'jsearch') allJobs = allJobs.concat(await jobAPIs.fetchJSearch(keyword, location));
        if (source === 'all' || source === 'themuse') allJobs = allJobs.concat(await jobAPIs.fetchTheMuse(keyword, location));

        if (remote === 'true') allJobs = allJobs.filter(j => j.remote);
        if (job_type) allJobs = allJobs.filter(j => j.job_type && j.job_type.toLowerCase().includes(job_type.toLowerCase()));

        // Save jobs to Supabase
        for (const job of allJobs) {
            try {
                const { data: savedJob } = await supabase.from('jobs').upsert({
                    external_id: job.external_id, source: job.source, title: job.title,
                    company: job.company, location: job.location, job_type: job.job_type,
                    remote: job.remote, salary_min: job.salary_min, salary_max: job.salary_max,
                    description: job.description, url: job.url, posted_date: job.posted_date, is_active: true
                }, { onConflict: 'external_id' }).select('id');

                if (savedJob && savedJob.length > 0) {
                    job.id = savedJob[0].id; // attach DB id so frontend can use it for apply
                    if (job.tags && job.tags.length > 0) {
                        for (const tag of job.tags) {
                            await supabase.from('job_skills').upsert(
                                { job_id: job.id, skill_name: tag },
                                { onConflict: 'job_id,skill_name', ignoreDuplicates: true }
                            );
                        }
                    }
                }
            } catch (dbError) {
                console.error('Error saving job:', dbError.message);
            }
        }

        await supabase.from('activity_log').insert({
            user_id: userId, activity_type: 'job_searched',
            description: `Found ${allJobs.length} jobs for "${keyword}"`,
            metadata: JSON.stringify({ keyword, location, count: allJobs.length })
        });

        res.json({ jobs: allJobs, count: allJobs.length, sources: [...new Set(allJobs.map(j => j.source))] });
    } catch (error) {
        console.error('Error searching jobs:', error);
        res.status(500).json({ error: 'Failed to search jobs' });
    }
});

// Get cached jobs
router.get('/', async (req, res) => {
    try {
        const { limit = 50, offset = 0, source, remote } = req.query;

        let query = supabase.from('jobs').select('*').eq('is_active', true);
        if (source) query = query.eq('source', source);
        if (remote === 'true') query = query.eq('remote', true);
        query = query.order('posted_date', { ascending: false }).range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

        const { data: jobs, error } = await query;
        if (error) throw error;

        res.json({ jobs: jobs || [], count: jobs ? jobs.length : 0 });
    } catch (error) {
        console.error('Error fetching jobs:', error);
        res.status(500).json({ error: 'Failed to fetch jobs' });
    }
});

// Get job by ID
router.get('/:id', async (req, res) => {
    try {
        const { data: jobs, error } = await supabase
            .from('jobs').select('*').eq('id', req.params.id).limit(1);
        if (error) throw error;
        if (!jobs || jobs.length === 0)
            return res.status(404).json({ error: 'Job not found' });

        const { data: skills } = await supabase
            .from('job_skills').select('*').eq('job_id', req.params.id);

        res.json({ job: jobs[0], skills: skills || [] });
    } catch (error) {
        console.error('Error fetching job:', error);
        res.status(500).json({ error: 'Failed to fetch job' });
    }
});

module.exports = router;
