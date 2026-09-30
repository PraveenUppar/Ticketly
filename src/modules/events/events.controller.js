import prisma from '../../config/prisma.js';
import AppError from '../../utils/AppError.js';
import asyncHandler from '../../utils/asyncHandler.js';
import { cached, invalidateEventsCache } from '../../utils/cache.js';

const LIST_CACHE_TTL_SECONDS = 60;

export const createEvent = asyncHandler(async (req, res) => {
  const { title, description, city, date, price, totalSeats } = req.validated.body;

  const event = await prisma.event.create({
    data: { title, description, city, date, price, totalSeats, seatsLeft: totalSeats },
  });

  await invalidateEventsCache();
  res.status(201).json({ status: 'success', data: { event } });
});

export const listEvents = asyncHandler(async (req, res) => {
  const { page, limit, city, q, sort } = req.validated.query;

  // The cache key is built from the VALIDATED query, so ?page=1&city=X and
  // ?city=X&page=1 share one entry, and junk params can't create endless keys.
  const cacheKey = JSON.stringify({ page, limit, city, q, sort });

  const { value: body, hit } = await cached(cacheKey, LIST_CACHE_TTL_SECONDS, async () => {
    const where = {
      status: 'UPCOMING',
      ...(city && { city }),
      ...(q && { OR: [{ title: { contains: q } }, { description: { contains: q } }] }),
    };

    const field = sort.replace('-', '');
    const direction = sort.startsWith('-') ? 'desc' : 'asc';

    // findMany and count use the same `where`, so `total` matches the filtered list.
    const [events, total] = await Promise.all([
      prisma.event.findMany({
        where,
        orderBy: { [field]: direction },
        skip: (page - 1) * limit,
        take: limit,
      }),
      prisma.event.count({ where }),
    ]);

    return {
      status: 'success',
      data: { events },
      meta: { page, limit, total, totalPages: Math.ceil(total / limit) },
    };
  });

  res.set('X-Cache', hit ? 'HIT' : 'MISS'); // handy for seeing the cache work in Postman
  res.json(body);
});

export const getEvent = asyncHandler(async (req, res) => {
  const event = await prisma.event.findUnique({ where: { id: req.validated.params.id } });
  if (!event) throw new AppError('Event not found', 404);
  res.json({ status: 'success', data: { event } });
});

export const updateEvent = asyncHandler(async (req, res) => {
  const { params, body } = req.validated;

  const existing = await prisma.event.findUnique({ where: { id: params.id } });
  if (!existing) throw new AppError('Event not found', 404);

  const event = await prisma.event.update({ where: { id: params.id }, data: body });
  await invalidateEventsCache();
  res.json({ status: 'success', data: { event } });
});

export const deleteEvent = asyncHandler(async (req, res) => {
  const { id } = req.validated.params;

  const existing = await prisma.event.findUnique({ where: { id } });
  if (!existing) throw new AppError('Event not found', 404);

  // Bookings reference the event, so deleting an event that has any would
  // either fail on the foreign key or destroy history. Refuse with a clear message.
  const bookings = await prisma.booking.count({ where: { eventId: id } });
  if (bookings > 0) throw new AppError('Cannot delete an event that has bookings', 409);

  await prisma.event.delete({ where: { id } });
  await invalidateEventsCache();
  res.status(204).send();
});
