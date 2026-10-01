const db = require('../config/db');
let initialized;
function ready() {
    return initialized ||= db.run(`CREATE TABLE IF NOT EXISTS teacher_join_requests (
        class_id INTEGER NOT NULL, teacher_id INTEGER NOT NULL, subject VARCHAR(150) NOT NULL,
        status VARCHAR(15) NOT NULL DEFAULT 'pending', PRIMARY KEY (class_id, teacher_id))`).catch(e=>{initialized=null;throw e;});
}
module.exports={ready};
