'use strict';
const {db,ready}=require('./store');
const {config}=require('./config');
const service=require('./service'),management=require('./admin');
let timer,running=false;
async function tick() {
 if(running)return;running=true;
 try{
  await ready();const c=config();if(c.mode!=='live'||!c.enabled)return;
  // Database claims in reconcile prevent parallel workers from duplicating
  // polling. Work remains bounded and resumes after a process restart.
  const orders=await db.all("SELECT * FROM payment_orders WHERE mode=? AND status IN ('CREATED','PENDING','PROCESSING','AUTHORIZED','FAILED','EXPIRED') AND provider_state IS NOT NULL AND created_at>? AND last_checked_at<? ORDER BY last_checked_at LIMIT 25",[c.mode,Date.now()-7*86400000,Date.now()-60000]);
  for(const order of orders)await service.reconcile(order).catch(()=>{});
  const refunds=await db.all("SELECT r.id,r.requested_by FROM payment_refunds r JOIN payment_orders o ON o.id=r.order_id WHERE o.mode=? AND r.status='PENDING' AND r.updated_at<? ORDER BY r.updated_at LIMIT 10",[c.mode,Date.now()-60000]);
  for(const r of refunds)await management.retryRefund({id:r.requested_by},r.id).catch(()=>{});
 } finally{running=false;}
}
function start(){if(timer)return;timer=setInterval(()=>tick().catch(()=>console.warn('[PAYMENTS] reconciliation will retry')),60000);timer.unref();}
module.exports={start,tick};
