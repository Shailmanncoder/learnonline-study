'use strict';
// Additive and repeatable.
//
// Counters rather than an event log: enforcement needs one number per person
// per month, and reading it must be cheap enough to do on every AI request.
// The key includes `kind` so the spend can be broken down by what it was spent
// on — which is what tells you whether a tool's price is set right.
module.exports = async function up(db) {
    const mysql = db.dialect() === 'mysql';
    await db.run(`CREATE TABLE IF NOT EXISTS usage_counters (
        user_id INTEGER NOT NULL,
        period VARCHAR(7) NOT NULL,
        kind VARCHAR(20) NOT NULL,
        credits INTEGER NOT NULL DEFAULT 0,
        calls INTEGER NOT NULL DEFAULT 0,
        updated_at BIGINT NOT NULL,
        PRIMARY KEY (user_id, period, kind)
    )${mysql ? ' ENGINE=InnoDB' : ''}`);

    if (mysql) {
        if (!(await db.all('SHOW INDEX FROM usage_counters WHERE Key_name = ?', ['usage_period'])).length) {
            await db.run('CREATE INDEX usage_period ON usage_counters (period, user_id)');
        }
    } else {
        await db.run('CREATE INDEX IF NOT EXISTS usage_period ON usage_counters (period, user_id)');
    }
};
