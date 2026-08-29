import Razorpay from 'razorpay';
import { validateServerBootstrap, DUMMY_VALUES_SET } from './auth';

export function validateRazorpayConfig(forceCheckProduction?: boolean) {
  validateServerBootstrap(forceCheckProduction);
  const isProduction = forceCheckProduction !== undefined ? forceCheckProduction : process.env.NODE_ENV === 'production';
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;

  if (isProduction) {
    if (!keyId || DUMMY_VALUES_SET.has(keyId.trim().toLowerCase())) {
      throw new Error('Fatal Security Error: Invalid or missing RAZORPAY_KEY_ID in production environment.');
    }
    if (!keySecret || DUMMY_VALUES_SET.has(keySecret.trim().toLowerCase())) {
      throw new Error('Fatal Security Error: Invalid or missing RAZORPAY_KEY_SECRET in production environment.');
    }
    if (!webhookSecret || DUMMY_VALUES_SET.has(webhookSecret.trim().toLowerCase())) {
      throw new Error('Fatal Security Error: Invalid or missing RAZORPAY_WEBHOOK_SECRET in production environment.');
    }
  }
}

export function getRazorpayClient() {
  validateRazorpayConfig();

  const isProduction = process.env.NODE_ENV === 'production';
  const key_id = process.env.RAZORPAY_KEY_ID;
  const key_secret = process.env.RAZORPAY_KEY_SECRET;

  if (isProduction && (!key_id || !key_secret)) {
    throw new Error('Fatal Security Error: Missing Razorpay credentials in production.');
  }

  return new Razorpay({
    key_id: key_id || 'rzp_test_dev_key',
    key_secret: key_secret || 'dev_key_secret',
  });
}


