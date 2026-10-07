'use strict';
// Additive and repeatable.
//
// A recovery email is only worth something once the person has proved they can
// read it. Until then a typo sends reset codes to a stranger, and the account
// holder is locked out without knowing why.
//
// The pending address lives in email_verifications, NOT in users.email, so
// starting a change never disturbs an address that is already confirmed: get
// the new one wrong and you still have the old one.
module.exports = async function up(db) {
    const mysql = db.dialect() === 'mysql';
    const columnsOf = async (table) => mysql
        ? (await db.all(`SHOW COLUMNS FROM ${table}`)).map(c => c.Field)
        : (await db.all(`PRAGMA table_info(${table})`)).map(c => c.name);

    const userColumns = await columnsOf('users');
    if (!userColumns.includes('email_verified_at')) {
        await db.run('ALTER TABLE users ADD COLUMN email_verified_at BIGINT');
    }

    await db.run(`CREATE TABLE IF NOT EXISTS email_verifications (
        id VARCHAR(40) PRIMARY KEY,
        user_id INTEGER NOT NULL,
        email VARCHAR(254) NOT NULL,
        code_hash VARCHAR(120) NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        used_at BIGINT,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )${mysql ? ' ENGINE=InnoDB' : ''}`);

    if (mysql) {
        if (!(await db.all('SHOW INDEX FROM email_verifications WHERE Key_name = ?', ['emailver_user'])).length) {
            await db.run('CREATE INDEX emailver_user ON email_verifications (user_id, expires_at)');
        }
    } else {
        await db.run('CREATE INDEX IF NOT EXISTS emailver_user ON email_verifications (user_id, expires_at)');
    }

    // Nothing is marked verified here, including the addresses migration 003
    // copied over from email-shaped usernames. Those were never confirmed
    // either: registering with an address is not proof of reading it.
};
