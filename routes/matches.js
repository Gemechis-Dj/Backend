const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');

function calculateMatch(resume, resumeSkills, job, jobSkills) {
    const scores = { skill: 0, title: 0, location: 0, type: 0, description: 0 };
    const resumeSkillNames = resumeSkills.map(s => s.skill_name.toLowerCase());
    const jobSkillNames = jobSkills.map(s => s.skill_name.toLowerCase());

    if (jobSkillNames.length > 0) {
        const matching = resumeSkillNames.filter(s => jobSkillNames.some(j => j.includes(s) || s.includes(j)));
        scores.skill = (matching.length / jobSkillNames.length) * 100;
    } else { scores.skill = 50; }

    if (resume.parsed_name && job.title) {
        const titleKeywords = ['developer','engineer','designer','manager','analyst','architect','scientist'];
        const jobTitle = job.title.toLowerCase();
        const resumeTitle = resume.parsed_name.toLowerCase();
        let matchKW = 0, totalKW = 0;
        for (const kw of titleKeywords) {
            if (jobTitle.includes(kw)) { totalKW++; if (resumeTitle.includes(kw)) matchKW++; }
        }
        scores.title = totalKW > 0 ? (matchKW / totalKW) * 100 : 60;
    }

    if (job.remote || (job.location && job.location.toLowerCase().includes('remote'))) {
        scores.location = 100;
    } else if (resume.parsed_location && job.location) {
        const rl = resume.parsed_location.toLowerCase(), jl = job.location.toLowerCase();
        scores.location = (rl.includes(jl) || jl.includes(rl)) ? 100 : 30;
    } else { scores.location = 50; }

    scores.type = 70;

    if (resume.raw_text && job.description) {
        const resumeWords = new Set(resume.raw_text.toLowerCase().split(/\s+/));
        const jobWords = job.description.toLowerCase().split(/\s+/);
        const common = jobWords.filter(w => w.length > 4 && resumeWords.has(w));
        scores.description = Math.min((common.length / jobWords.length) * 200, 100);
    }

    const overall = scores.skill * 0.40 + scores.title * 0.25 + scores.location * 0.15 + scores.type * 0.10 + scores.description * 0.10;
    const matchingSkills = resumeSkillNames.filter(s => jobSkillNames.some(j => j.includes(s) || s.includes(j)));
    const missingSkills = jobSkillNames.filter(s => !resumeSkillNames.some(r => r.includes(s) || s.includes(r)));

    return {
        overall_score: Math.round(overall * 100) / 100,
        skill_score: Math.round(scores.skill * 100) / 100,
        title_score: Math.round(scores.title * 100) / 100,
        location_score: Math.round(scores.location * 100) / 100,
        type_score: Math.round(scores.type * 100) / 100,
        description_score: Math.round(scores.description * 100) / 100,
        matching_skills: matchingSkills, missing_skills: missingSkills
    };
}

// Calculate matches
router.post('/calculate', async (req, res) => {
    try {
        const { resumeId, jobIds, threshold = 70 } = req.body;
        if (!resumeId) return res.status(400).json({ error: 'resumeId is required' });

        const { data: resumes } = await supabase.from('resumes').select('*').eq('id', resumeId).limit(1);
        if (!resumes || resumes.length === 0) return res.status(404).json({ error: 'Resume not found' });
        const resume = resumes[0];

        const { data: resumeSkills } = await supabase.from('resume_skills').select('*').eq('resume_id', resumeId);

        let jobsQuery = supabase.from('jobs').select('*').eq('is_active', true);
        if (jobIds && jobIds.length > 0) jobsQuery = jobsQuery.in('id', jobIds);
        else jobsQuery = jobsQuery.order('posted_date', { ascending: false }).limit(100);
        const { data: jobs } = await jobsQuery;

        const matches = [];
        for (const job of (jobs || [])) {
            const { data: jobSkills } = await supabase.from('job_skills').select('*').eq('job_id', job.id);
            const matchResult = calculateMatch(resume, resumeSkills || [], job, jobSkills || []);

            if (matchResult.overall_score >= threshold) {
                await supabase.from('matches').upsert({
                    resume_id: resumeId, job_id: job.id,
                    overall_score: matchResult.overall_score,
                    skill_score: matchResult.skill_score,
                    title_score: matchResult.title_score,
                    location_score: matchResult.location_score,
                    type_score: matchResult.type_score,
                    description_score: matchResult.description_score,
                    matching_skills: JSON.stringify(matchResult.matching_skills),
                    missing_skills: JSON.stringify(matchResult.missing_skills)
                }, { onConflict: 'resume_id,job_id' });

                matches.push({ job, match: matchResult });
            }
        }

        matches.sort((a, b) => b.match.overall_score - a.match.overall_score);

        await supabase.from('activity_log').insert({
            user_id: resume.user_id, activity_type: 'matches_calculated',
            description: `Found ${matches.length} matches above ${threshold}%`,
            metadata: JSON.stringify({ count: matches.length, threshold })
        });

        res.json({ matches, count: matches.length, threshold });
    } catch (error) {
        console.error('Error calculating matches:', error);
        res.status(500).json({ error: 'Failed to calculate matches' });
    }
});

// Get matches for resume
router.get('/resume/:resumeId', async (req, res) => {
    try {
        const { threshold = 0, limit = 50 } = req.query;

        const { data: matches, error } = await supabase
            .from('matches')
            .select('*, jobs(*)')
            .eq('resume_id', req.params.resumeId)
            .gte('overall_score', parseFloat(threshold))
            .order('overall_score', { ascending: false })
            .limit(parseInt(limit));

        if (error) throw error;
        res.json({ matches: matches || [], count: matches ? matches.length : 0 });
    } catch (error) {
        console.error('Error fetching matches:', error);
        res.status(500).json({ error: 'Failed to fetch matches' });
    }
});

// Get match by ID
router.get('/:id', async (req, res) => {
    try {
        const { data: matches, error } = await supabase
            .from('matches').select('*, jobs(*), resumes(parsed_name)')
            .eq('id', req.params.id).limit(1);
        if (error) throw error;
        if (!matches || matches.length === 0) return res.status(404).json({ error: 'Match not found' });
        res.json(matches[0]);
    } catch (error) {
        console.error('Error fetching match:', error);
        res.status(500).json({ error: 'Failed to fetch match' });
    }
});

module.exports = router;
