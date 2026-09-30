import mongoose from 'mongoose';

// One document per delivery (an event sent to one endpoint). Updated after every attempt,
// so an admin can see "why did this fail?" without digging through server logs.
const webhookDeliverySchema = new mongoose.Schema(
  {
    deliveryId: { type: String, required: true, unique: true },
    endpointId: { type: String, required: true },
    event: { type: String, required: true },
    payload: { type: mongoose.Schema.Types.Mixed },
    status: { type: String, enum: ['SUCCESS', 'RETRYING', 'FAILED', 'SKIPPED'], required: true },
    attempts: { type: Number, default: 0 },
    lastStatusCode: Number,
    lastError: String,
  },
  {
    timestamps: true,
    toJSON: {
      transform: (doc, ret) => {
        ret.id = ret._id.toString();
        delete ret._id;
        delete ret.__v;
        return ret;
      },
    },
  },
);

webhookDeliverySchema.index({ endpointId: 1, createdAt: -1 });

export default mongoose.model('WebhookDelivery', webhookDeliverySchema);
