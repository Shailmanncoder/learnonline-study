'use strict';
const db=require('../config/db');
const {id,config}=require('./config');
let readyPromise;
async function migrate() {
 await db.ready();
 await db.run('CREATE TABLE IF NOT EXISTS payment_schema_migrations (version INTEGER PRIMARY KEY, applied_at BIGINT NOT NULL)');
 if(!await db.get('SELECT version FROM payment_schema_migrations WHERE version=1')) {
   // MySQL DDL auto-commits. Each additive statement is restart-safe; deploy
   // migrations once before starting workers (documented deployment command).
   await require('../migrations/001_payments')(db);
   await db.run('INSERT IGNORE INTO payment_schema_migrations (version,applied_at) VALUES (1,?)',[Date.now()]);
 }
 if(!await db.get('SELECT version FROM payment_schema_migrations WHERE version=2')) {
   await require('../migrations/002_payment_instrument_risk')(db);
   await db.run('INSERT IGNORE INTO payment_schema_migrations (version,applied_at) VALUES (2,?)',[Date.now()]);
 }
}
const ready=()=>readyPromise || (readyPromise=migrate());
const lock=()=>db.dialect()==='mysql'?' FOR UPDATE':'';
async function audit(actor,action,entity,metadata={},mode=config().mode,ip=null) {
 await db.run('INSERT INTO payment_audit_logs (id,actor_id,action,entity_id,mode,metadata,ip_hash,created_at) VALUES (?,?,?,?,?,?,?,?)',[id('aud'),actor||null,action,entity,mode,JSON.stringify(metadata),ip,Date.now()]);
}
async function notify(order,title,message) {
 await db.run('INSERT INTO notifications (user_id,type,title,message,reference_type) VALUES (?,?,?,?,?)',[order.user_id,'payment',`${order.mode==='test'?'[Test] ':''}${title}`,message,'billing']);
}
module.exports={db,ready,lock,audit,notify};
