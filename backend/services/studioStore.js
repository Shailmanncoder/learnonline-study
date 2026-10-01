const db = require('../config/db');
let pending;
async function ready() {
    if (!pending) pending = (async () => {
        await db.ready();
        const text = db.dialect() === 'mysql' ? 'LONGTEXT' : 'TEXT';
        await db.run(`CREATE TABLE IF NOT EXISTS studio_packs (
            id VARCHAR(36) PRIMARY KEY, user_id INTEGER NOT NULL, class_id INTEGER,
            title VARCHAR(200) NOT NULL, meta ${text} NOT NULL, content ${text} NOT NULL,
            status VARCHAR(20) NOT NULL, version INTEGER NOT NULL DEFAULT 1,
            created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL)`);
        await db.run(`CREATE TABLE IF NOT EXISTS studio_assignments (
            pack_id VARCHAR(36) NOT NULL, student_id INTEGER NOT NULL, due_date VARCHAR(10),
            assigned_at VARCHAR(30) NOT NULL, PRIMARY KEY(pack_id, student_id))`);
        await db.run(`CREATE TABLE IF NOT EXISTS studio_attempts (
            id VARCHAR(36) PRIMARY KEY, pack_id VARCHAR(36) NOT NULL, user_id INTEGER NOT NULL,
            stage VARCHAR(20) NOT NULL, answers ${text} NOT NULL, result ${text} NOT NULL,
            created_at VARCHAR(30) NOT NULL, UNIQUE(pack_id, user_id, stage))`);
        await db.run(`CREATE TABLE IF NOT EXISTS studio_coaching (
            id VARCHAR(36) PRIMARY KEY, pack_id VARCHAR(36) NOT NULL, user_id INTEGER NOT NULL,
            kind VARCHAR(20) NOT NULL, question ${text} NOT NULL, response ${text} NOT NULL,
            feedback ${text}, teacher_feedback ${text}, reviewed_by INTEGER, created_at VARCHAR(30) NOT NULL)`);
        await db.run(`CREATE TABLE IF NOT EXISTS studio_sources (
            resource_id VARCHAR(36) PRIMARY KEY, status VARCHAR(20) NOT NULL, pages ${text} NOT NULL,
            warning VARCHAR(1000) NOT NULL, version INTEGER NOT NULL DEFAULT 1, updated_at VARCHAR(30) NOT NULL)`);
        await db.run(`CREATE TABLE IF NOT EXISTS studio_usage (
            user_id INTEGER NOT NULL, day VARCHAR(10) NOT NULL, calls INTEGER NOT NULL,
            PRIMARY KEY(user_id, day))`);
        await db.run(`CREATE TABLE IF NOT EXISTS studio_roadmaps (
            id VARCHAR(36) PRIMARY KEY, user_id INTEGER NOT NULL, plan ${text} NOT NULL,
            status VARCHAR(20) NOT NULL, error VARCHAR(1000) NOT NULL DEFAULT '',
            version INTEGER NOT NULL DEFAULT 1, lease_until VARCHAR(30), lease_token VARCHAR(36),
            created_at VARCHAR(30) NOT NULL, updated_at VARCHAR(30) NOT NULL)`);
    })().catch(e => { pending = null; throw e; });
    return pending;
}
function fail(status, message) { throw Object.assign(new Error(message), { status }); }
const now = () => new Date().toISOString();
const lock = () => db.dialect() === 'mysql' ? ' FOR UPDATE' : '';
async function teacher(userId, classId) {
    const c = await db.get(`SELECT c.* FROM classrooms c JOIN teacher_classes t ON t.class_id=c.id
        JOIN users u ON u.id=t.teacher_id WHERE c.id=? AND t.teacher_id=? AND c.status='active'
        AND u.role IN ('teacher','admin') AND (t.status IS NULL OR t.status='active')`, [classId, userId]);
    if (!c) fail(403, 'Choose an active classroom you teach.');
    return c;
}
async function quota(userId) {
    await ready();
    await db.transaction(async () => {
        if (!await db.get('SELECT id FROM users WHERE id=?'+lock(), [userId])) fail(401, 'Please sign in again.');
        const day = now().slice(0,10);
        const u = await db.get('SELECT calls FROM studio_usage WHERE user_id=? AND day=?', [userId,day]);
        if (u?.calls >= 40) fail(429, 'Today’s 40 AI studio requests are used. Saved lessons, labs and assessments remain available.');
        if (u) await db.run('UPDATE studio_usage SET calls=calls+1 WHERE user_id=? AND day=?', [userId,day]);
        else await db.run('INSERT INTO studio_usage VALUES (?,?,1)', [userId,day]);
    });
}
async function accessible(userId, id, edit=false) {
    const p = await db.get('SELECT * FROM studio_packs WHERE id=?', [id]);
    if (!p) fail(404, 'Study pack not found.');
    if (p.class_id && p.user_id === userId) await teacher(userId,p.class_id);
    else if (p.user_id !== userId) {
        if (edit || p.status !== 'published' || !p.class_id) fail(404,'Study pack not found.');
        const assigned = await db.get(`SELECT a.pack_id FROM studio_assignments a
            JOIN class_enrollments e ON e.student_id=a.student_id AND e.class_id=?
            JOIN classrooms c ON c.id=e.class_id WHERE a.pack_id=? AND a.student_id=?
            AND e.status='active' AND c.status='active'`, [p.class_id,id,userId]);
        if (!assigned) fail(404,'Study pack not found.');
    }
    return {...p, meta:JSON.parse(p.meta), content:JSON.parse(p.content)};
}
async function audit(userId, action, id) {
    await db.run('INSERT INTO audit_logs (actor_id,action,entity_type,entity_id,metadata) VALUES (?,?,?,?,?)',
        [userId,action,'study_studio',null,JSON.stringify({id})]);
}
module.exports={ready,db,fail,now,lock,teacher,quota,accessible,audit};
