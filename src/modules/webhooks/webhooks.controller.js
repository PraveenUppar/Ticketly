import { randomUUID } from 'node:crypto';
import prisma from '../../config/prisma.js';
import AppError from '../../utils/AppError.js';
import asyncHandler from '../../utils/asyncHandler.js';
import logger from '../../utils/logger.js';
import { addWebhookJob } from '../../jobs/queue.js';
import WebhookDelivery from './webhookDelivery.model.js';
import { assertSafeWebhookUrl, generateSecret } from './webhooks.security.js';
import { buildEnvelope } from './webhooks.service.js';

// Every read/list uses this, so the secret can never leak by accident.
const publicFields = {
  id: true,
  url: true,
  events: true,
  active: true,
  failureCount: true,
  createdAt: true,
};

async function findEndpointOr404(id) {
  const endpoint = await prisma.webhookEndpoint.findUnique({ where: { id }, select: publicFields });
  if (!endpoint) throw new AppError('Webhook not found', 404);
  return endpoint;
}

export const createWebhook = asyncHandler(async (req, res) => {
  const { url, events } = req.validated.body;

  await assertSafeWebhookUrl(url); // rejects private/internal targets (SSRF)

  const secret = generateSecret();
  const endpoint = await prisma.webhookEndpoint.create({
    data: { url, events, secret, createdById: req.user.id },
    select: publicFields,
  });

  // The ONLY time the secret is ever returned. The receiver needs it to verify signatures.
  res.status(201).json({ status: 'success', data: { webhook: { ...endpoint, secret } } });
});

export const listWebhooks = asyncHandler(async (req, res) => {
  const webhooks = await prisma.webhookEndpoint.findMany({
    select: publicFields,
    orderBy: { createdAt: 'desc' },
  });
  res.json({ status: 'success', data: { webhooks } });
});

export const updateWebhook = asyncHandler(async (req, res) => {
  const { params, body } = req.validated;
  await findEndpointOr404(params.id);

  const webhook = await prisma.webhookEndpoint.update({
    where: { id: params.id },
    // switching an endpoint back on also clears its failure streak
    data: { ...body, ...(body.active === true && { failureCount: 0 }) },
    select: publicFields,
  });
  res.json({ status: 'success', data: { webhook } });
});

export const deleteWebhook = asyncHandler(async (req, res) => {
  const { id } = req.validated.params;
  await findEndpointOr404(id);

  await prisma.webhookEndpoint.delete({ where: { id } });

  // Clean up the delivery history in the background. The endpoint is already gone, so the
  // response must not wait on MongoDB (or hang if MongoDB is slow or unreachable).
  WebhookDelivery.deleteMany({ endpointId: id }).catch((err) =>
    logger.warn(`[webhooks] could not clean delivery log of ${id}: ${err.message}`),
  );
  res.status(204).send();
});

export const listDeliveries = asyncHandler(async (req, res) => {
  const { params, query } = req.validated;
  await findEndpointOr404(params.id);

  const filter = { endpointId: params.id };
  const [deliveries, total] = await Promise.all([
    WebhookDelivery.find(filter)
      .sort({ createdAt: -1 })
      .skip((query.page - 1) * query.limit)
      .limit(query.limit),
    WebhookDelivery.countDocuments(filter),
  ]);

  res.json({
    status: 'success',
    data: { deliveries },
    meta: { page: query.page, limit: query.limit, total, totalPages: Math.ceil(total / query.limit) },
  });
});

// Sends a "ping" so an admin can check their receiver works before real events happen.
export const pingWebhook = asyncHandler(async (req, res) => {
  const endpoint = await findEndpointOr404(req.validated.params.id);
  if (!endpoint.active) throw new AppError('This webhook is disabled', 409);

  const deliveryId = randomUUID();
  const queued = await addWebhookJob({
    endpointId: endpoint.id,
    deliveryId,
    event: 'ping',
    payload: buildEnvelope(deliveryId, 'ping', { message: 'Hello from Event Booking API' }),
  });
  if (!queued) throw new AppError('Could not queue the ping right now, try again shortly', 503);

  // 202 Accepted: queued, not delivered yet. Check /deliveries for the result.
  res.status(202).json({ status: 'success', data: { deliveryId } });
});
