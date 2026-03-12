const express = require('express');
const router = express.Router();
const { supabase } = require('../config/database');

function generateCoverLetter(resume, job, match) {
    const resumeName = resume.parsed_name || 'Your Name';
    const resumeEmail = resume.parsed_email || 'your.email@example.com';
    const resumePhone = resume.parsed_phone || 'Your Phone';
    const company = job.company || 'the Company';
    const position = job.title || 'the Position';

    const matchingSkills = match && match.matching_skills ?
        (typeof match.matching_skills === 'string' ? JSON.parse(match.matching_skills) : match.matching_skills) : [];

    const skillsText = matchingSkills.length > 0 ?
        `My expertise in ${matchingSkills.slice(0, 5).join(', ')} aligns perfectly with your requirements.` :
        'My diverse skill set aligns well with your requirements.';

    return `Dear Hiring Manager,

I am writing to express my strong interest in the ${position} position at ${company}. With my background and experience, I am confident that I would be a valuable addition to your team.

${skillsText} Throughout my career, I have consistently demonstrated the ability to deliver high-quality results while working both independently and as part of collaborative teams.

What particularly excites me about this opportunity at ${company} is the chance to contribute to innovative projects and grow professionally in a dynamic environment. I am impressed by your company's commitment to excellence and would be thrilled to bring my skills and passion to your organization.

I am eager to discuss how my qualifications and enthusiasm can benefit ${company}. Thank you for considering my application. I look forward to the opportunity to speak with you about this exciting position.

Best regards,
${resumeName}
${resumeEmail}
${resumePhone}`;
}

// Generate cover letter
router.post('/generate', async (req, res) => {
    try {
        const { resumeId, jobId, applicationId } = req.body;
        if (!resumeId || !jobId) return res.status(400).json({ error: 'resumeId and jobId are required' });

        const { data: resumes } = await supabase.from('resumes').select('*').eq('id', resumeId).limit(1);
        if (!resumes || resumes.length === 0) return res.status(404).json({ error: 'Resume not found' });

        const { data: jobs } = await supabase.from('jobs').select('*').eq('id', jobId).limit(1);
        if (!jobs || jobs.length === 0) return res.status(404).json({ error: 'Job not found' });

        const { data: matches } = await supabase.from('matches').select('*')
            .eq('resume_id', resumeId).eq('job_id', jobId).limit(1);

        const coverLetterContent = generateCoverLetter(resumes[0], jobs[0], matches && matches.length > 0 ? matches[0] : null);

        let coverLetterId = null;
        if (applicationId) {
            const { data: cl, error } = await supabase.from('cover_letters')
                .insert({ application_id: applicationId, job_id: jobId, resume_id: resumeId, content: coverLetterContent })
                .select();
            if (error) throw error;
            coverLetterId = cl[0].id;

            await supabase.from('applications').update({ cover_letter_id: coverLetterId }).eq('id', applicationId);
            await supabase.from('activity_log').insert({
                user_id: resumes[0].user_id, activity_type: 'cover_letter_generated',
                description: `Cover letter generated for ${jobs[0].title} at ${jobs[0].company}`
            });
        }

        res.json({ cover_letter: coverLetterContent, id: coverLetterId, job: { title: jobs[0].title, company: jobs[0].company } });
    } catch (error) {
        console.error('Error generating cover letter:', error);
        res.status(500).json({ error: 'Failed to generate cover letter' });
    }
});

// Get cover letter by ID
router.get('/:id', async (req, res) => {
    try {
        const { data, error } = await supabase.from('cover_letters')
            .select('*, jobs(title, company)').eq('id', req.params.id).limit(1);
        if (error) throw error;
        if (!data || data.length === 0) return res.status(404).json({ error: 'Cover letter not found' });
        res.json(data[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch cover letter' });
    }
});

// Get cover letters for application
router.get('/application/:applicationId', async (req, res) => {
    try {
        const { data, error } = await supabase.from('cover_letters')
            .select('*, jobs(title, company)').eq('application_id', req.params.applicationId)
            .order('created_at', { ascending: false });
        if (error) throw error;
        res.json({ cover_letters: data || [], count: data ? data.length : 0 });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch cover letters' });
    }
});

// Update cover letter
router.put('/:id', async (req, res) => {
    try {
        const { content } = req.body;
        if (!content) return res.status(400).json({ error: 'content is required' });

        // Get current version first
        const { data: current } = await supabase.from('cover_letters').select('version').eq('id', req.params.id).limit(1);
        const newVersion = current && current.length > 0 ? (current[0].version || 1) + 1 : 2;

        const { data: updated, error } = await supabase.from('cover_letters')
            .update({ content, version: newVersion, updated_at: new Date().toISOString() })
            .eq('id', req.params.id).select();
        if (error) throw error;
        res.json(updated[0]);
    } catch (error) {
        res.status(500).json({ error: 'Failed to update cover letter' });
    }
});

// Delete cover letter
router.delete('/:id', async (req, res) => {
    try {
        const { error } = await supabase.from('cover_letters').delete().eq('id', req.params.id);
        if (error) throw error;
        res.json({ message: 'Cover letter deleted successfully' });
    } catch (error) {
        res.status(500).json({ error: 'Failed to delete cover letter' });
    }
});

module.exports = router;
