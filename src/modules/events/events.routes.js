import { Router } from 'express';
import validate from '../../middleware/validate.js';
import requireAuth from '../../middleware/auth.js';
import requireRole from '../../middleware/role.js';
import {
  createEventSchema,
  updateEventSchema,
  eventIdSchema,
  listEventsSchema,
} from './events.schema.js';
import {
  createEvent,
  listEvents,
  getEvent,
  updateEvent,
  deleteEvent,
} from './events.controller.js';

const router = Router();

// public
router.get('/', validate(listEventsSchema), listEvents);
router.get('/:id', validate(eventIdSchema), getEvent);

// admin only
router.post('/', requireAuth, requireRole('ADMIN'), validate(createEventSchema), createEvent);
router.patch('/:id', requireAuth, requireRole('ADMIN'), validate(updateEventSchema), updateEvent);
router.delete('/:id', requireAuth, requireRole('ADMIN'), validate(eventIdSchema), deleteEvent);

export default router;
