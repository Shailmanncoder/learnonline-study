'use strict';
const PaymentAdapter=require('./base');
const {hmac,equal,fail}=require('../config');
class SandboxAdapter extends PaymentAdapter {
 async createOrder(order) { return {id:`test_${order.id}`,amount:order.amount,currency:order.currency}; }
 async getPaymentStatus() { return []; }
 async createPaymentSession(order,session) { return {provider:'sandbox',sessionId:session.id,providerOrderId:order.provider_order_id}; }
 async generateUPIQR(order,session) {
   // Deliberately NOT a UPI payment URI: this QR can never move real money.
   return {image:await require('qrcode').toDataURL(`LEARNONLINE TEST ONLY\n${session.id}\n${order.currency} ${order.amount/100}`,{width:240,margin:1}),expiresAt:session.expires_at};
 }
 async createBankTransfer(order) { return {account:'TEST-NOT-A-BANK-ACCOUNT',ifsc:'TEST0000000',beneficiary:'LearnOnline Sandbox — do not transfer money',reference:order.id}; }
 async refundPayment(transaction,refund) { return {id:`test_${refund.id}`,payment_id:transaction.provider_reference,amount:refund.amount,currency:transaction.currency,status:refund.test_outcome==='failure'?'failed':'processed'}; }
 async getRefundStatus(refund,transaction) { return this.refundPayment(transaction,refund); }
 async handleWebhook(raw,headers) {
   const secret=process.env.PAYMENTS_TEST_WEBHOOK_SECRET;
   if(!secret || !equal(hmac(raw,secret),headers['x-test-signature'])) fail(401,'Invalid webhook signature.');
   try{return JSON.parse(raw.toString('utf8'));}catch{fail(400,'Invalid webhook payload.');}
 }
}
module.exports=SandboxAdapter;
