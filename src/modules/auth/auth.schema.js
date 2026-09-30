import { z } from 'zod';

const email = z.email('Invalid email').trim().toLowerCase();

export const signupSchema = z.object({
  body: z.object({
    email,
    password: z.string().min(8, 'Password must be at least 8 characters').max(72),
  }),
});

export const loginSchema = z.object({
  body: z.object({
    email,
    password: z.string().min(1, 'Password is required'),
  }),
});
