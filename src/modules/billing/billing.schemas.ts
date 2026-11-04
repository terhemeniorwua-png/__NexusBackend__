import Joi from 'joi';

export const workspaceBillingParamsSchema = Joi.object({
  workspaceId: Joi.string().guid().required(),
}).unknown(false);

export const billingTargetSchema = Joi.object({
  plan: Joi.string().valid('PRO', 'BUSINESS').required(),
  interval: Joi.string().valid('MONTHLY', 'ANNUAL').required(),
}).unknown(false);

export const verifyCheckoutSchema = Joi.object({
  reference: Joi.string()
    .min(12)
    .max(100)
    .pattern(/^[A-Za-z0-9_-]+$/)
    .required(),
}).unknown(false);
