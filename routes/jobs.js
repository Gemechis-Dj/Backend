const express = require('express');
const router = express.Router();
const axios = require('axios');
const { supabase } = require('../config/database');

// ─────────────────────────────────────────────────────────────────
//  HELPER: keyword relevance score (0–100) for a job object
//  Used to sort/filter results so every API response is on-keyword
// ─────────────────────────────────────────────────────────────────
function relevanceScore(job, keyword) {
    if (!keyword) return 100;
    const kw    = keyword.toLowerCase().trim();
    const terms = kw.split(/\s+/).filter(t => t.length > 1);

    const title = (job.title       || '').toLowerCase();
    const co    = (job.company     || '').toLowerCase();
    const desc  = (job.description || '').toLowerCase();
    const tags  = (job.tags        || []).join(' ').toLowerCase();

    let score = 0;
    for (const term of terms) {
        if (title.includes(term)) score += 50;
        if (co.includes(term))    score += 20;
        if (desc.includes(term))  score += 10;
        if (tags.includes(term))  score += 15;
    }
    // Extra bonus for exact phrase match in title
    if (title.includes(kw)) score += 40;
    return score;
}

// ─────────────────────────────────────────────────────────────────
//  HELPER: filter + sort an array of jobs by relevance
// ─────────────────────────────────────────────────────────────────
function filterByRelevance(jobs, keyword, minScore = 1) {
    if (!keyword) return jobs;
    return jobs
        .map(j    => ({ ...j, _score: relevanceScore(j, keyword) }))
        .filter(j => j._score >= minScore)
        .sort((a, b) => b._score - a._score);
}

