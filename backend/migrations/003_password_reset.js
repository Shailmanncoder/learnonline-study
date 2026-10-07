'use strict';
// Additive and repeatable. Nothing here drops or rewrites existing data: it
// adds two nullable columns to users and one new table.
//
// Most accounts registered with a plain username, not an email address, so
// there is nowhere to send a reset code. users.email is the recovery address,
// set by the account holder; where the username already IS an email it is
// copied across once so those people do not have to do anything.
module.exports = async function up(db) {
    const mysql = db.dialect() === 'mysql';
    const columnsOf = async (table) => mysql
        ? (await db.all(`SHOW COLUMNS FROM ${table}`)).map(c => c.Field)
        : (await db.all(`PRAGMA table_info(${table})`)).map(c => c.name);

    const userColumns = await columnsOf('users');
    if (!userColumns.includes('email')) {
        await db.run('ALTER TABLE users ADD COLUMN email VARCHAR(254)');
    }
    // A reset must end every session opened with the old password, or an
    // attacker who already signed in simply keeps their token. Tokens are
    // stateless, so the check is "issued before this moment".
    if (!userColumns.includes('password_changed_at')) {
        await db.run('ALTER TABLE users ADD COLUMN password_changed_at BIGINT');
    }

    await db.run(`CREATE TABLE IF NOT EXISTS password_resets (
        id VARCHAR(40) PRIMARY KEY,
        user_id INTEGER NOT NULL,
        code_hash VARCHAR(120) NOT NULL,
        created_at BIGINT NOT NULL,
        expires_at BIGINT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0,
        used_at BIGINT,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )${mysql ? ' ENGINE=InnoDB' : ''}`);

    if (mysql) {
        if (!(await db.all('SHOW INDEX FROM password_resets WHERE Key_name = ?', ['pwreset_user'])).length) {
            await db.run('CREATE INDEX pwreset_user ON password_resets (user_id, expires_at)');
        }
    } else {
        await db.run('CREATE INDEX IF NOT EXISTS pwreset_user ON password_resets (user_id, expires_at)');
    }

    // One-time backfill, and only where the username is unambiguously an
    // address. It never overwrites an email the account has already set.
    await db.run(`UPDATE users SET email = username
        WHERE email IS NULL AND username LIKE '%_@_%._%'`);
};
