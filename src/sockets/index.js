import { Server } from 'socket.io';
import { z } from 'zod';
import prisma from '../config/prisma.js';
import logger from '../utils/logger.js';

let io = null;

const eventIdSchema = z.uuid();
const room = (eventId) => `event:${eventId}`;

// Client -> server:  socket.emit('event:join', eventId, (reply) => ...)   start watching an event
//                    socket.emit('event:leave', eventId)                  stop watching
// Server -> client:  'seats:update'  { eventId, seatsLeft }               pushed on every booking/cancel
export function initSockets(httpServer) {
  io = new Server(httpServer, {
    // Dev convenience so a page from any origin can connect. In production, list your real origin.
    cors: { origin: '*' },
  });

  io.on('connection', (socket) => {
    logger.info(`[socket] connected ${socket.id}`);

    socket.on('event:join', async (eventId, ack) => {
      const reply = typeof ack === 'function' ? ack : () => {};

      // Socket messages skip Express, so they skip our validate() middleware too:
      // we must validate here ourselves.
      if (!eventIdSchema.safeParse(eventId).success) {
        return reply({ ok: false, error: 'Invalid event id' });
      }

      try {
        const event = await prisma.event.findUnique({
          where: { id: eventId },
          select: { seatsLeft: true },
        });
        if (!event) return reply({ ok: false, error: 'Event not found' });

        socket.join(room(eventId));
        // Send the current count right away so the page doesn't start out blank.
        reply({ ok: true, seatsLeft: event.seatsLeft });
      } catch (err) {
        logger.error('[socket] event:join failed:', err.message);
        reply({ ok: false, error: 'Something went wrong' });
      }
    });

    socket.on('event:leave', (eventId) => {
      if (eventIdSchema.safeParse(eventId).success) socket.leave(room(eventId));
    });

    socket.on('disconnect', () => logger.info(`[socket] disconnected ${socket.id}`));
  });

  return io;
}

// Called by the booking controller AFTER the MySQL transaction has committed.
// Safe to call when sockets aren't running (tests, scripts): it just does nothing.
export function emitSeatsUpdate(eventId, seatsLeft) {
  io?.to(room(eventId)).emit('seats:update', { eventId, seatsLeft });
}

export async function closeSockets() {
  if (io) await io.close();
  io = null;
}