// ─────────────────────────────────────────────────────────────────
//  JOB API INTEGRATIONS
// ─────────────────────────────────────────────────────────────────
const jobAPIs = {

    async fetchRemoteOK(keyword = '', location = '') {
        try {
            const response = await axios.get('https://remoteok.com/api', {
                headers: { 'User-Agent': 'JobPilot-AI/1.0' },
                timeout: 8000,
            });
            let jobs = response.data.slice(1);

            // Filter by keyword (title + company + description + tags)
            if (keyword) {
                const kw = keyword.toLowerCase();
                jobs = jobs.filter(j =>
                    (j.position    && j.position.toLowerCase().includes(kw))  ||
                    (j.company     && j.company.toLowerCase().includes(kw))   ||
                    (j.description && j.description.toLowerCase().includes(kw))||
                    (j.tags        && j.tags.some(t => t.toLowerCase().includes(kw)))
                );
            }

            // Filter by location when specified
            if (location) {
                const loc = location.toLowerCase();
                // RemoteOK is all remote, so only exclude if location explicitly conflicts
                if (!loc.includes('remote') && !loc.includes('worldwide') && !loc.includes('anywhere')) {
                    jobs = jobs.filter(j =>
                        !j.location ||
                        j.location.toLowerCase().includes(loc) ||
                        j.location.toLowerCase().includes('remote')
                    );
                }
            }

            return jobs.slice(0, 25).map(job => ({
                external_id:  `remoteok_${job.id}`,
                source:       'remoteok',
                title:         job.position,
                company:       job.company,
                location:      job.location || 'Remote',
                job_type:     'full-time',
                remote:        true,
                salary_min:    null,
                salary_max:    null,
                description:   job.description,
                url:           job.url || `https://remoteok.com/remote-jobs/${job.id}`,
                posted_date:   job.date ? new Date(job.date * 1000).toISOString() : new Date().toISOString(),
                tags:          job.tags || [],
            }));
        } catch (e) {
            console.error('RemoteOK API error:', e.message);
            return [];
        }
    },

    async fetchAdzuna(keyword = 'developer', location = 'remote', country = 'us') {
        if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY) return [];
        try {
            const response = await axios.get(
                `https://api.adzuna.com/v1/api/jobs/${country}/search/1`,
                {
                    params: {
                        app_id:           process.env.ADZUNA_APP_ID,
                        app_key:          process.env.ADZUNA_APP_KEY,
                        what:             keyword,
                        where:            location,
                        results_per_page: 20,
                        sort_by:          'date',
                    },
                    timeout: 8000,
                }
            );
            return response.data.results.map(job => ({
                external_id: `adzuna_${job.id}`,
                source:      'adzuna',
                title:        job.title,
                company:      job.company.display_name,
                location:     job.location.display_name,
                job_type:     job.contract_time || 'full-time',
                remote:       job.location.display_name.toLowerCase().includes('remote'),
                salary_min:   job.salary_min,
                salary_max:   job.salary_max,
                description:  job.description,
                url:          job.redirect_url,
                posted_date:  new Date(job.created).toISOString(),
                tags:         job.category ? [job.category.label] : [],
            }));
        } catch (e) {
            console.error('Adzuna API error:', e.message);
            return [];
        }
    },

    async fetchJSearch(keyword = 'developer', location = 'remote') {
        if (!process.env.RAPIDAPI_KEY) return [];
        try {
            const query = location
                ? `${keyword} in ${location}`
                : keyword;
            const response = await axios.get('https://jsearch.p.rapidapi.com/search', {
                params:  { query, page: '1', num_pages: '1' },
                headers: {
                    'X-RapidAPI-Key':  process.env.RAPIDAPI_KEY,
                    'X-RapidAPI-Host': 'jsearch.p.rapidapi.com',
                },
                timeout: 8000,
            });
            return response.data.data.map(job => ({
                external_id: `jsearch_${job.job_id}`,
                source:      'jsearch',
                title:        job.job_title,
                company:      job.employer_name,
                location:     job.job_city
                    ? `${job.job_city}, ${job.job_state || job.job_country}`
                    : 'Remote',
                job_type:    job.job_employment_type || 'full-time',
                remote:       job.job_is_remote,
                salary_min:   job.job_min_salary,
                salary_max:   job.job_max_salary,
                description:  job.job_description,
                url:          job.job_apply_link,
                posted_date:  new Date(job.job_posted_at_datetime_utc).toISOString(),
                tags:         job.job_required_skills || [],
            }));
        } catch (e) {
            console.error('JSearch API error:', e.message);
            return [];
        }
    },

    // ── THE MUSE FIX ────────────────────────────────────────────────
    // OLD: always fetched category="Software Engineering", ignored keyword
    // NEW: maps keyword → nearest Muse category; falls back to full-text
    //      filtering on whatever The Muse returns.
    async fetchTheMuse(keyword = '', location = '') {
        try {
            // Map common keyword patterns to Muse categories
            const CAT_MAP = [
                { test: /market|brand|content|seo|social media|copywrite/i, cat: 'Marketing & PR' },
                { test: /design|ux|ui|figma|graphic|visual/i,               cat: 'Design & UX' },
                { test: /sales|account exec|business dev|revenue/i,          cat: 'Sales' },
                { test: /data|analyst|analytics|bi |tableau|power bi/i,      cat: 'Data Science' },
                { test: /finance|accounting|cfo|controller|bookkeep/i,       cat: 'Finance' },
                { test: /hr|recruit|talent|people ops|human resource/i,      cat: 'Human Resources' },
                { test: /product manager|product owner|pm |roadmap/i,        cat: 'Product' },
                { test: /project manager|scrum|agile|pmo/i,                  cat: 'Project Management' },
                { test: /customer success|customer support|support agent/i,  cat: 'Customer Service' },
                { test: /operations|ops|supply chain|logistics/i,            cat: 'Operations' },
                { test: /legal|attorney|counsel|compliance/i,                cat: 'Legal' },
                { test: /write|editor|journalist|content creator/i,          cat: 'Writing' },
                // Default for tech-related terms
                { test: /dev|engineer|program|software|code|backend|frontend|fullstack|mobile|cloud|devops|sre|qa|test/i, cat: 'Software Engineering' },
            ];

            let category = 'Software Engineering';  // safe default
            if (keyword) {
                const match = CAT_MAP.find(m => m.test.test(keyword));
                if (match) category = match.cat;
            }

            // Build location param for The Muse
            const museLocation = location
                ? (location.toLowerCase().includes('remote') ? 'Flexible / Remote' : location)
                : 'Flexible / Remote';

            const response = await axios.get('https://www.themuse.com/api/public/jobs', {
                params: { category, location: museLocation, page: 0, descending: true },
                timeout: 8000,
            });

            let jobs = (response.data.results || []).map(job => ({
                external_id: `themuse_${job.id}`,
                source:      'themuse',
                title:        job.name,
                company:      job.company.name,
                location:     job.locations.map(l => l.name).join(', ') || 'Remote',
                job_type:    job.type || 'full-time',
                remote:       job.locations.some(l => l.name.toLowerCase().includes('remote') || l.name.toLowerCase().includes('flexible')),
                salary_min:   null,
                salary_max:   null,
                description:  job.contents,
                url:          job.refs.landing_page,
                posted_date:  new Date(job.publication_date).toISOString(),
                tags:         job.levels.map(l => l.name),
            }));

            // ── KEY FIX: filter by keyword relevance ──────────────
            // Even within the correct category, filter out jobs that don't
            // mention the keyword so results are always search-specific.
            if (keyword) {
                const scored = filterByRelevance(jobs, keyword, 1);
                // If we got relevance-matching jobs, use them; otherwise keep all
                // (so the user still sees SOMETHING from The Muse)
                jobs = scored.length > 0 ? scored : filterByRelevance(jobs, keyword, 0);
            }

            return jobs.slice(0, 20);
        } catch (e) {
            console.error('The Muse API error:', e.message);
            return [];
        }
    },
};

