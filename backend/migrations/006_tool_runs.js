'use strict';
// Additive and repeatable.
//
// A tool run used to leave nothing behind: you got some text on screen, and
// closing the tab ended it. The Companion, meanwhile, kept threads, memory and
// history — so chat was strictly the more capable product and paying for
// "25 AI tools" bought a form in front of the same model.
//
// A saved run is what a tool has that a conversation does not: the inputs you
// gave, kept with the output, so it can be reopened, compared and run again
// without retyping.
module.exports = async function up(db) {
    const mysql = db.dialect() === 'mysql';
    await db.run(`CREATE TABLE IF NOT EXISTS tool_runs (
        id VARCHAR(40) PRIMARY KEY,
        user_id INTEGER NOT NULL,
        tool_id VARCHAR(60) NOT NULL,
        inputs TEXT,
        output ${mysql ? 'MEDIUMTEXT' : 'TEXT'},
        created_at BIGINT NOT NULL,
        FOREIGN KEY(user_id) REFERENCES users(id)
    )${mysql ? ' ENGINE=InnoDB' : ''}`);

    if (mysql) {
        if (!(await db.all('SHOW INDEX FROM tool_runs WHERE Key_name = ?', ['toolruns_user'])).length) {
            await db.run('CREATE INDEX toolruns_user ON tool_runs (user_id, tool_id, created_at)');
        }
    } else {
        await db.run('CREATE INDEX IF NOT EXISTS toolruns_user ON tool_runs (user_id, tool_id, created_at)');
    }
};
