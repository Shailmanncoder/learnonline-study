'use strict';
const {db,lock,audit,notify}=require('./store');
const {id,key,clean,fail,config}=require('./config');
const {PAYMENT:P,REFUND,RISK}=require('./constants');
const service=require('./service');
const adapter=require('./adapters');
async function applyRefund(refundId,remote) {
 return db.transaction(async()=>{
  const initial=await db.get('SELECT * FROM payment_refunds WHERE id=?',[refundId]);if(!initial)return;
  const order=await service.orderRow(initial.order_id,true);
  const refund=await db.get('SELECT * FROM payment_refunds WHERE id=?',[refundId]);
  const tx=await db.get('SELECT * FROM payment_transactions WHERE id=?',[refund.transaction_id]);
  if(remote.payment_id!==tx.provider_reference||remote.amount!==refund.amount||(remote.currency&&remote.currency!==order.currency)) {await audit(null,'REFUND_MISMATCH',order.id,{refund:refund.id},order.mode);return;}
  if(refund.status===REFUND.PROCESSED)return;
  const status=remote.status==='processed'?REFUND.PROCESSED:remote.status==='failed'?REFUND.FAILED:REFUND.PENDING;
  if(refund.status===REFUND.FAILED && status===REFUND.PENDING)return;
  await db.run('UPDATE payment_refunds SET provider_reference=?,status=?,updated_at=? WHERE id=?',[remote.id,status,Date.now(),refund.id]);
  const sums=await db.get('SELECT COALESCE(SUM(CASE WHEN status=? THEN amount ELSE 0 END),0) done,COALESCE(SUM(CASE WHEN status=? THEN amount ELSE 0 END),0) pending FROM payment_refunds WHERE transaction_id=?',[REFUND.PROCESSED,REFUND.PENDING,tx.id]);
  const next=sums.pending?P.REFUND_PENDING:sums.done>=tx.amount?P.REFUNDED:sums.done?P.PARTIALLY_REFUNDED:P.PAID;
  await db.run('UPDATE payment_transactions SET status=? WHERE id=?',[next,tx.id]);
  const invoice=await db.get('SELECT transaction_id FROM payment_invoices WHERE order_id=?',[order.id]);
  // A refund of an accidental extra capture must not revoke the legitimate
  // purchase; only the receipt's transaction owns the entitlement.
  if(!invoice||invoice.transaction_id===tx.id) {
    await db.run('UPDATE payment_orders SET status=?,updated_at=? WHERE id=?',[next===P.PAID&&!invoice?P.PROCESSING:next,Date.now(),order.id]);
    if(next===P.REFUNDED) {
      await db.run('UPDATE payment_entitlements SET revoked=1 WHERE order_id=?',[order.id]);
      await service.syncSubscription(order.user_id,order.mode);
    }
  }
  if(status!==refund.status) {
    await audit(null,'REFUND_'+status,order.id,{refund:refund.id,amount:refund.amount},order.mode);
    await notify(order,status===REFUND.PROCESSED?'Refund completed':status===REFUND.FAILED?'Refund needs attention':'Refund pending',status===REFUND.PROCESSED?'Your refund has been processed. You can view it in Billing.':'The latest refund status is available in Billing.');
  }
 });
}
async function requestRefund(actor,txId,input) {
 const amount=input.amount,reason=clean(input.reason,500),k=key(input.idempotencyKey);
 if(!Number.isSafeInteger(amount)||amount<100||reason.length<5||input.confirm!==true)fail(400,'Confirm the refund, enter a reason and an amount of at least ₹1.');
 const initial=await db.get('SELECT * FROM payment_transactions WHERE id=? AND mode=?',[txId,config().mode]);if(!initial)fail(404,'Transaction not found.');
 const row=await db.transaction(async()=>{
  await service.orderRow(initial.order_id,true);
  const tx=await db.get('SELECT * FROM payment_transactions WHERE id=?',[txId]);
  const existing=await db.get('SELECT * FROM payment_refunds WHERE transaction_id=? AND idempotency_key=?',[txId,k]);
  if(existing) {if(existing.amount!==amount||existing.reason!==reason)fail(409,'This refund key belongs to a different request.');return existing;}
  if(![P.PAID,P.REFUND_PENDING,P.PARTIALLY_REFUNDED].includes(tx.status))fail(409,'Only captured payments can be refunded.');
  const reserved=await db.get('SELECT COALESCE(SUM(amount),0) amount FROM payment_refunds WHERE transaction_id=? AND status IN (?,?)',[txId,REFUND.PENDING,REFUND.PROCESSED]);
  if(amount>tx.amount-reserved.amount)fail(409,'The refund exceeds the unrefunded balance.');
  if(input.outcome&&!['success','failure'].includes(input.outcome))fail(400,'Invalid sandbox refund outcome.');
  const refund={id:id('ref'),transaction_id:txId,order_id:tx.order_id,amount,reason,status:REFUND.PENDING,idempotency_key:k,requested_by:actor.id,created_at:Date.now(),updated_at:Date.now(),test_outcome:tx.mode==='test'?input.outcome||'success':null};
  const cols=Object.keys(refund);await db.run(`INSERT INTO payment_refunds (${cols.join(',')}) VALUES (${cols.map(()=>'?').join(',')})`,Object.values(refund));
  await db.run('UPDATE payment_transactions SET status=? WHERE id=?',[P.REFUND_PENDING,txId]);
  await db.run('UPDATE payment_orders SET status=? WHERE id=?',[P.REFUND_PENDING,tx.order_id]);
  await audit(actor.id,'REFUND_REQUESTED',tx.order_id,{refund:refund.id,amount,reason},tx.mode);
  await notify(await service.orderRow(tx.order_id),'Refund initiated','Your refund request is being processed.');
  return refund;
 });
 if(row.status!==REFUND.PENDING)return row;
 const order=await service.orderRow(row.order_id);
 try {
  const remote=row.provider_reference?await adapter(order).getRefundStatus(row,initial):await adapter(order).refundPayment(initial,row);
  await applyRefund(row.id,remote);
 } catch(error) {
  // On timeouts retain the reserved balance. The same idempotency key can
  // safely recover an unknown result; never release it merely on HTTP error.
  await audit(actor.id,'REFUND_RECONCILIATION_NEEDED',row.order_id,{refund:row.id},order.mode);
 }
 return db.get('SELECT * FROM payment_refunds WHERE id=?',[row.id]);
}
async function retryRefund(actor,refundId) {
 const row=await db.get('SELECT r.* FROM payment_refunds r JOIN payment_orders o ON o.id=r.order_id WHERE r.id=? AND o.mode=?',[refundId,config().mode]);if(!row)fail(404,'Refund not found.');
 return requestRefund(actor,row.transaction_id,{amount:row.amount,reason:row.reason,idempotencyKey:row.idempotency_key,confirm:true,outcome:row.test_outcome||undefined});
}
async function review(actor,orderId,input) {
 if(!['ALLOW','BLOCK','REVIEW'].includes(input.decision)||clean(input.reason,500).length<5||input.confirm!==true)fail(400,'Confirm a review decision and explain the reason.');
 return db.transaction(async()=>{
  const order=await service.orderRow(orderId,true);if(!order||order.mode!==config().mode)fail(404,'Order not found.');
  const transaction=await db.get('SELECT * FROM payment_transactions WHERE order_id=? AND status=? ORDER BY created_at LIMIT 1',[orderId,P.PAID]);
  if(input.decision===RISK.ALLOW && (!transaction||order.status!==P.PROCESSING||await db.get('SELECT id FROM payment_invoices WHERE order_id=?',[orderId])))fail(409,'Only a verified captured payment awaiting review can be activated.');
  if(input.decision===RISK.ALLOW) {
   await db.run('UPDATE payment_orders SET risk_decision=?,status=? WHERE id=?',[RISK.ALLOW,P.PAID,orderId]);
   await db.run('UPDATE payment_transactions SET risk_decision=? WHERE id=?',[RISK.ALLOW,transaction.id]);
   await service.activate(order,transaction);
  } else await db.run('UPDATE payment_orders SET risk_decision=? WHERE id=?',[input.decision,orderId]);
  await db.run('INSERT INTO payment_risk_assessments (id,order_id,score,decision,rules,reviewed_by,reviewed_at,note,created_at) VALUES (?,?,?,?,?,?,?,?,?)',[id('rsk'),orderId,input.decision==='ALLOW'?0:100,input.decision,JSON.stringify(['manual_review']),actor.id,Date.now(),clean(input.reason,500),Date.now()]);
  await audit(actor.id,'RISK_REVIEWED',orderId,{before:order.risk_decision,after:input.decision,reason:clean(input.reason,500)},order.mode);
  return service.publicOrder(await service.orderRow(orderId));
 });
}
async function detail(actor,orderId) {
 const order=await service.orderRow(orderId);if(!order||order.mode!==config().mode)fail(404,'Order not found.');
 await audit(actor.id,'ADMIN_VIEWED_ORDER',order.id,{},order.mode);
 const [transactions,refunds,invoices,risks,webhooks,audits,reconciliation,customer]=await Promise.all([
  db.all('SELECT * FROM payment_transactions WHERE order_id=?',[orderId]),db.all('SELECT * FROM payment_refunds WHERE order_id=?',[orderId]),db.all('SELECT id,number,created_at FROM payment_invoices WHERE order_id=?',[orderId]),db.all('SELECT * FROM payment_risk_assessments WHERE order_id=? ORDER BY created_at DESC',[orderId]),db.all('SELECT id,event_type,status,received_at,processed_at FROM payment_webhook_events WHERE order_id=? ORDER BY received_at DESC',[orderId]),db.all('SELECT * FROM payment_audit_logs WHERE entity_id=? ORDER BY created_at DESC LIMIT 100',[orderId]),db.all('SELECT * FROM payment_reconciliation_records WHERE order_id=? ORDER BY created_at DESC LIMIT 30',[orderId]),db.get('SELECT id,username,role,created_at FROM users WHERE id=?',[order.user_id])
 ]);
 return {order:service.publicOrder(order),transactions,refunds,invoices,risks,webhooks,audits,reconciliation,customer};
}
async function overview() {
 const mode=config().mode,now=Date.now(),offset=19800000,day=Math.floor((now+offset)/86400000),today=day*86400000-offset;
 const india=new Date(now+offset),month=Date.UTC(india.getUTCFullYear(),india.getUTCMonth(),1)-offset;
 const [paid,refunds,counts,revenueRows,methodRows,refundRows]=await Promise.all([
  db.get('SELECT COUNT(*) n,COALESCE(SUM(amount),0) gross,COALESCE(SUM(CASE WHEN paid_at>=? THEN amount ELSE 0 END),0) today,COALESCE(SUM(CASE WHEN paid_at>=? THEN amount ELSE 0 END),0) month FROM payment_transactions WHERE mode=? AND paid_at IS NOT NULL',[today,month,mode]),
  db.get('SELECT COALESCE(SUM(r.amount),0) amount FROM payment_refunds r JOIN payment_orders o ON o.id=r.order_id WHERE o.mode=? AND r.status=?',[mode,REFUND.PROCESSED]),
  db.all('SELECT status,COUNT(*) n FROM payment_orders WHERE mode=? GROUP BY status',[mode]),
  db.all('SELECT FLOOR((paid_at+19800000)/86400000) bucket,SUM(amount) amount FROM payment_transactions WHERE mode=? AND paid_at>=? GROUP BY bucket',[mode,now-30*86400000]),
  db.all('SELECT method,SUM(amount) amount FROM payment_transactions WHERE mode=? AND paid_at IS NOT NULL GROUP BY method',[mode]),
  db.all('SELECT FLOOR((r.updated_at+19800000)/86400000) bucket,SUM(r.amount) amount FROM payment_refunds r JOIN payment_orders o ON o.id=r.order_id WHERE o.mode=? AND r.status=? AND r.updated_at>=? GROUP BY bucket',[mode,REFUND.PROCESSED,now-30*86400000])
 ]);
 const totals=Object.fromEntries(counts.map(r=>[r.status,Number(r.n)])),successful=Number(paid.n),failed=totals[P.FAILED]||0,pending=[P.CREATED,P.PENDING,P.AUTHORIZED,P.PROCESSING].reduce((n,k)=>n+(totals[k]||0),0);
 const series=rows=>Object.fromEntries(rows.map(r=>[new Date(Number(r.bucket)*86400000).toISOString().slice(0,10),Number(r.amount)]));
 return {mode,totalRevenue:Number(paid.gross)-Number(refunds.amount),grossRevenue:Number(paid.gross),paymentsToday:Number(paid.today),paymentsMonth:Number(paid.month),successful,failed,refunded:Number(refunds.amount),pending,successRate:successful+failed?successful/(successful+failed)*100:0,averageOrderValue:successful?Number(paid.gross)/successful:0,revenue:series(revenueRows),methods:Object.fromEntries(methodRows.map(r=>[r.method,Number(r.amount)])),refundTrend:series(refundRows),generatedAt:now};
}
async function list(kind,query={}) {
 const mode=config().mode,page=Math.max(1,Math.min(100000,parseInt(query.page)||1)),limit=30;
 const where=['o.mode=?'],params=[mode];
 if(query.search){where.push('(o.id LIKE ? OR o.customer_name LIKE ? OR o.customer_email LIKE ?)');const term=`%${clean(query.search,100).replace(/[%_]/g,'')}%`;params.push(term,term,term);}
 if(query.status){where.push((['transactions','refunds'].includes(kind)?'x':'o')+'.status=?');params.push(clean(query.status,30));}
 if(query.risk){where.push('o.risk_decision=?');params.push(clean(query.risk,12));}
 if(query.method){where.push(kind==='transactions'?'x.method=?':'EXISTS (SELECT 1 FROM payment_transactions t WHERE t.order_id=o.id AND t.method=?)');params.push(clean(query.method,30));}
 for(const [field,op] of [['min','>='],['max','<=']])if(query[field]){const amount=Number(query[field]);if(!Number.isFinite(amount)||amount<0)fail(400,'Invalid amount filter.');where.push(`o.amount ${op} ?`);params.push(Math.round(amount*100));}
 for(const [field,op] of [['from','>='],['to','<=']])if(query[field]){const ms=Date.parse(query[field]+(field==='to'?'T23:59:59.999+05:30':'T00:00:00+05:30'));if(!Number.isFinite(ms))fail(400,'Invalid date filter.');where.push(`${['transactions','refunds','invoices','reconciliation'].includes(kind)?'x':'o'}.created_at ${op} ?`);params.push(ms);}
 if(kind==='risk')where.push("o.risk_decision <> 'ALLOW'");
 const allowed={orders:null,risk:null,transactions:'payment_transactions',refunds:'payment_refunds',invoices:'payment_invoices',reconciliation:'payment_reconciliation_records'};
 if(!Object.hasOwn(allowed,kind))fail(404,'Unknown payment view.');
 const table=allowed[kind];
 const from=table?`${table} x JOIN payment_orders o ON o.id=x.order_id`:'payment_orders o';
 const select=table?'x.*,o.product_name,o.customer_name,o.customer_email,o.risk_decision,o.currency,o.mode':'o.*';
 const total=await db.get(`SELECT COUNT(*) n FROM ${from} WHERE ${where.join(' AND ')}`,params);
 const rows=await db.all(`SELECT ${select} FROM ${from} WHERE ${where.join(' AND ')} ORDER BY ${table?'x':'o'}.created_at DESC LIMIT ${limit} OFFSET ${(page-1)*limit}`,params);
 return {rows:rows.map(r=>{const {snapshot,ip_hash,device_hash,fingerprint,idempotency_key,...safe}=r;return safe;}),total:total.n,page,pages:Math.max(1,Math.ceil(total.n/limit))};
}
module.exports={applyRefund,requestRefund,retryRefund,review,detail,overview,list};
