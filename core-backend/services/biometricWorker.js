// core-backend/services/biometricWorker.js
const mongoose = require("mongoose");
const crypto = require("crypto");

/**
 * MVP WORKER (Render-friendly)
 * - Polls Mongo for pending enrollments that have photoFileIds but no embedding
 * - Generates an embedding (stubbed) and marks user/enrollment as enrolled
 *
 * IMPORTANT:
 * - This is a STUB embedding generator (hash-based) so the pipeline works now.
 * - Swap generateEmbeddingFromImages() with a real face model later.
 */

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function bufferToFloat32Buffer(buf) {
  // buf -> deterministic Float32 vector (stub)
  // Make 128 floats from sha256 chunks
  const hash = crypto.createHash("sha256").update(buf).digest(); // 32 bytes
  const out = new Float32Array(128);
  for (let i = 0; i < out.length; i++) {
    const b = hash[i % hash.length];
    // map 0..255 => -1..1
    out[i] = (b / 255) * 2 - 1;
  }
  return Buffer.from(out.buffer);
}

async function downloadGridFsFileBytes({ bucket, fileId }) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = bucket.openDownloadStream(fileId);
    stream.on("data", (d) => chunks.push(d));
    stream.on("error", reject);
    stream.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

/**
 * STUB embedding generator:
 * - concatenates image bytes
 * - hashes them deterministically into Float32Array(128) -> Buffer
 * Replace this with real embedding model output later.
 */
async function generateEmbeddingFromImages({ bucket, photoFileIds }) {
  const take = (photoFileIds || []).slice(0, 4); // you capture ~3-4
  const bytes = [];
  for (const fid of take) {
    try {
      const b = await downloadGridFsFileBytes({ bucket, fileId: fid });
      bytes.push(b);
    } catch {
      // ignore missing file
    }
  }
  if (!bytes.length) return null;
  return bufferToFloat32Buffer(Buffer.concat(bytes));
}

let started = false;

function startBiometricWorker({
  pollMs = 8000,
  maxPerTick = 2,
  logPrefix = "[biometricWorker]",
} = {}) {
  if (started) return;
  started = true;

  const inflight = new Set();

  async function tick() {
    try {
      const db = mongoose.connection?.db;
      if (!db) return;

      // Lazy require (avoids circular init problems)
      const BiometricEnrollment = require("../models/BiometricEnrollment");
      const User = require("../models/User");

      const { GridFSBucket } = require("mongodb");
      const bucket = new GridFSBucket(db, { bucketName: "mobileOffline" });

      // Find enrollments that are pending AND have photos AND no embedding yet
      // embedding is select:false in schema, so we query by existence via raw Mongo:
      const q = {
        status: "pending",
        photoFileIds: { $exists: true, $not: { $size: 0 } },
      };

      // Pull a few newest first
      const candidates = await BiometricEnrollment.find(q)
        .sort({ updatedAt: -1 })
        .limit(maxPerTick * 3)
        .select({ _id: 1, orgId: 1, userId: 1, photoFileIds: 1 })
        .lean();

      let processed = 0;

      for (const c of candidates) {
        if (processed >= maxPerTick) break;

        const key = String(c._id);
        if (inflight.has(key)) continue;

        inflight.add(key);
        processed += 1;

        (async () => {
          try {
            const embedBuf = await generateEmbeddingFromImages({
              bucket,
              photoFileIds: c.photoFileIds || [],
            });

            if (!embedBuf) {
              console.warn(logPrefix, "No photos found for enrollment", key);
              return;
            }

            // Write embedding + mark enrolled
            await BiometricEnrollment.updateOne(
              { _id: c._id },
              {
                $set: {
                  status: "enrolled",
                  templateVersion: "face-emb-v0-stub", // change later
                  embedding: embedBuf,
                  updatedAt: new Date(),
                },
              },
            );

            // Update user biometric summary
            await User.updateOne(
              { _id: c.userId, orgId: c.orgId },
              {
                $set: {
                  "biometric.status": "enrolled",
                  "biometric.templateVersion": "face-emb-v0-stub",
                  "biometric.lastUpdatedAt": new Date(),
                },
              },
            );

            console.log(
              logPrefix,
              "Enrolled user",
              String(c.userId),
              "enrollment",
              key,
            );
          } catch (e) {
            console.error(logPrefix, "Failed processing enrollment", key, e);
          } finally {
            inflight.delete(key);
          }
        })();
      }
    } catch (e) {
      console.error(logPrefix, "tick error", e);
    }
  }

  // main loop
  (async () => {
    console.log(logPrefix, "started", { pollMs, maxPerTick });
    while (true) {
      await tick();
      await sleep(pollMs);
    }
  })();
}

module.exports = { startBiometricWorker };
