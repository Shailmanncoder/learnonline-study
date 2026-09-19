function getDatabaseMode(env = process.env) {
    const mode = (env.DB_DRIVER || 'mysql').trim().toLowerCase();
    if (!['mysql', 'sqlite'].includes(mode)) throw new Error('DB_DRIVER must be mysql or sqlite');
    return mode;
}
async function initializeDatabase(mode, { mysql, sqlite }) {
    if (mode === 'mysql') return mysql();
    if (mode === 'sqlite') return sqlite();
    throw new Error('DB_DRIVER must be mysql or sqlite');
}
module.exports = { getDatabaseMode, initializeDatabase };
