import mongoose from 'mongoose';

// eventId and userId are the uuid strings from MySQL. MongoDB has NO foreign keys,
// so nothing here checks they exist: that is the job of reviews.controller.js.
const reviewSchema = new mongoose.Schema(
  {
    eventId: { type: String, required: true, index: true },
    userId: { type: String, required: true },
    rating: { type: Number, required: true, min: 1, max: 5 },
    comment: { type: String, trim: true, maxlength: 1000 },
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

// One review per user per event, enforced by the database itself.
reviewSchema.index({ eventId: 1, userId: 1 }, { unique: true });

export default mongoose.model('Review', reviewSchema);
