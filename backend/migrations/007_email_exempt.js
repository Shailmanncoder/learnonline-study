'use strict';
// Additive and repeatable.
//
// The confirmed-email requirement is for accounts made from here on. Everyone
// who already had an account signed up when a username alone was enough, and
// 24 of the 26 have no address on file — switching it on for them would stop
// all of them at once, mid-use, over a rule that did not exist when they
// joined.
//
// Stamped into the data rather than compared against a date, because a
// timestamp comparison depends on the clock, the column's format and an
// environment variable all staying correct. A row either carries the
// exemption or it does not.
module.exports = async function up(db) {
    const mysql = db.dialect() === 'mysql';
    const columns = mysql
        ? (await db.all('SHOW COLUMNS FROM users')).map(c => c.Field)
        : (await db.all('PRAGMA table_info(users)')).map(c => c.name);

    if (columns.includes('email_exempt')) return;   // already stamped

    await db.run('ALTER TABLE users ADD COLUMN email_exempt INTEGER NOT NULL DEFAULT 0');
    // Only the accounts that exist at this moment. Anything created afterwards
    // takes the default of 0 and is subject to the requirement.
    const { n } = await db.get('SELECT COUNT(*) n FROM users');
    await db.run('UPDATE users SET email_exempt = 1');
    console.log(`[MIGRATION] ${n} existing account(s) exempted from the email requirement`);
};
