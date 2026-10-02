'use strict';
const {fail}=require('../config');
class PaymentAdapter {
 async createOrder() { fail(503,'This payment provider is unavailable.'); }
 async createPaymentSession(order) { return {providerOrderId:order.provider_order_id}; }
 async getPaymentStatus() { fail(503,'Payment status is unavailable.'); }
 async verifyPayment() { fail(503,'Payment verification is unavailable.'); }
 async refundPayment() { fail(503,'Refunds are unavailable.'); }
 async getRefundStatus() { fail(503,'Refund status is unavailable.'); }
 async generateUPIQR() { fail(409,'Use UPI inside the secure provider checkout.'); }
 async createBankTransfer() { fail(409,'Virtual accounts are not enabled for this merchant.'); }
 async handleWebhook() { fail(400,'Unsupported webhook provider.'); }
}
module.exports=PaymentAdapter;
