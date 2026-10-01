import bcrypt from "bcrypt";
import jwt from "jsonwebtoken";
import prisma from "../../config/prisma.js";
import AppError from "../../utils/AppError.js";
import asyncHandler from "../../utils/asyncHandler.js";
import { JWT_SECRET, JWT_EXPIRES_IN } from "../../config/env.js";

const publicUser = { id: true, email: true, role: true, createdAt: true };

export const signup = asyncHandler(async (req, res) => {
  const { email, password } = req.validated.body;

  const passwordHash = await bcrypt.hash(password, 10);

  try {
    const user = await prisma.user.create({
      data: { email, passwordHash },
      select: publicUser,
    });
    res.status(201).json({ status: "success", data: { user } });
  } catch (err) {
    if (err.code === "P2002")
      throw new AppError("Email already registered", 409);
    throw err;
  }
});

export const login = asyncHandler(async (req, res) => {
  const { email, password } = req.validated.body;

  const user = await prisma.user.findUnique({ where: { email } });
  const ok = user && (await bcrypt.compare(password, user.passwordHash));

  if (!ok) throw new AppError("Invalid email or password", 401);

  const token = jwt.sign({ sub: user.id, role: user.role }, JWT_SECRET, {
    expiresIn: JWT_EXPIRES_IN,
  });

  res.json({
    status: "success",
    data: {
      token,
      user: { id: user.id, email: user.email, role: user.role },
    },
  });
});

export const me = asyncHandler(async (req, res) => {
  const user = await prisma.user.findUnique({
    where: { id: req.user.id },
    select: publicUser,
  });
  if (!user) throw new AppError("User no longer exists", 401);
  res.json({ status: "success", data: { user } });
});
