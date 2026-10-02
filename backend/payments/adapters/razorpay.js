'use strict';
const PaymentAdapter=require('./base');
const {equal,hmac,fail}=require('../config');
class RazorpayAdapter extends PaymentAdapter {
 async request(path,method='GET',body,headers={}) {
   let response;
   try {
     response=await fetch(`https://api.razorpay.com/v1${path}`,{method,headers:{Authorization:`Basic ${Buffer.from(`${process.env.RAZORPAY_KEY_ID}:${process.env.RAZORPAY_KEY_SECRET}`).toString('base64')}`,'Content-Type':'application/json',...headers},...(body?{body:JSON.stringify(body)}:{}),signal:AbortSignal.timeout(15000)});
   } catch { fail(503,'The payment provider did not respond. Check payment status before retrying.','PROVIDER_UNCERTAIN'); }
   const value=await response.json().catch(()=>({}));
   // Provider text may include bank/customer data. Keep it out of public errors.
   if(!response.ok) fail(response.status>=500?503:409,'The provider could not complete this request. Please check its status.','PROVIDER_REJECTED');
   return value;
 }
 async createOrder(order) { return this.request('/orders','POST',{amount:order.amount,currency:order.currency,receipt:order.id,notes:{learnonline_order:order.id},partial_payment:false}); }
 async findOrder(order) { const rows=(await this.request(`/orders?receipt=${encodeURIComponent(order.id)}&count=100`)).items || []; return rows.filter(r=>r.receipt===order.id&&r.amount===order.amount&&r.currency===order.currency); }
 async createPaymentSession(order,session) { return {provider:'razorpay',key:process.env.RAZORPAY_KEY_ID,providerOrderId:order.provider_order_id,amount:order.amount,currency:order.currency,sessionId:session.id}; }
 async getPaymentStatus(order) { return (await this.request(`/orders/${encodeURIComponent(order.provider_order_id)}/payments`)).items || []; }
 async verifyPayment(order,proof) {
   if(typeof proof.razorpay_payment_id!=='string' || !/^pay_[A-Za-z0-9]+$/.test(proof.razorpay_payment_id) || proof.razorpay_order_id!==order.provider_order_id || !equal(hmac(`${order.provider_order_id}|${proof.razorpay_payment_id}`,process.env.RAZORPAY_KEY_SECRET),proof.razorpay_signature)) fail(400,'Payment verification failed.');
   return this.request(`/payments/${encodeURIComponent(proof.razorpay_payment_id)}`);
 }
 async refundPayment(transaction,refund) { return this.request(`/payments/${encodeURIComponent(transaction.provider_reference)}/refund`,'POST',{amount:refund.amount,speed:'normal',receipt:refund.id},{'X-Refund-Idempotency':refund.id}); }
 async getRefundStatus(refund) { return this.request(`/refunds/${encodeURIComponent(refund.provider_reference)}`); }
 async handleWebhook(raw,headers) {
   if(!equal(hmac(raw,process.env.RAZORPAY_WEBHOOK_SECRET || ''),headers['x-razorpay-signature'])) fail(401,'Invalid webhook signature.');
   try{return JSON.parse(raw.toString('utf8'));}catch{fail(400,'Invalid webhook payload.');}
 }
}
module.exports=RazorpayAdapter;
