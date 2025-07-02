// models/News.js
const mongoose = require("mongoose");
const { Schema, model } = require("mongoose");

const newsSchema = new Schema(
  {
    title: { type: String, required: true },
    link: { type: String, required: true },
  },
  { timestamps: true } // adds createdAt / updatedAt
);
const subscriberSchema = new Schema(
  {
    email: { type: String, required: true, unique: true },
  },
  { timestamps: true }
);

module.exports = {
  News: model("News", newsSchema),
  Subscriber: model("Subscriber", subscriberSchema),
};
