// FILE: server.js  (Cloud Run service — minimal additive changes, menu stays unchanged)
import express from "express";
import cors from "cors";
import { ImageAnnotatorClient } from "@google-cloud/vision";
import { Storage } from "@google-cloud/storage";

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

// --- FACE DETECTION SETUP ---
const visionClient = new ImageAnnotatorClient();

app.post("/detectFaces", async (req, res) => {
  try {
    if (!req.body || !req.body.imageBase64) {
      return res.status(400).json({ error: "No imageBase64 provided" });
    }

    const imageBase64 = req.body.imageBase64;

    const [result] = await visionClient.faceDetection({
      image: { content: imageBase64 },
    });

    const annotations = result.faceAnnotations || [];

    const faces = annotations
      .map((face) => {
        const verts = face.boundingPoly?.vertices || [];
        const xs = [];
        const ys = [];
        verts.forEach((v) => {
          if (typeof v.x === "number") xs.push(v.x);
          if (typeof v.y === "number") ys.push(v.y);
        });
        if (!xs.length || !ys.length) return null;
        const minX = Math.min(...xs);
        const maxX = Math.max(...xs);
        const minY = Math.min(...ys);
        const maxY = Math.max(...ys);
        return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
      })
      .filter(Boolean)
      .sort((a, b) => a.x - b.x);

    res.json({ faces });
  } catch (err) {
    console.error("detectFaces error:", err);
    res.status(500).json({ error: "Vision call failed" });
  }
});

// --- HEALTHCHECK / ROOT ---
app.get("/", (req, res) => {
  res.send("Face server up ✅");
});

// --- STORAGE SETUP ---
const storage = new Storage();
const BUCKET_NAME = "xcape-menu-bucket";

const MENU_OBJECT = "menu_current.pdf";

// ✅ CHANGE: boardpass filename
const BOARDPASS_OBJECT = "boardpass_current.pdf";

// Keep old boarding name allowed too (optional, won’t hurt)
const LEGACY_BOARDING_OBJECT = "boarding_current.pdf";

const ALLOWED_OBJECTS = new Set([MENU_OBJECT, BOARDPASS_OBJECT, LEGACY_BOARDING_OBJECT]);

// Direct upload endpoint (backwards compatible)
// - Menu kiosk sends { pdfBase64 } -> menu_current.pdf
// - BoardPass kiosk sends { pdfBase64, objectName:"boardpass_current.pdf" }
app.post("/uploadPdfDirect", async (req, res) => {
  try {
    const pdfBase64 = req.body?.pdfBase64;
    if (!pdfBase64) {
      return res.status(400).json({ error: "No pdfBase64 provided" });
    }

    const objectName = (req.body?.objectName || MENU_OBJECT).trim();

    if (!ALLOWED_OBJECTS.has(objectName)) {
      return res.status(400).json({
        error: "Invalid objectName",
        allowed: Array.from(ALLOWED_OBJECTS),
      });
    }

    const pdfBuffer = Buffer.from(pdfBase64, "base64");

    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(objectName);

    await file.save(pdfBuffer, {
      contentType: "application/pdf",
      resumable: false,
    });

    console.log("uploadPdfDirect: wrote", objectName, "(", pdfBuffer.length, "bytes )");
    res.status(200).json({ ok: true, objectName });
  } catch (err) {
    console.error("uploadPdfDirect error:", err);
    res.status(500).json({ error: "upload failed" });
  }
});

// SERVE LATEST MENU
app.get("/menu_current", async (req, res) => {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(MENU_OBJECT);

    const [bytes] = await file.download();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(bytes);
  } catch (err) {
    console.error("menu_current error:", err);
    res.status(500).send("menu not available");
  }
});

// ✅ NEW: SERVE LATEST BOARDPASS
app.get("/boardpass_current", async (req, res) => {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(BOARDPASS_OBJECT);

    const [bytes] = await file.download();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(bytes);
  } catch (err) {
    console.error("boardpass_current error:", err);
    res.status(500).send("boardpass not available");
  }
});

// Optional: keep legacy endpoint working, but point it to the NEW object
app.get("/boarding_current", async (req, res) => {
  try {
    const bucket = storage.bucket(BUCKET_NAME);
    const file = bucket.file(BOARDPASS_OBJECT); // serve the new boardpass file

    const [bytes] = await file.download();

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.status(200).send(bytes);
  } catch (err) {
    console.error("boarding_current error:", err);
    res.status(500).send("boarding pass not available");
  }
});

// START SERVER
const port = process.env.PORT || 8080;
app.listen(port, () => {
  console.log("listening on port", port);
});
