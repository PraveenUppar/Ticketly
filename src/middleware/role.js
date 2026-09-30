import AppError from '../utils/AppError.js';

// Use AFTER requireAuth: router.post('/', requireAuth, requireRole('ADMIN'), handler)
// 401 = "who are you?" (requireAuth)   403 = "I know you, but you may not do this" (here)
const requireRole = (...roles) => (req, res, next) => {
  if (!req.user) return next(new AppError('Authentication required', 401));
  if (!roles.includes(req.user.role)) {
    return next(new AppError('You do not have permission to do this', 403));
  }
  next();
};

export default requireRole;
