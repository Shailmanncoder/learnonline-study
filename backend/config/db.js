const mysql = require('mysql2/promise');
const sqlite3 = require('sqlite3');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const DB_HOST = process.env.DB_HOST || 'localhost';
const DB_PORT = parseInt(process.env.DB_PORT || '3306', 10);
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'studyhub';

console.log('==========================================');
console.log('[DB CONFIG] Configured MySQL connection:');
console.log('  Host:    ', DB_HOST);
console.log('  Port:    ', DB_PORT);
console.log('  User:    ', DB_USER);
console.log('  Database:', DB_NAME);

console.log('==========================================');

const { getDatabaseMode, initializeDatabase } = require('./databaseMode');
const dialect = getDatabaseMode();
let pool = null;
let sqliteDb = null;

// Translate MySQL-specific syntax to SQLite when running in fallback mode.
function translateForSqlite(sql) {
    let s = sql;
    s = s.replace(/INSERT IGNORE\b/gi, 'INSERT OR IGNORE');
    s = s.replace(
        /ON DUPLICATE KEY UPDATE\s+([\s\S]*?)(?=\s*$)/i,
        (_, assigns) => {
            const newAssigns = assigns
                .split(',')
                .map(a => a.replace(/VALUES\s*\(\s*([`"]?)(\w+)\1\s*\)/gi, 'excluded.$2').trim())
                .join(', ');
            return `ON CONFLICT(user_id) DO UPDATE SET ${newAssigns}`;
        }
    );
    return s;
}

function runSqlite(sql, params, mode) {
    return new Promise((resolve, reject) => {
        const translated = translateForSqlite(sql);
        if (mode === 'get') {
            sqliteDb.get(translated, params, (err, row) => err ? reject(err) : resolve(row));
        } else if (mode === 'all') {
            sqliteDb.all(translated, params, (err, rows) => err ? reject(err) : resolve(rows || []));
        } else {
            sqliteDb.run(translated, params, function (err) {
                if (err) return reject(err);
                resolve({ lastID: this.lastID, changes: this.changes });
            });
        }
    });
}

async function initMysql() {
    const conn = await mysql.createConnection({
        host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
        connectTimeout: 3000
    });
    await conn.query(
        `CREATE DATABASE IF NOT EXISTS \`${DB_NAME}\` ` +
        `DEFAULT CHARACTER SET utf8mb4 DEFAULT COLLATE utf8mb4_unicode_ci`
    );
    await conn.end();

    pool = mysql.createPool({
        host: DB_HOST, port: DB_PORT, user: DB_USER, password: DB_PASSWORD,
        database: DB_NAME, waitForConnections: true, connectionLimit: 10,
        queueLimit: 0, dateStrings: true, connectTimeout: 3000
    });

    await pool.query(`CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        xp INT DEFAULT 0,
        level INT DEFAULT 1,
        time_spent INT DEFAULT 0,
        profile_picture TEXT DEFAULT NULL,
        bio TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        content TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS activity (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        tool_used VARCHAR(100) NOT NULL,
        time_spent INT DEFAULT 0,
        xp_earned INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);



    await pool.query(`CREATE TABLE IF NOT EXISTS classrooms (
        id INT AUTO_INCREMENT PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        grade VARCHAR(50),
        section VARCHAR(50) NOT NULL,
        subject VARCHAR(100) DEFAULT 'All Subjects',
        academic_year VARCHAR(50) DEFAULT '2026-27',
        class_code VARCHAR(20) NOT NULL UNIQUE,
        description TEXT,
        created_by INT NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS teacher_classes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_id INT NOT NULL,
        teacher_id INT NOT NULL,
        subject VARCHAR(100) DEFAULT 'General',
        role VARCHAR(30) DEFAULT 'class_teacher',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_teacher_class (class_id, teacher_id),
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS class_enrollments (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_id INT NOT NULL,
        student_id INT NOT NULL,
        status VARCHAR(20) DEFAULT 'active',
        joined_via VARCHAR(30) DEFAULT 'class_code',
        joined_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        removed_at DATETIME DEFAULT NULL,
        removed_by INT DEFAULT NULL,
        UNIQUE KEY uniq_student_enrollment (class_id, student_id),
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS class_student_restrictions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_id INT NOT NULL,
        student_id INT NOT NULL,
        type VARCHAR(30) DEFAULT 'blocked',
        reason TEXT,
        created_by INT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_student_restriction (class_id, student_id),
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS class_announcements (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_id INT NOT NULL,
        teacher_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        priority VARCHAR(20) DEFAULT 'normal',
        attachments TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS class_homework (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_id INT NOT NULL,
        teacher_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        subject VARCHAR(100) NOT NULL,
        instructions TEXT,
        due_date VARCHAR(50),
        due_time VARCHAR(20),
        max_marks INT DEFAULT 100,
        attachments TEXT,
        status VARCHAR(20) DEFAULT 'assigned',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS homework_submissions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        homework_id INT NOT NULL,
        student_id INT NOT NULL,
        content TEXT,
        attachments TEXT,
        status VARCHAR(30) DEFAULT 'submitted',
        marks INT DEFAULT NULL,
        feedback TEXT,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        graded_at DATETIME DEFAULT NULL,
        graded_by INT DEFAULT NULL,
        UNIQUE KEY uniq_hw_student (homework_id, student_id),
        FOREIGN KEY (homework_id) REFERENCES class_homework(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS class_notes (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_id INT NOT NULL,
        teacher_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        subject VARCHAR(100) NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT,
        status VARCHAR(20) DEFAULT 'published',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS class_worksheets (
        id INT AUTO_INCREMENT PRIMARY KEY,
        class_id INT NOT NULL,
        teacher_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        subject VARCHAR(100) NOT NULL,
        description TEXT,
        topic VARCHAR(255),
        difficulty VARCHAR(50) DEFAULT 'Medium',
        worksheet_data TEXT NOT NULL,
        total_marks INT DEFAULT 20,
        duration INT DEFAULT 30,
        status VARCHAR(20) DEFAULT 'published',
        published_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS worksheet_attempts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        worksheet_id INT NOT NULL,
        student_id INT NOT NULL,
        answers TEXT,
        score INT DEFAULT 0,
        total_marks INT DEFAULT 0,
        status VARCHAR(30) DEFAULT 'completed',
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (worksheet_id) REFERENCES class_worksheets(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        type VARCHAR(50) NOT NULL,
        title VARCHAR(255) NOT NULL,
        message TEXT NOT NULL,
        reference_type VARCHAR(50),
        reference_id INT,
        is_read INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS audit_logs (
        id INT AUTO_INCREMENT PRIMARY KEY,
        actor_id INT NOT NULL,
        action VARCHAR(100) NOT NULL,
        entity_type VARCHAR(50) NOT NULL,
        entity_id INT,
        metadata TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB`);

    // ── Flashcards (spaced repetition, SM-2) ──
    await pool.query(`CREATE TABLE IF NOT EXISTS flashcard_decks (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(255) NOT NULL,
        source_type VARCHAR(30) DEFAULT 'manual',
        card_count INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    await pool.query(`CREATE TABLE IF NOT EXISTS flashcards (
        id INT AUTO_INCREMENT PRIMARY KEY,
        deck_id INT NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        ease_factor FLOAT DEFAULT 2.5,
        interval_days FLOAT DEFAULT 0,
        repetitions INT DEFAULT 0,
        due_date DATETIME DEFAULT CURRENT_TIMESTAMP,
        last_reviewed_at DATETIME DEFAULT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (deck_id) REFERENCES flashcard_decks(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    // ── AI Quiz Generator ──
    await pool.query(`CREATE TABLE IF NOT EXISTS quiz_attempts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        topic VARCHAR(255),
        questions_json LONGTEXT NOT NULL,
        answers_json LONGTEXT,
        score INT DEFAULT 0,
        total INT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    // ── Achievement badges ──
    await pool.query(`CREATE TABLE IF NOT EXISTS user_badges (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        badge_key VARCHAR(50) NOT NULL,
        earned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_badge (user_id, badge_key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    const ensureColumn = async (table, column, definition) => {
        try {
            await pool.query(`ALTER TABLE \`${table}\` ADD COLUMN \`${column}\` ${definition}`);
            console.log(`[DB] Added missing column ${table}.${column}`);
        } catch (err) {
            if (err.code !== 'ER_DUP_FIELDNAME') {
                console.warn(`[DB] Could not add column ${table}.${column}:`, err.message);
            }
        }
    };

    const requiredUserColumns = [
        ['role', "VARCHAR(20) DEFAULT 'student'"],
        ['xp', 'INT DEFAULT 0'],
        ['level', 'INT DEFAULT 1'],
        ['time_spent', 'INT DEFAULT 0'],
        ['profile_picture', 'TEXT DEFAULT NULL'],
        ['bio', 'TEXT'],
        ['created_at', 'DATETIME DEFAULT CURRENT_TIMESTAMP'],
        ['streak_freezes', 'INT DEFAULT 1'],
        ['last_freeze_used_at', 'DATETIME DEFAULT NULL']
    ];
    for (const [col, def] of requiredUserColumns) {
        await ensureColumn('users', col, def);
    }

    await ensureColumn('worksheet_attempts', 'breakdown', 'TEXT DEFAULT NULL');

    await pool.query(`CREATE TABLE IF NOT EXISTS chat_threads (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        title VARCHAR(160) DEFAULT 'New chat',
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_threads_user (user_id, updated_at),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages (
        id INT AUTO_INCREMENT PRIMARY KEY,
        thread_id INT NOT NULL,
        user_id INT NOT NULL,
        role VARCHAR(16) NOT NULL,
        content MEDIUMTEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        INDEX idx_messages_thread (thread_id),
        FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    // The interactive card a reply carried (worksheet, quiz, source cards), so
    // reopening a chat brings the card back instead of only its caption.
    await ensureColumn('chat_messages', 'attachments', 'MEDIUMTEXT DEFAULT NULL');
    await pool.query(`CREATE TABLE IF NOT EXISTS user_memory (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        mem_key VARCHAR(80) NOT NULL,
        mem_value TEXT NOT NULL,
        source VARCHAR(32) DEFAULT 'chat',
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_mem (user_id, mem_key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);

    // ── Classroom integrity tables (see initSqlite for what each one is for) ──
    await pool.query(`CREATE TABLE IF NOT EXISTS study_quizzes (
        id VARCHAR(36) PRIMARY KEY,
        user_id INT NOT NULL,
        topic VARCHAR(255),
        questions MEDIUMTEXT NOT NULL,
        total INT NOT NULL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE IF NOT EXISTS reward_grants (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        reward_key VARCHAR(190) NOT NULL,
        xp INT NOT NULL DEFAULT 0,
        reason VARCHAR(255),
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_user_reward (user_id, reward_key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE IF NOT EXISTS homework_submission_revisions (
        id INT AUTO_INCREMENT PRIMARY KEY,
        submission_id INT NOT NULL,
        homework_id INT NOT NULL,
        student_id INT NOT NULL,
        revision INT NOT NULL,
        content MEDIUMTEXT,
        attachments TEXT,
        status VARCHAR(20) DEFAULT 'submitted',
        marks DECIMAL(7,2) DEFAULT NULL,
        feedback TEXT,
        graded_by INT DEFAULT NULL,
        graded_at DATETIME DEFAULT NULL,
        submitted_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY uniq_submission_revision (submission_id, revision),
        FOREIGN KEY (submission_id) REFERENCES homework_submissions(id) ON DELETE CASCADE
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE IF NOT EXISTS grade_reviews (
        id INT AUTO_INCREMENT PRIMARY KEY,
        subject_type VARCHAR(20) NOT NULL,
        subject_id INT NOT NULL,
        class_id INT,
        student_id INT NOT NULL,
        reason TEXT,
        status VARCHAR(20) DEFAULT 'open',
        previous_score DECIMAL(7,2) DEFAULT NULL,
        new_score DECIMAL(7,2) DEFAULT NULL,
        reviewer_id INT DEFAULT NULL,
        resolution_note TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        resolved_at DATETIME DEFAULT NULL,
        KEY idx_grade_reviews_open (status, class_id)
    ) ENGINE=InnoDB`);
    await pool.query(`CREATE TABLE IF NOT EXISTS class_join_attempts (
        id INT AUTO_INCREMENT PRIMARY KEY,
        user_id INT NOT NULL,
        succeeded TINYINT DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        KEY idx_join_attempts (user_id, created_at)
    ) ENGINE=InnoDB`);

    await ensureColumn('worksheet_attempts', 'submission_key', 'VARCHAR(80) DEFAULT NULL');
    await ensureColumn('worksheet_attempts', 'grading_status', `VARCHAR(20) DEFAULT 'graded'`);
    await ensureColumn('worksheet_attempts', 'graded_kind', 'VARCHAR(20) DEFAULT NULL');
    await ensureColumn('worksheet_attempts', 'attempt_no', 'INT DEFAULT 1');
    await ensureColumn('teacher_classes', 'status', `VARCHAR(20) DEFAULT 'active'`);
    await ensureColumn('teacher_classes', 'approved_by', 'INT DEFAULT NULL');
    await ensureColumn('teacher_classes', 'requested_at', 'DATETIME DEFAULT NULL');
    await ensureColumn('homework_submissions', 'revision', 'INT DEFAULT 1');
    await ensureColumn('homework_submissions', 'graded_revision', 'INT DEFAULT NULL');
    await ensureColumn('class_worksheets', 'opens_at', 'DATETIME DEFAULT NULL');
    await ensureColumn('class_worksheets', 'closes_at', 'DATETIME DEFAULT NULL');
    await ensureColumn('class_worksheets', 'max_attempts', 'INT DEFAULT NULL');
    // MySQL has no CREATE INDEX IF NOT EXISTS; a repeat run is a duplicate-name
    // error, which is the success case on every deploy after the first.
    try {
        await pool.query(`CREATE UNIQUE INDEX uniq_worksheet_submission_key
            ON worksheet_attempts(worksheet_id, student_id, submission_key)`);
    } catch (err) {
        if (err.code !== 'ER_DUP_KEYNAME') {
            console.warn('[DB] Could not add uniq_worksheet_submission_key:', err.message);
        }
    }

    console.log(`[DB] Connected to MySQL ${DB_HOST}:${DB_PORT}/${DB_NAME}`);
}

async function initSqlite() {
    const dir = path.join(__dirname, '..', 'database');
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const dbPath = process.env.SQLITE_PATH || path.join(dir, 'studyhub.db');

    await new Promise((resolve, reject) => {
        sqliteDb = new sqlite3.Database(dbPath, (err) => err ? reject(err) : resolve());
    });

    const exec = (sql) => new Promise((resolve, reject) => {
        sqliteDb.exec(sql, (err) => err ? reject(err) : resolve());
    });

    await exec(`CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT UNIQUE NOT NULL,
        password TEXT NOT NULL,
        xp INTEGER DEFAULT 0,
        level INTEGER DEFAULT 1,
        time_spent INTEGER DEFAULT 0,
        profile_picture TEXT DEFAULT NULL,
        bio TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS activity (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        tool_used TEXT NOT NULL,
        time_spent INTEGER DEFAULT 0,
        xp_earned INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);



    await exec(`CREATE TABLE IF NOT EXISTS classrooms (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        grade TEXT,
        section TEXT NOT NULL,
        subject TEXT DEFAULT 'All Subjects',
        academic_year TEXT DEFAULT '2026-27',
        class_code TEXT NOT NULL UNIQUE,
        description TEXT,
        created_by INTEGER NOT NULL,
        status TEXT DEFAULT 'active',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS teacher_classes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        teacher_id INTEGER NOT NULL,
        subject TEXT DEFAULT 'General',
        role TEXT DEFAULT 'class_teacher',
        joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (class_id, teacher_id),
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS class_enrollments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        status TEXT DEFAULT 'active',
        joined_via TEXT DEFAULT 'class_code',
        joined_at TEXT DEFAULT CURRENT_TIMESTAMP,
        removed_at TEXT DEFAULT NULL,
        removed_by INTEGER DEFAULT NULL,
        UNIQUE (class_id, student_id),
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS class_student_restrictions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        type TEXT DEFAULT 'blocked',
        reason TEXT,
        created_by INTEGER NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (class_id, student_id),
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS class_announcements (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        priority TEXT DEFAULT 'normal',
        attachments TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS class_homework (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        subject TEXT NOT NULL,
        instructions TEXT,
        due_date TEXT,
        due_time TEXT,
        max_marks INTEGER DEFAULT 100,
        attachments TEXT,
        status TEXT DEFAULT 'assigned',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS homework_submissions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        homework_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        content TEXT,
        attachments TEXT,
        status TEXT DEFAULT 'submitted',
        marks INTEGER DEFAULT NULL,
        feedback TEXT,
        submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
        graded_at TEXT DEFAULT NULL,
        graded_by INTEGER DEFAULT NULL,
        UNIQUE (homework_id, student_id),
        FOREIGN KEY (homework_id) REFERENCES class_homework(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS class_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        subject TEXT NOT NULL,
        content TEXT NOT NULL,
        attachments TEXT,
        status TEXT DEFAULT 'published',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS class_worksheets (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        class_id INTEGER NOT NULL,
        teacher_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        subject TEXT NOT NULL,
        description TEXT,
        topic TEXT,
        difficulty TEXT DEFAULT 'Medium',
        worksheet_data TEXT NOT NULL,
        total_marks INTEGER DEFAULT 20,
        duration INTEGER DEFAULT 30,
        status TEXT DEFAULT 'published',
        published_at TEXT DEFAULT CURRENT_TIMESTAMP,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (class_id) REFERENCES classrooms(id) ON DELETE CASCADE,
        FOREIGN KEY (teacher_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS worksheet_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        worksheet_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        answers TEXT,
        score INTEGER DEFAULT 0,
        total_marks INTEGER DEFAULT 0,
        status TEXT DEFAULT 'completed',
        started_at TEXT DEFAULT CURRENT_TIMESTAMP,
        submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (worksheet_id) REFERENCES class_worksheets(id) ON DELETE CASCADE,
        FOREIGN KEY (student_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        type TEXT NOT NULL,
        title TEXT NOT NULL,
        message TEXT NOT NULL,
        reference_type TEXT,
        reference_id INTEGER,
        is_read INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        entity_id INTEGER,
        metadata TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);

    // ── Flashcards (spaced repetition, SM-2) ──
    await exec(`CREATE TABLE IF NOT EXISTS flashcard_decks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        source_type TEXT DEFAULT 'manual',
        card_count INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    await exec(`CREATE TABLE IF NOT EXISTS flashcards (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        deck_id INTEGER NOT NULL,
        question TEXT NOT NULL,
        answer TEXT NOT NULL,
        ease_factor REAL DEFAULT 2.5,
        interval_days REAL DEFAULT 0,
        repetitions INTEGER DEFAULT 0,
        due_date TEXT DEFAULT CURRENT_TIMESTAMP,
        last_reviewed_at TEXT DEFAULT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (deck_id) REFERENCES flashcard_decks(id) ON DELETE CASCADE
    )`);

    // ── AI Quiz Generator ──
    await exec(`CREATE TABLE IF NOT EXISTS quiz_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        topic TEXT,
        questions_json TEXT NOT NULL,
        answers_json TEXT,
        score INTEGER DEFAULT 0,
        total INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    // ── Achievement badges ──
    await exec(`CREATE TABLE IF NOT EXISTS user_badges (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        badge_key TEXT NOT NULL,
        earned_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, badge_key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);

    try {
        await exec(`ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'student'`);
    } catch (ignore) {}
    try {
        await exec(`ALTER TABLE users ADD COLUMN streak_freezes INTEGER DEFAULT 1`);
    } catch (ignore) {}
    try {
        await exec(`ALTER TABLE users ADD COLUMN last_freeze_used_at TEXT DEFAULT NULL`);
    } catch (ignore) {}
    // Per-question grading result, so item analysis doesn't have to re-derive
    // scores and subjective feedback can be stored alongside the answer.
    try {
        await exec(`ALTER TABLE worksheet_attempts ADD COLUMN breakdown TEXT DEFAULT NULL`);
    } catch (ignore) {}

    // ── AI Companion memory ──
    await exec(`CREATE TABLE IF NOT EXISTS chat_threads (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        title TEXT DEFAULT 'New chat',
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    await exec(`CREATE TABLE IF NOT EXISTS chat_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (thread_id) REFERENCES chat_threads(id) ON DELETE CASCADE
    )`);
    // The interactive card a reply carried (worksheet, quiz, source cards), so
    // reopening a chat brings the card back instead of only its caption.
    try {
        await exec(`ALTER TABLE chat_messages ADD COLUMN attachments TEXT DEFAULT NULL`);
    } catch (ignore) {}
    // Durable facts the tutor should remember across every conversation.
    await exec(`CREATE TABLE IF NOT EXISTS user_memory (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        mem_key TEXT NOT NULL,
        mem_value TEXT NOT NULL,
        source TEXT DEFAULT 'chat',
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, mem_key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    // ── Classroom integrity tables ─────────────────────────────────
    // Practice quizzes keep their question set and answer key here, so the
    // browser submits a quiz id and answers rather than its own marking scheme.
    await exec(`CREATE TABLE IF NOT EXISTS study_quizzes (
        id TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        topic TEXT,
        questions TEXT NOT NULL,
        total INTEGER NOT NULL DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    // One XP grant per (user, reward_key). Retries, resubmissions and regrades
    // reuse the key, so the unique constraint — not a code path — is what stops
    // the same completion being paid twice.
    await exec(`CREATE TABLE IF NOT EXISTS reward_grants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        reward_key TEXT NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0,
        reason TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (user_id, reward_key),
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    )`);
    // Each homework version is kept, so a teacher's feedback stays attached to
    // the answer it was written against.
    await exec(`CREATE TABLE IF NOT EXISTS homework_submission_revisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        submission_id INTEGER NOT NULL,
        homework_id INTEGER NOT NULL,
        student_id INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        content TEXT,
        attachments TEXT,
        status TEXT DEFAULT 'submitted',
        marks REAL DEFAULT NULL,
        feedback TEXT,
        graded_by INTEGER DEFAULT NULL,
        graded_at TEXT DEFAULT NULL,
        submitted_at TEXT DEFAULT CURRENT_TIMESTAMP,
        UNIQUE (submission_id, revision),
        FOREIGN KEY (submission_id) REFERENCES homework_submissions(id) ON DELETE CASCADE
    )`);
    // A student can contest a result; an authorised teacher resolves it. The
    // previous and new score are both kept.
    await exec(`CREATE TABLE IF NOT EXISTS grade_reviews (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        subject_type TEXT NOT NULL,
        subject_id INTEGER NOT NULL,
        class_id INTEGER,
        student_id INTEGER NOT NULL,
        reason TEXT,
        status TEXT DEFAULT 'open',
        previous_score REAL DEFAULT NULL,
        new_score REAL DEFAULT NULL,
        reviewer_id INTEGER DEFAULT NULL,
        resolution_note TEXT,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        resolved_at TEXT DEFAULT NULL
    )`);
    // Failed class-code guesses, for rate limiting only.
    await exec(`CREATE TABLE IF NOT EXISTS class_join_attempts (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        succeeded INTEGER DEFAULT 0,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_join_attempts ON class_join_attempts(user_id, created_at)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_grade_reviews_open ON grade_reviews(status, class_id)`);

    // Additive columns. Existing rows keep working: a NULL submission_key marks
    // a pre-idempotency attempt, and grading_status defaults to the old
    // behaviour of "this score is final".
    for (const [table, column, definition] of [
        ['worksheet_attempts', 'submission_key', `TEXT DEFAULT NULL`],
        ['worksheet_attempts', 'grading_status', `TEXT DEFAULT 'graded'`],
        ['worksheet_attempts', 'graded_kind', `TEXT DEFAULT NULL`],
        ['worksheet_attempts', 'attempt_no', `INTEGER DEFAULT 1`],
        ['teacher_classes', 'status', `TEXT DEFAULT 'active'`],
        ['teacher_classes', 'approved_by', `INTEGER DEFAULT NULL`],
        ['teacher_classes', 'requested_at', `TEXT DEFAULT NULL`],
        ['homework_submissions', 'revision', `INTEGER DEFAULT 1`],
        ['homework_submissions', 'graded_revision', `INTEGER DEFAULT NULL`],
        ['class_worksheets', 'opens_at', `TEXT DEFAULT NULL`],
        ['class_worksheets', 'closes_at', `TEXT DEFAULT NULL`],
        ['class_worksheets', 'max_attempts', `INTEGER DEFAULT NULL`]
    ]) {
        try { await exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`); } catch (ignore) {}
    }
    // NULL submission_key rows stay distinct under this index on both engines,
    // so historical attempts are never collapsed together.
    await exec(`CREATE UNIQUE INDEX IF NOT EXISTS uniq_worksheet_submission_key
        ON worksheet_attempts(worksheet_id, student_id, submission_key)`);

    await exec(`CREATE INDEX IF NOT EXISTS idx_chat_messages_thread ON chat_messages(thread_id)`);
    await exec(`CREATE INDEX IF NOT EXISTS idx_chat_threads_user ON chat_threads(user_id, updated_at)`);

    console.log(`[DB] Connected to SQLite ${dbPath}`);
}

async function init() {
    await initializeDatabase(dialect, { mysql: initMysql, sqlite: initSqlite });
}

const readyPromise = init().catch(err => {
    console.error('[DB] Initialization failed:', err.message);
    throw err;
});

// A transaction owns one MySQL connection, so its statements cannot be spread
// across the pool. SQLite has a single connection, so its work is serialized
// instead: without that, an unrelated request's INSERT lands between another
// request's BEGIN and COMMIT and is rolled back with it.
const { AsyncLocalStorage } = require('node:async_hooks');
const transactionContext = new AsyncLocalStorage();
let sqliteQueue = Promise.resolve();
function serialized(work) {
    const result = sqliteQueue.then(work, work);
    sqliteQueue = result.catch(() => {});
    return result;
}

async function query(mode, sql, params = []) {
    await readyPromise;
    const context = transactionContext.getStore();
    if (dialect === 'mysql') {
        const [result] = await (context?.connection || pool).execute(sql, params);
        return mode === 'get' ? result[0]
            : mode === 'all' ? result
            : { lastID: result.insertId, changes: result.affectedRows };
    }
    // Inside a transaction the queue slot is already held; taking it again
    // would wait on a promise that only settles after this work finishes.
    return context ? runSqlite(sql, params, mode) : serialized(() => runSqlite(sql, params, mode));
}

const db = {
    get: (sql, params) => query('get', sql, params),
    all: (sql, params) => query('all', sql, params),
    run: (sql, params) => query('run', sql, params),
    // Everything inside `work` commits together or not at all. Nested calls
    // join the transaction already running rather than opening a second one.
    // Never await an AI provider in here: it holds the connection (MySQL) or
    // the whole queue (SQLite) for as long as the model takes to answer.
    transaction: async (work) => {
        await readyPromise;
        if (transactionContext.getStore()) return work(db);
        if (dialect === 'mysql') {
            const connection = await pool.getConnection();
            try {
                await connection.beginTransaction();
                const value = await transactionContext.run({ connection }, () => work(db));
                await connection.commit();
                return value;
            } catch (error) {
                await connection.rollback().catch(() => {});
                throw error;
            } finally {
                connection.release();
            }
        }
        return serialized(async () => {
            await runSqlite('BEGIN IMMEDIATE', [], 'run');
            try {
                const value = await transactionContext.run({ sqlite: true }, () => work(db));
                await runSqlite('COMMIT', [], 'run');
                return value;
            } catch (error) {
                await runSqlite('ROLLBACK', [], 'run').catch(() => {});
                throw error;
            }
        });
    },
    ready: () => readyPromise,
    dialect: () => dialect
};

module.exports = db;
