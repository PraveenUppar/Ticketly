import jwt from 'jsonwebtoken';
import AppError from '../utils/AppError.js';
import { JWT_SECRET } from '../config/env.js';

const requireAuth = (req, res, next) => {
  const header = req.headers.authorization;

  if (!header || !header.startsWith('Bearer ')) {
    return next(new AppError('Authentication required', 401));
  }

  const token = header.slice(7);

  try {
    const payload = jwt.verify(token, JWT_SECRET);
    // The token stores the id as `sub`; expose it as req.user.id everywhere else.
    req.user = { id: payload.sub, role: payload.role };
    next();
  } catch {
    // expired, tampered, malformed: all are a 401, not a 500
    next(new AppError('Invalid or expired token', 401));
  }
};

export default requireAuth;
