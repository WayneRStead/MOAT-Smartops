// core-backend/lib/gridfs.js
const mongoose = require("mongoose");

let bucket = null;

function getBucket() {
  if (bucket) return bucket;
  const db = mongoose.connection?.db;
  if (!db) throw new Error("Mongo not connected yet (mongoose.connection.db missing)");
  bucket = new mongoose.mongo.GridFSBucket(db, { bucketName: "taskFiles" });
  return bucket;
}

module.exports = { getBucket };
