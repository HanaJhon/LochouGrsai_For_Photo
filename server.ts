import express from "express";
import path from "path";
import multer from "multer";
import axios from "axios";
import FormData from "form-data";
import { createServer as createViteServer } from "vite";
import fs from "fs";

const upload = multer({ storage: multer.memoryStorage() });

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json({ limit: '100mb' }));
  app.use(express.urlencoded({ extended: true, limit: '100mb' }));

  const upload = multer({ 
    storage: multer.memoryStorage(),
    limits: {
      fileSize: 20 * 1024 * 1024, // 20MB per file
      files: 10,
      fieldSize: 100 * 1024 * 1024 // 100MB for fields
    }
  });

  // Global request logger
  app.use((req, res, next) => {
    if (req.url.startsWith('/api/')) {
      console.log(`[Server] ${req.method} ${req.url} - Content-Length: ${req.headers['content-length']}`);
    }
    next();
  });

  // API Proxy Endpoint
  app.post("/api/generate", (req, res, next) => {
    upload.array('images', 9)(req, res, (err) => {
      if (err) {
        console.error('[Server] Multer error:', err);
        return res.status(400).json({ 
          error: "Multipart upload failed", 
          details: err.message,
          code: (err as any).code
        });
      }
      next();
    });
  }, async (req: any, res) => {
    try {
      const { 
        prompt, 
        model, 
        aspect_ratio, 
        resolution,
        custom_api_key,
        custom_api_url
      } = req.body;

      console.log(`\n[Server] >>> NEW GENERATION REQUEST <<<`);
      console.log(`[Server] Model: ${model}`);
      console.log(`[Server] Prompt length: ${prompt?.length || 0}`);
      console.log(`[Server] Target: ${custom_api_url || 'default'}`);
      
      const files = (req.files as any[]) || [];
      console.log(`[Server] Images attached: ${files.length}`);

      const isGptModel = model && (model.startsWith('gpt-image-2') || model.startsWith('gpt-video'));

      const apiPayload: any = {
        model: model,
        prompt: prompt,
        aspectRatio: aspect_ratio,
        imageSize: resolution, // Send it for all models to be safe, Banana specifically needs it
        replyType: 'json',
        images: [],
      };

      if (files.length > 0) {
        apiPayload.images = files.map(file => `data:${file.mimetype};base64,${file.buffer.toString('base64')}`);
        console.log(`[Server] Total buffered image size: ${files.reduce((acc, f) => acc + f.size, 0)} bytes`);
      }

      // Final target URL resolution
      let targetUrl = custom_api_url || process.env.EXTERNAL_API_URL || "https://grsaiapi.com/v1/api/generate";
      
      const apiKey = custom_api_key || process.env.EXTERNAL_API_KEY;

      console.log(`[Server] Proxying to: ${targetUrl}`);

      const response = await axios.post(targetUrl, apiPayload, {
        headers: { 
          'Content-Type': 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Banana/1.0',
          ...(apiKey ? { 'Authorization': apiKey.startsWith('Bearer ') ? apiKey : `Bearer ${apiKey}` } : {})
        },
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        validateStatus: () => true, 
      });

      console.log(`[Server] Remote Status: ${response.status}`);
      
      const contentType = String(response.headers['content-type'] || '');
      
      // If the remote server returns HTML, it's likely an error page from their infra
      if (contentType.includes('text/html') || (typeof response.data === 'string' && response.data.trim().startsWith('<!'))) {
        console.error(`[Server] Remote returned HTML! Preview: ${String(response.data).slice(0, 500)}`);
        return res.status(502).json({ 
          error: "Remote server returned HTML instead of JSON. This usually indicates an overloaded server or wrong endpoint.",
          status: response.status,
          peek: String(response.data).slice(0, 200)
        });
      }

      // Proxy back the data
      res.status(response.status).json(response.data);
    } catch (error: any) {
      console.error(`[Server] Proxy Exception:`, error.message);
      
      let statusCode = 500;
      let errorMsg = "Internal proxy exception";
      
      if (error.code === 'ECONNABORTED' || error.message.includes('timeout')) {
        statusCode = 504; // Gateway Timeout
        errorMsg = "Remote generation timed out or connection was aborted.";
      }

      res.status(statusCode).json({
        error: errorMsg,
        details: error.message,
        code: error.code
      });
    }
  });

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok", timestamp: new Date().toISOString() });
  });

  // Explicitly handle 404 for API routes
  app.all("/api/*", (req, res) => {
    res.status(404).json({ error: "API Route not found" });
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();
