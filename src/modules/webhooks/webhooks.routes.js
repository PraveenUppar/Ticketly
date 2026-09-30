import { Router } from 'express';
import validate from '../../middleware/validate.js';
import requireAuth from '../../middleware/auth.js';
import requireRole from '../../middleware/role.js';
import {
  createWebhookSchema,
  updateWebhookSchema,
  webhookIdSchema,
  listDeliveriesSchema,
} from './webhooks.schema.js';
import {
  createWebhook,
  listWebhooks,
  updateWebhook,
  deleteWebhook,
  listDeliveries,
  pingWebhook,
} from './webhooks.controller.js';

const router = Router();

// webhooks are an admin feature: everything below needs a logged-in ADMIN
router.use(requireAuth, requireRole('ADMIN'));

router.post('/', validate(createWebhookSchema), createWebhook);
router.get('/', listWebhooks);
router.patch('/:id', validate(updateWebhookSchema), updateWebhook);
router.delete('/:id', validate(webhookIdSchema), deleteWebhook);
router.get('/:id/deliveries', validate(listDeliveriesSchema), listDeliveries);
router.post('/:id/test', validate(webhookIdSchema), pingWebhook);

export default router;
