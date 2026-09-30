import { Router } from 'express';
import validate from '../../middleware/validate.js';
import requireAuth from '../../middleware/auth.js';
import { listNotificationsSchema, notificationIdSchema } from './notifications.schema.js';
import { listMyNotifications, markRead } from './notifications.controller.js';

const router = Router();

router.use(requireAuth);

router.get('/', validate(listNotificationsSchema), listMyNotifications);
router.patch('/:id/read', validate(notificationIdSchema), markRead);

export default router;