// ─────────────────────────────────────────────────────────────────
//  FALLBACK: search cached jobs in Supabase by keyword
//  Called when external APIs return 0 or very few results
// ─────────────────────────────────────────────────────────────────
async function searchCachedJobs(keyword, location, limit = 40) {
    try {
        let query = supabase
            .from('jobs')
            .select('*')
            .eq('is_active', true);

        // Supabase full-text search on title + description
        if (keyword) {
            // Use ilike for simple substring match on title (most reliable)
            const terms = keyword.trim().split(/\s+/).slice(0, 3);
            // Build OR filter for title containing any search term
            query = query.or(
                terms.map(t => `title.ilike.%${t}%`).join(',')
            );
        }
        if (location && !location.toLowerCase().includes('remote')) {
            query = query.ilike('location', `%${location}%`);
        }

        query = query
            .order('posted_date', { ascending: false })
            .limit(limit);

        const { data: jobs, error } = await query;
        if (error) throw error;

        // Score and sort by relevance
        const scored = filterByRelevance(jobs || [], keyword, 0);
        return scored.map(j => ({ ...j, source: j.source || 'cached' }));
    } catch (e) {
        console.error('Cached job search error:', e.message);
        return [];
    }
}

// ─────────────────────────────────────────────────────────────────
//  ROUTES
// ─────────────────────────────────────────────────────────────────

