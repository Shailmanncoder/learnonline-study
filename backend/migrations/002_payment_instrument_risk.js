module.exports=async function up(db){
 const exists=db.dialect()==='mysql'?(await db.all('SHOW COLUMNS FROM payment_transactions')).some(c=>c.Field==='instrument_hash'):(await db.all('PRAGMA table_info(payment_transactions)')).some(c=>c.name==='instrument_hash');
 if(!exists)await db.run('ALTER TABLE payment_transactions ADD COLUMN instrument_hash VARCHAR(64)');
 if(db.dialect()==='mysql') {if(!(await db.all('SHOW INDEX FROM payment_transactions WHERE Key_name = ?',['pay_instrument'])).length)await db.run('CREATE INDEX pay_instrument ON payment_transactions (instrument_hash,created_at)');}
 else await db.run('CREATE INDEX IF NOT EXISTS pay_instrument ON payment_transactions (instrument_hash,created_at)');
};
