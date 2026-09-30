import { Router } from 'express';
import validate from '../../middleware/validate.js';
import requireAuth from '../../middleware/auth.js';
import { signupSchema, loginSchema } from './auth.schema.js';
import { signup, login, me } from './auth.controller.js';

const router = Router();

router.post('/signup', validate(signupSchema), signup);
router.post('/login', validate(loginSchema), login);
router.get('/me', requireAuth, me);

export default router;