// Search jobs
router.get('/search', async (req, res) => {
    try {
        const { keyword = '', location = '', source = 'all', remote, job_type } = req.query;
        const userId = req.query.userId || 1;

        // ── Fetch from live external APIs ──────────────────────────
        let allJobs = [];
        const fetches = [];

        if (source === 'all' || source === 'remoteok')
            fetches.push(jobAPIs.fetchRemoteOK(keyword, location).then(j => allJobs.push(...j)).catch(() => {}));
        if (source === 'all' || source === 'adzuna')
            fetches.push(jobAPIs.fetchAdzuna(keyword, location).then(j => allJobs.push(...j)).catch(() => {}));
        if (source === 'all' || source === 'jsearch')
            fetches.push(jobAPIs.fetchJSearch(keyword, location).then(j => allJobs.push(...j)).catch(() => {}));
        if (source === 'all' || source === 'themuse')
            fetches.push(jobAPIs.fetchTheMuse(keyword, location).then(j => allJobs.push(...j)).catch(() => {}));

        // Run all API calls in parallel (faster, avoids one timeout blocking others)
        await Promise.allSettled(fetches);

        // ── Relevance filter + sort across ALL sources ─────────────
        // This ensures that even if one API returns off-topic results,
        // they get ranked below genuinely matching jobs.
        if (keyword && allJobs.length > 0) {
            const scored = allJobs
                .map(j    => ({ ...j, _score: relevanceScore(j, keyword) }))
                .sort((a, b) => b._score - a._score);

            // Keep ALL scored jobs (even 0-score ones) but put matching ones first.
            // This way the user always sees something, but relevant jobs appear first.
            allJobs = scored;
        }

        // ── Extra filters ──────────────────────────────────────────
        if (remote   === 'true') allJobs = allJobs.filter(j => j.remote);
        if (job_type)            allJobs = allJobs.filter(j => j.job_type && j.job_type.toLowerCase().includes(job_type.toLowerCase()));

        // ── DB fallback: if APIs returned nothing, search cached jobs
        if (allJobs.length === 0 && keyword) {
            console.log(`[jobs/search] No live results for "${keyword}", falling back to DB cache.`);
            const cached = await searchCachedJobs(keyword, location, 40);
            if (cached.length > 0) {
                allJobs = cached;
                console.log(`[jobs/search] DB fallback returned ${cached.length} cached jobs.`);
            }
        }

        // ── Persist / update jobs in Supabase ─────────────────────
        for (const job of allJobs) {
            if (!job.external_id) continue;     // skip DB-origin jobs (already stored)
            try {
                const { data: savedJob } = await supabase
                    .from('jobs')
                    .upsert({
                        external_id:  job.external_id,
                        source:       job.source,
                        title:        job.title,
                        company:      job.company,
                        location:     job.location,
                        job_type:     job.job_type,
                        remote:       job.remote,
                        salary_min:   job.salary_min,
                        salary_max:   job.salary_max,
                        description:  job.description,
                        url:          job.url,
                        posted_date:  job.posted_date,
                        is_active:    true,
                    }, { onConflict: 'external_id' })
                    .select('id');

                if (savedJob && savedJob.length > 0) {
                    job.id = savedJob[0].id;
                    if (job.tags && job.tags.length > 0) {
                        for (const tag of job.tags) {
                            await supabase.from('job_skills').upsert(
                                { job_id: job.id, skill_name: String(tag) },
                                { onConflict: 'job_id,skill_name', ignoreDuplicates: true }
                            );
                        }
                    }
                }
            } catch (dbError) {
                console.error('Error saving job:', dbError.message);
            }
        }

        // ── Activity log ───────────────────────────────────────────
        await supabase.from('activity_log').insert({
            user_id:       userId,
            activity_type: 'job_searched',
            description:   `Found ${allJobs.length} jobs for "${keyword}"`,
            metadata:      JSON.stringify({ keyword, location, count: allJobs.length }),
        }).catch(() => {});

        // Remove internal _score field before sending to client
        const cleanJobs = allJobs.map(({ _score, ...j }) => j);

        res.json({
            jobs:    cleanJobs,
            count:   cleanJobs.length,
            sources: [...new Set(cleanJobs.map(j => j.source).filter(Boolean))],
        });

    } catch (error) {
        console.error('Error searching jobs:', error);
        res.status(500).json({ error: 'Failed to search jobs' });
    }
});

// Get cached jobs (paginated, no keyword search)
router.get('/', async (req, res) => {
    try {
        const { limit = 50, offset = 0, source, remote, keyword } = req.query;

        let query = supabase.from('jobs').select('*').eq('is_active', true);
        if (source)          query = query.eq('source', source);
        if (remote === 'true') query = query.eq('remote', true);
        if (keyword) {
            const terms = keyword.trim().split(/\s+/).slice(0, 3);
            query = query.or(terms.map(t => `title.ilike.%${t}%`).join(','));
        }
        query = query
            .order('posted_date', { ascending: false })
            .range(parseInt(offset), parseInt(offset) + parseInt(limit) - 1);

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
