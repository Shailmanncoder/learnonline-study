// Tests never connect to a developer's database or use provider credentials.
const { mkdtempSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomBytes } = require('node:crypto');
const dir = mkdtempSync(join(tmpdir(), 'studyhub-tests-'));
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = join(dir, 'test.db');
process.env.JWT_SECRET = randomBytes(32).toString('hex');
for (const key of ['NCERT_PG_URL', 'GROQ_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'OPENAI_API_KEY', 'SARVAM_API_KEY']) process.env[key] = '';
process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
