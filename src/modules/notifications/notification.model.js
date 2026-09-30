import mongoose from 'mongoose';

// A log of what we told each user. Flexible `meta` (any shape) is exactly
// the kind of data MongoDB is better at than rigid SQL tables.
const notificationSchema = new mongoose.Schema(
  {
    userId: { type: String, required: true, index: true },
    type: {
      type: String,
      required: true,
      enum: ['BOOKING_CONFIRMED', 'BOOKING_CANCELLED', 'BOOKING_EXPIRED', 'EVENT_FINISHED'],
    },
    message: { type: String, required: true },
    meta: { type: mongoose.Schema.Types.Mixed },
    read: { type: Boolean, default: false },
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

export default mongoose.model('Notification', notificationSchema);
