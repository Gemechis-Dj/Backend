const express = require('express');
const router = express.Router();
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
const { supabase } = require('../config/database');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024 } });

async function extractPdfText(buffer) {
    const data = await pdfParse(buffer);
    return data.text;
}
async function extractDocxText(buffer) {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
}

function parseResume(text) {
    const parsed = { name: null, email: null, phone: null, location: null, skills: [] };
    const emailMatch = text.match(/[\w.-]+@[\w.-]+\.\w+/);
    if (emailMatch) parsed.email = emailMatch[0];
    const phoneMatch = text.match(/(\+?\d{1,3}[-.\ ]?)?\(?\d{3}\)?[-.\ ]?\d{3}[-.\ ]?\d{4}/);
    if (phoneMatch) parsed.phone = phoneMatch[0];
    const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    for (const line of lines.slice(0, 5)) {
        if (line.length < 50 && !line.includes('@') && !line.match(/\d{3}/)) { parsed.name = line; break; }
    }
    const skillKeywords = ['JavaScript','Python','Java','C++','C#','Ruby','PHP','Swift','Kotlin','Go','Rust',
        'React','Angular','Vue','Node.js','Express','Django','Flask','Spring','Laravel',
        'HTML','CSS','TypeScript','SQL','MongoDB','PostgreSQL','MySQL','Redis',
        'AWS','Azure','GCP','Docker','Kubernetes','Git','CI/CD','Agile','Scrum',
        'Machine Learning','AI','Data Science','DevOps','UI/UX','REST API','GraphQL'];
    const textLower = text.toLowerCase();
    for (const skill of skillKeywords) {
        if (textLower.includes(skill.toLowerCase())) parsed.skills.push(skill);
    }
    return parsed;
}

// Upload resume
router.post('/upload', upload.single('resume'), async (req, res) => {
    try {
        if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
        const userId = req.body.userId || 1;
        let text = '';

        if (req.file.mimetype === 'application/pdf') text = await extractPdfText(req.file.buffer);
        else if (req.file.mimetype === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document')
            text = await extractDocxText(req.file.buffer);
        else if (req.file.mimetype === 'text/plain') text = req.file.buffer.toString('utf-8');
        else return res.status(400).json({ error: 'Unsupported file type. Please upload PDF, DOCX, or TXT.' });

        const parsed = parseResume(text);

        const { data: newResumes, error } = await supabase.from('resumes')
            .insert({ user_id: userId, raw_text: text, parsed_name: parsed.name,
                parsed_email: parsed.email, parsed_phone: parsed.phone })
            .select();
        if (error) throw error;

        const resumeId = newResumes[0].id;

        if (parsed.skills.length > 0) {
            await supabase.from('resume_skills').insert(
                parsed.skills.map(skill => ({ resume_id: resumeId, skill_name: skill }))
            );
        }

        await supabase.from('activity_log').insert({
            user_id: userId, activity_type: 'resume_uploaded', description: 'Resume uploaded and parsed successfully'
        });

        const { data: skills } = await supabase.from('resume_skills').select('*').eq('resume_id', resumeId);

        res.json({ resume: newResumes[0], skills: skills || [], parsed });
    } catch (error) {
        console.error('Error uploading resume:', error);
        res.status(500).json({ error: error.message || 'Failed to upload resume' });
    }
});

// Get resume by user ID
router.get('/user/:userId', async (req, res) => {
    try {
        const { data: resumes, error } = await supabase.from('resumes').select('*')
            .eq('user_id', req.params.userId).order('created_at', { ascending: false }).limit(1);
        if (error) throw error;
        if (!resumes || resumes.length === 0) return res.json({ resume: null, skills: [] });

        const { data: skills } = await supabase.from('resume_skills').select('*').eq('resume_id', resumes[0].id);
        res.json({ resume: resumes[0], skills: skills || [] });
    } catch (error) {
        console.error('Error fetching resume:', error);
        res.status(500).json({ error: 'Failed to fetch resume' });
    }
});

// Update resume
router.put('/:id', async (req, res) => {
    try {
        const { parsed_name, parsed_email, parsed_phone, parsed_location, summary, skills } = req.body;

        const { error } = await supabase.from('resumes').update({
            parsed_name, parsed_email, parsed_phone, parsed_location, summary,
            updated_at: new Date().toISOString()
        }).eq('id', req.params.id);
        if (error) throw error;

        if (skills && Array.isArray(skills)) {
            await supabase.from('resume_skills').delete().eq('resume_id', req.params.id);
            if (skills.length > 0) {
                await supabase.from('resume_skills').insert(
                    skills.map(skill => ({ resume_id: parseInt(req.params.id), skill_name: skill }))
                );
            }
        }

        const { data: updated } = await supabase.from('resumes').select('*').eq('id', req.params.id).limit(1);
        const { data: updatedSkills } = await supabase.from('resume_skills').select('*').eq('resume_id', req.params.id);

        res.json({ resume: updated[0], skills: updatedSkills || [] });
    } catch (error) {
        console.error('Error updating resume:', error);
        res.status(500).json({ error: 'Failed to update resume' });
    }
});

module.exports = router;
