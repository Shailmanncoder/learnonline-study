'use strict';
const {createHash}=require('node:crypto');
const {db,ready,lock,audit}=require('./store');
const {config,fail,assertEnabled}=require('./config');
const service=require('./service');
const admin=require('./admin');
const adapter=require('./adapters');
async function handle(source,raw,headers) {
 await ready();const c=assertEnabled();if(source!==c.provider)fail(404,'Unknown payment source.');
 if(!Buffer.isBuffer(raw))fail(400,'A raw webhook body is required.');
 let payload;try{payload=await adapter().handleWebhook(raw,headers);}catch(error){await audit(null,'WEBHOOK_REJECTED',null,{reason:'signature_or_payload'},c.mode);throw error;}
 const eventId=headers[source==='sandbox'?'x-test-event-id':'x-razorpay-event-id'];
 if(typeof eventId!=='string'||!/^[a-zA-Z0-9_-]{5,90}$/.test(eventId))fail(400,'A valid event ID is required.');
 const eventKey=`${c.mode}_${source}_${eventId}`,hash=createHash('sha256').update(raw).digest('hex');
 return db.transaction(async()=>{
  const existing=await db.get(`SELECT * FROM payment_webhook_events WHERE id=?${lock()}`,[eventKey]);
  if(existing){if(existing.body_hash!==hash)fail(409,'Event ID has already been used.');if(existing.status==='PROCESSED')return {received:true,duplicate:true};}
  // Razorpay retries old signed events. A 72-hour delivery window permits
  // those retries; provider reconciliation covers anything older.
  const timestamp=payload.created_at*1000;
  if(!Number.isFinite(timestamp)||timestamp>Date.now()+300000||timestamp<Date.now()-72*3600000)fail(400,'Webhook timestamp is outside the delivery window.');
  await db.run('INSERT IGNORE INTO payment_webhook_events (id,provider,mode,event_type,body_hash,status,received_at) VALUES (?,?,?,?,?,?,?)',[eventKey,source,c.mode,String(payload.event||'').slice(0,100),hash,'RECEIVED',Date.now()]);
  const claimed=await db.get(`SELECT * FROM payment_webhook_events WHERE id=?${lock()}`,[eventKey]);
  if(claimed.body_hash!==hash)fail(409,'Event ID has already been used.');if(claimed.status==='PROCESSED')return {received:true,duplicate:true};
  const payment=payload.payload?.payment?.entity,refund=payload.payload?.refund?.entity,dispute=payload.payload?.dispute?.entity;
  let order;
  if(payment?.order_id)order=await db.get('SELECT * FROM payment_orders WHERE provider_order_id=? AND mode=? AND provider=?',[payment.order_id,c.mode,source]);
  if(payment&&order&&['payment.captured','payment.authorized','payment.failed','order.paid'].includes(payload.event))await service.applyPayment(order.id,payment);
  if(refund&&/^refund\./.test(payload.event)) {
    const r=await db.get('SELECT r.* FROM payment_refunds r JOIN payment_orders o ON o.id=r.order_id WHERE o.mode=? AND (r.provider_reference=? OR r.id=?)',[c.mode,refund.id,refund.receipt||'']);
    if(r){await admin.applyRefund(r.id,refund);order=await service.orderRow(r.order_id);}
  }
  if(dispute?.payment_id&&/^payment\.dispute\./.test(payload.event)) {
    const tx=await db.get('SELECT * FROM payment_transactions WHERE provider_reference=? AND mode=? AND provider=?',[dispute.payment_id,c.mode,source]);
    if(tx){order=await service.orderRow(tx.order_id,true);await db.run('UPDATE payment_orders SET status=? WHERE id=?',['DISPUTED',order.id]);await db.run('UPDATE payment_transactions SET status=? WHERE id=?',['DISPUTED',tx.id]);await db.run('UPDATE payment_entitlements SET revoked=1 WHERE order_id=?',[order.id]);await service.syncSubscription(order.user_id,c.mode);await audit(null,'DISPUTE_REQUIRES_REVIEW',order.id,{reference:dispute.id},c.mode);}
  }
  await db.run('UPDATE payment_webhook_events SET status=?,order_id=?,processed_at=? WHERE id=?',['PROCESSED',order?.id||null,Date.now(),eventKey]);
  await audit(null,'WEBHOOK_PROCESSED',order?.id||null,{eventId,event:payload.event,matched:!!order},c.mode);
  return {received:true};
 });
}
module.exports={handle};
