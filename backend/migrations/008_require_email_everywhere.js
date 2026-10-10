'use strict';
// Additive and repeatable.
//
// 007 exempted the accounts that existed when the email requirement arrived,
// so nobody was stopped mid-use by a rule that did not exist when they joined.
// That was a transition, and the transition is over: every account now
// confirms an address with a code before using anything.
//
// The column stays. It is the mechanism for any future grace period, and
// removing it would mean rebuilding the same thing next time.
module.exports = async function up(db) {
    const mysql = db.dialect() === 'mysql';
    const columns = mysql
        ? (await db.all('SHOW COLUMNS FROM users')).map(c => c.Field)
        : (await db.all('PRAGMA table_info(users)')).map(c => c.name);
    if (!columns.includes('email_exempt')) return;   // 007 has not run yet

    const { n } = await db.get('SELECT COUNT(*) n FROM users WHERE email_exempt = 1');
    if (!n) return;                                   // already cleared

    await db.run('UPDATE users SET email_exempt = 0 WHERE email_exempt = 1');
    console.log(`[MIGRATION] ${n} account(s) must now confirm an email before using the AI tools`);
};
